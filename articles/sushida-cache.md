---
title: "Unityのsplashを1バイト書き換えたら、寿司打が2秒速く起動した"
emoji: "🍣"
type: "tech"
topics: ["unity", "webgl", "chrome拡張", "javascript", "個人開発"]
published: false
---

sushida-cache という、寿司打の読み込みを速くする Chrome 拡張を作りました。

寿司打を開くと、ゲームが始まる前に Unity の Neutral ロゴ（splash）が2秒くらい出る。タイピング練習で何回も開きなおすので、毎回これを待つのが地味につらかった。なので消しました。

ついでに、一度読んだファイルをブラウザに貯めて2回目以降はネットワークに行かないようにしたら、体感でだいぶ速くなった。

リポジトリはここ → https://github.com/kyo5uke/sushida-cache

## 作ったもの

- Unity の splash（Neutral ロゴ）を OFF。起動が ~2秒短縮
- `.unityweb` 3ファイルを Cache Storage に保存して、2回目以降はネットワークゼロ
- `document_start` で3ファイルを prefetch
- canvas を 500ms で fade-in、広告は描画後にずらす

`chrome://extensions/` でデベロッパーモードを ON にして、`src/` を「パッケージ化されていない拡張機能」として読み込むだけ。あとは寿司打を開くと、Console にこういうログが出る。

```text
[sushida-cache] patcher initialized (XHR override active)
[sushida-cache] splash byte patched at block 0 offset 4200
[sushida-cache] web.data patched in 12.4ms: 7411331 → 7490398 B
[sushida-cache] cache stored: Web.data.unityweb (7,490,398 B)
[sushida-cache] canvas first draw via drawArrays
```

## なぜ作ったか

splash を消すなら本来は Unity 側の設定でやる話だけど、こっちが触れるのはビルド済みのファイルだけ。だからファイルを直接書き換えることにした。

ただ、最適化したファイルを拡張に同梱して配ると、それは著作物の再配布になる。やりたくない。なので **拡張にはファイルを一切バンドルせず、毎回 sushida.net から取ってきたデータをブラウザの中で書き換える** 方式にした。サイトから落ちてくるのは元のファイルのまま。

## 仕組み

### Web.data.unityweb の中身

splash のフラグは `Web.data.unityweb` の中に埋まっている。これがけっこう入れ子になっていて、

```
Web.data.unityweb        … UnityWebData1.0 コンテナ
  └ data.unity3d         … UnityFS bundle
      ├ block_info       … 各ブロックの u_size / c_size / flags（LZ4 圧縮）
      └ block 0          … PlayerSettings が入ってる（LZ4HC 圧縮）
      └ block 1..N       … 触らない
```

目的の `m_ShowUnitySplashScreen` は PlayerSettings の中なので、block 0 を展開しないと辿り着けない。

### LZ4 を展開する

block 0 は LZ4 で圧縮されている。LZ4 のブロックフォーマットは仕様が短くて、token 1バイトで literal の長さと match の長さが決まるだけ。なので自分で書いた。書いたのはデコーダだけで、エンコーダは書いてない（後で効いてくる）。

### splash byte を1バイト見つける

展開した block 0 から、書き換える bool を探す。

ここでアドレス決め打ち（「offset 4200」とか）にすると、サイトがファイルを更新した瞬間に全然違う場所を書き換えて事故る。なので **周辺24バイトのパターンで一意に当てる** ようにした。

```
00 00 00 00 00 00 00 00  00 00 80 3F  [01]  00 00 00 00  00 00 80 3F  00 00 00 00
└────── 12バイト ─────────┘            ↑    └────── 11バイト ──────────┘
                                  ここを 0x01 → 0x00
```

`0x803F` は float の `1.0f`。これが前後に2つあって、その間に挟まった `0x01` が splash のフラグだった。この並びは block 0 の中で1か所しか出てこないので、見つけたらそこを `0x00` にする。

### 圧縮し直さずに書き戻す

書き換えた block 0 をまた LZ4 で圧縮し直す…のがふつうだけど、エンコーダを書いてないのでできない。

