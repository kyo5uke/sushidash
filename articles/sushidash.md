---
title: "Unity の splash を 1 バイト書き換えて、寿司打の起動を少し速くした"
emoji: "🍣"
type: "tech"
topics: ["unity", "webgl", "chrome拡張", "javascript", "個人開発"]
published: false
---

## 作ったもの

sushidash という、寿司打の読み込みを少し速くする Chrome 拡張を作りました。

ブラウザ側で読み込まれる Unity のデータをその場で少し書き換えて、起動時の splash（「Made with Unity」のロゴ）を表示しないようにしています。
あわせて、一度読み込んだ `.unityweb` ファイルを Cache Storage に保存し、2回目以降はネットワークへ取りに行かないようにしました。
結果として、体感でもかなり起動が軽くなります。

リポジトリはこちらです。

https://github.com/kyo5uke/sushidash

## できること

主にやっていることは次の4つです。

* Unity の splash をブラウザ側で無効化する
* `.unityweb` 3ファイルを Cache Storage に保存する
* `document_start` で必要なファイルを先に取りに行く
* canvas を 500ms で fade-in し、広告の表示タイミングを少し後ろにずらす

拡張を入れるには、`chrome://extensions/` でデベロッパーモードを有効にして、`src/` を「パッケージ化されていない拡張機能」として読み込みます。

その状態で寿司打を開くと、Console にはだいたい次のようなログが出ます。

```text
[sushidash] patcher initialized (XHR override active)
[sushidash] splash byte patched at block 0 offset 4200
[sushidash] web.data patched in 12.4ms: 7411331 → 7490398 B
[sushidash] cache stored: Web.data.unityweb (7,490,398 B)
[sushidash] canvas first draw via drawArrays
```

## なぜ作ったか

寿司打を開くと、ゲームが始まる前に Unity の splash が2秒くらい表示されます。
タイピング練習で何度も開き直すと、この数秒がわりと気になります。
これを消したかった、というのが出発点です。

Unity の splash を消すだけなら、本来は Unity 側の設定でやるものです。
ただ、こちらで触れるのはビルド済みのファイルだけなので、ブラウザに届いたデータをその場で書き換えることにしました。

最初は、書き換え済みのファイルを拡張に入れることも考えました。
でも、それだとゲーム側のファイルを再配布する形になります。
それはやりたくなかったので、拡張には寿司打のファイルを一切入れていません。

実際には、毎回 sushida.net から元のファイルを受け取り、ブラウザの中で必要な部分だけを書き換えています。
サイトから配信されるファイル自体は元のままです。

## 仕組み

### Web.data.unityweb の中身

splash の設定は `Web.data.unityweb` の中に入っています。

ざっくり見ると、次のような構造です。

```text
Web.data.unityweb        ... UnityWebData1.0 コンテナ
  └ data.unity3d         ... UnityFS bundle
      ├ block_info       ... 各ブロックの u_size / c_size / flags
      ├ block 0          ... PlayerSettings が入っている
      └ block 1..N       ... 今回は触らない
```

目的の `m_ShowUnitySplashScreen` は PlayerSettings の中にあります。
そのため、まず `Web.data.unityweb` から `data.unity3d` を取り出し、さらに UnityFS の block 0 を展開する必要があります。

### LZ4 を展開する

block 0 は LZ4 で圧縮されています。

LZ4 のブロックフォーマットは比較的シンプルで、token 1バイトから literal の長さと match の長さを読んでいく形です。
今回は展開できれば十分だったので、デコーダだけを書きました。
エンコーダは書いていません。

この「エンコーダを書いていない」ことが、後の書き戻し方に関係してきます。

### splash byte を探す

block 0 を展開したら、splash の bool を探します。

ここで固定 offset にしてしまうと、サイト側でファイルが更新されたときに別の場所を書き換える可能性があります。
それはかなり怖いので、周辺のバイト列を見て一意に見つけるようにしました。

```text
00 00 00 00 00 00 00 00  00 00 80 3F  [01]  00 00 00 00  00 00 80 3F  00 00 00 00
└────── 12バイト ─────────┘            ↑    └────── 11バイト ──────────┘
                                  ここを 0x01 から 0x00 にする
```

`00 00 80 3F` は float の `1.0f` です。
この値が前後にあり、その間にある `0x01` が splash のフラグでした。

この並びは block 0 の中で1か所だけだったので、見つかった場合だけ `0x00` に書き換えます。
見つからなかった場合は、何もせず元のデータを返します。

### 圧縮し直さずに書き戻す

ふつうに考えると、書き換えた block 0 をもう一度 LZ4 で圧縮して戻すことになります。
ただ、今回は LZ4 エンコーダを書いていません。

そこで、block 0 だけを無圧縮ブロックとして書き戻すことにしました。

やっていることは単純で、block_info の圧縮フラグを外し、圧縮後サイズを展開後サイズと同じ値に直します。
他のブロックは元の圧縮データをそのままコピーします。

