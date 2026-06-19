# sushida-cache

[English](README.en.md) | 日本語

寿司打 (Unity WebGL) の読み込みを高速化する Chrome 拡張。

[![CI](https://github.com/kyo5uke/sushida-cache/actions/workflows/ci.yml/badge.svg)](https://github.com/kyo5uke/sushida-cache/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

```text
[sushida-cache] patcher initialized (XHR override active)
[sushida-cache] intercepting XHR: https://sushida.net/files/v1_3/Web.data.unityweb
[sushida-cache] splash byte patched at block 0 offset 4200
[sushida-cache] web.data patched in 12.4ms: 7411331 → 7490398 B
[sushida-cache] cache stored: Web.data.unityweb (7,490,398 B)
[sushida-cache] canvas first draw via drawArrays
```

寿司打を開くたび Unity の Neutral ロゴ (splash) を 2 秒眺めるのは退屈。sushida-cache は
ファイルを bundle せず、ブラウザ内で `Web.data.unityweb` を動的にパッチして splash を切り、
3 つの `.unityweb` を Cache Storage に貯めて 2 回目以降をネットワークゼロにします。

> 個人の学習用に作った非公式拡張です。sushida.net の運営とは無関係。
> バイナリをどう書き換えているか（UnityWebData / UnityFS / LZ4 / splash byte）は [Zenn 記事](articles/sushida-cache.md) に詳しく書きました。

## できること

- Unity splash (Neutral ロゴ) を OFF — 起動が ~2 秒短縮
- `.unityweb` 3 ファイルを Cache Storage に保存 — 2 回目以降はネットワークゼロ
- `document_start` で 3 ファイルを prefetch — 初回も並行ダウンロードで前倒し
- canvas を 500ms かけて fade-in
- 広告 (AdSense) を canvas 初回描画 +1.5 秒まで遅延（最終的には必ず表示）

## インストール

[Releases](https://github.com/kyo5uke/sushida-cache/releases) から最新の `sushida-cache-*.zip` を落として展開し、

1. `chrome://extensions/` を開く
2. 右上の「デベロッパーモード」を ON
3. 「パッケージ化されていない拡張機能を読み込む」→ 展開したフォルダを選択

> Chrome は zip や URL を直接は読み込めません（解凍したフォルダを選ぶ方式のみ）。起動のたびに出る「デベロッパーモードの拡張機能」警告と、自動更新が無いのはこの方式の制約です。

ソースから入れる場合（開発者向け）:

```sh
git clone https://github.com/kyo5uke/sushida-cache
```

で clone して、手順 3 で `src/` フォルダを選択。

拡張にゲーム本体 (`.unityweb`) は同梱しません。パッチは毎回 sushida.net から取得したライブのデータに対して、ブラウザ内で適用します。

## 使い方

[sushida.net/play.html](https://sushida.net/play.html) を開くだけ。Neutral ロゴが出ずに
ゲーム画面が直接フェードインすれば成功です。DevTools の Console に `[sushida-cache]` の
ログが出ます。

| ログ | 意味 |
| --- | --- |
| `splash byte patched at block 0 offset N` | splash パッチ成功 |
| `web.data patched in Xms: A → B` | パッチ実行時間と前後サイズ |
| `cache stored: ...` | Cache Storage に保存 |
| `cache hit (XHR/fetch): ...` | 2 回目以降、キャッシュから供給 |
| `prefetched: ...` | prefetch 完了 |
| `canvas first draw via ...` | ゲーム描画開始 |

動作は `src/enhance.js` 冒頭の `CONFIG`（fade 時間・広告遅延など）で調整できます。

## 仕組み（ざっくり）

ファイルは拡張に同梱せず、ブラウザ内で動的に書き換えます。

1. `document_start` で `XMLHttpRequest` / `fetch` を乗っ取る
2. `Web.data.unityweb`（UnityWebData → UnityFS → LZ4 ブロック）を展開し、splash フラグの 1 byte を `0x01 → 0x00`
3. LZ4 エンコーダは持たないので、書き換えたブロックは無圧縮で書き戻す（その分 ~80KB 増）
4. patch 済みデータを Cache Storage に保存し、2 回目以降はそこから供給

バイナリのパース手順やハマりどころは [Zenn 記事](articles/sushida-cache.md) に。

## 注意事項

- 非公式拡張です。sushida.net の利用規約は各自で確認してください。
- サイト側がファイルのバージョン (`v1_3`) を更新すると、splash パッチは no-op になり元の挙動に戻ります（フェイルセーフ）。prefetch は 404 になり Console に warn が出るので、`patcher.js` の `PREFETCH_VERSION` を更新してください。
- LZ4 エンコーダは実装していないため先頭ブロックを無圧縮で書き戻します。Unity が読むデータが ~80KB 増えます（sushida.net からの転送量は不変）。
- 広告は ~1.5 秒遅れて表示されます。

## ライセンス

[MIT](LICENSE)