なので **無圧縮ブロックとして書き戻す**。block_info の flags の圧縮ビットを 0 にして、サイズを「圧縮後＝展開後」に直すだけ。他のブロックは元の圧縮バイトをそのままコピー。これだと JS で書くのが LZ4 のデコーダだけで済む。

代償として、Unity が読むデータが ~80KB 太る。でも sushida.net から落ちてくる量は変わらない（圧縮版を落として、展開と書き換えはブラウザの中でやるから）。

あとは UnityFS と UnityWebData それぞれのヘッダで、サイズと後続のオフセットを計算し直して詰め直せば完成。

### 2回目以降はネットワークゼロ

ここまでで splash は消えるけど、毎回7MB落としてるのは変わらない。なので落としたものを Cache Storage に入れて、2回目からはそこから配る。data は patch 済みの状態で、code と framework は生のまま保存する。

HTTP キャッシュは容量とか時間で勝手に消えるので、`navigator.storage.persist()` で「消さないで」とお願いしておく。

### XHR と fetch を乗っ取る

寿司打（Unity 2017）のローダーは `XMLHttpRequest` で `.unityweb` を取りにいく。manifest を `world: "MAIN"` と `run_at: "document_start"` にして、**ページ本体の JS が動く前に** `XMLHttpRequest` と `fetch` を差し替えておく。

```js
class PatchedXHR extends RealXHR {
  send(...args) {
    if (!this.__sushidaIntercept) return super.send(...args);
    cacheGet(this.__sushidaUrl).then(buf => {
      if (buf) {
        // cache hit: ネットワークに行かず response を差し替えて load を自分で発火
        fakeXHRLoad(this, buf);
      } else {
        super.send(...args); // miss: 本物で取りにいく
      }
    });
  }
}
```

miss のときは本物で取ってきたあと、patch して response を差し替える。

## ハマったところ

### LZ4 のオーバーラップコピー

match のコピーで `offset < length` のとき、コピー元と先が重なる。`copyWithin` みたいに一気にやると壊れる。1バイトずつ前から写さないとダメ。

```js
const mp = dp - offset;
for (let i = 0; i < matchLen; i++) {
  dst[dp++] = dst[mp + i]; // 1バイトずつ。重なってても正しく伸びる
}
```

最初ここを雑にやってて、展開後のサイズが合わず bundle が毎回壊れてた。`block 0 decompressed size mismatch` で気づいた。

### response を Unity より先に差し替える

cache miss のとき、`load` が発火したタイミングで response を patch 済みのものに差し替えたい。でも Unity も `load` を待ってる。**こっちのリスナーを先に登録しておかないと、Unity が元の response を先に読んでしまう。**

なので open でも send でもなく、constructor の時点で `addEventListener('load', ...)` を登録する。`addEventListener` は登録順に呼ばれるので、Unity より早く登録すれば勝てる。

### 失敗したら何もしない

ピンポイントで書き換える以上、サイトがファイルを更新したら確実にズレる。そのとき変な場所を書き換えるのが一番こわい。

なので「パターンが見つからなかったら元のバイト列をそのまま返す」を徹底した。magic が違っても、サイズが合わなくても、とにかく throw して元に戻す。失敗しても、ただの寿司打に戻るだけ。

## 制限と今後

- LZ4 エンコーダを書いてないので 80KB 太る。気が向いたら書く。
- UnityFS のブロック前パディング（`flags & 0x200`）は未対応。寿司打は Unity 2017 なので出ないけど、新しい Unity だと展開サイズが合わずフェイルセーフで止まるはず。
- prefetch の URL のバージョン（`v1_3`）はベタ書き。サイトが上げたら 404 になって、Console に warn を出すようにしてある。
- 学習目的の非公式拡張です。sushida.net の規約は各自で確認してください。広告は1.5秒うしろにずらしてるけど、最終的にはちゃんと出ます。

splash byte の位置やパターンが変わってたら、たぶんサイト側の版が上がってる。気づいたら issue をもらえると助かります。

## 参考

- [LZ4 Block Format](https://github.com/lz4/lz4/blob/dev/doc/lz4_Block_format.md)
- UnityFS / AssetBundle の構造は、UnityPy や AssetStudio のコードを読むと早い