この方法だと、JavaScript 側では LZ4 デコーダだけを書けば済みます。

代わりに、Unity が読むデータは約 80KB 大きくなります。
ただし、sushida.net からダウンロードする量は元のままです。
圧縮された元ファイルを受け取ってから、ブラウザ内で展開と書き換えをしているためです。

最後に、UnityFS と UnityWebData 側のサイズや offset を計算し直して詰め直します。

### 2回目以降は Cache Storage から返す

splash を消すだけだと、毎回 `.unityweb` ファイルをダウンロードすること自体は変わりません。
そこで、取得したファイルを Cache Storage に保存するようにしました。

`Web.data.unityweb` は patch 済みの状態で保存します。
`Web.wasm.code.unityweb` と `Web.wasm.framework.unityweb` は、そのまま保存します。

2回目以降は Cache Storage から返すので、対象ファイルについてはネットワークへ取りに行きません。

HTTP キャッシュだけに任せると、容量や期限の都合で消えることがあります。
そのため、可能なら `navigator.storage.persist()` で永続化もお願いしています。

### XHR と fetch を差し替える

寿司打の Unity 2017 ローダーは、`.unityweb` ファイルを `XMLHttpRequest` で取りに行きます。

そこで、content script を `world: "MAIN"`、`run_at: "document_start"` で動かし、ページ側の JavaScript が動く前に `XMLHttpRequest` と `fetch` を差し替えます。

```js:src/patcher.js
class PatchedXHR extends RealXHR {
  send(...args) {
    if (!this.__sushidaIntercept) return super.send(...args);

    cacheGet(this.__sushidaUrl).then(buf => {
      if (buf) {
        fakeXHRLoad(this, buf);
      } else {
        super.send(...args);
      }
    });
  }
}
```

cache hit のときは、ネットワークへ行かずに response を差し替えて、自分で `load` を発火させます。
cache miss のときは通常どおり取得し、取得後に必要なら patch します。

## ハマったところ

### LZ4 のオーバーラップコピー

LZ4 の match コピーでは、コピー元とコピー先が重なることがあります。
特に `offset < length` の場合です。

ここを `copyWithin` のようにまとめて処理すると壊れます。
1バイトずつ前からコピーする必要があります。

```js:src/patcher.js
const mp = dp - offset;

for (let i = 0; i < matchLen; i++) {
  dst[dp++] = dst[mp + i];
}
```

最初はここを雑に処理していて、展開後サイズが合わずに bundle が壊れていました。
`block 0 decompressed size mismatch` が出て、ようやく原因に気づきました。

### response を Unity より先に差し替える

cache miss の場合、本物の response を受け取ってから patch し、その結果を Unity に読ませる必要があります。

ここで問題になるのが、`load` イベントの順番です。
Unity も `load` を待って response を読みます。
こちらの listener が後に登録されると、Unity が元の response を先に読んでしまいます。

そのため、`open` や `send` のタイミングではなく、XHR の constructor の時点で `load` listener を登録するようにしました。
`addEventListener` は登録順に呼ばれるので、Unity より先に登録できれば、response を差し替えてから渡せます。

### 失敗したら元に戻す

この拡張は、かなりピンポイントにバイト列を書き換えます。
そのため、サイト側のファイルが更新されると、想定していたパターンが変わる可能性があります。

そのときに変な場所を書き換えるのが一番危ないので、少しでも条件が合わなければ元のバイト列をそのまま返すようにしています。

magic が違う、サイズが合わない、目的のパターンが見つからない。
そういう場合は throw して、最終的に元データへフォールバックします。

失敗しても、ただ通常の寿司打として読み込まれるだけです。

## 制限と今後

現状の制限はこのあたりです。

* LZ4 エンコーダを書いていないので、patch 後の `Web.data.unityweb` が約 80KB 大きくなる
* UnityFS のブロック前パディング、`flags & 0x200` には未対応
* prefetch する URL のバージョン、`v1_3` は現状ベタ書き
* 学習目的の非公式拡張なので、利用時は sushida.net 側の規約を確認する必要がある

寿司打は Unity 2017 なので、今回の範囲では動いています。
ただ、新しい Unity の AssetBundle だと構造が違う可能性があります。
その場合は、サイズ不一致などでフェイルセーフに落ちるはずです。

広告についてはブロックしているわけではなく、表示タイミングを少し後ろにずらしているだけです。
最終的には表示されます。

今後やるなら、LZ4 エンコーダを書いて patch 後のサイズ増加をなくすことと、prefetch 対象のバージョン検出をもう少しまともにすることです。

splash byte の位置や周辺パターンが変わっていた場合は、サイト側の版が上がっている可能性があります。
気づいたら issue をもらえると助かります。

## 参考

* [LZ4 Block Format](https://github.com/lz4/lz4/blob/dev/doc/lz4_Block_format.md)
* UnityFS / AssetBundle の構造は、UnityPy や AssetStudio のコードを読むと早いです
