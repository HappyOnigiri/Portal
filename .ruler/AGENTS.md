# AGENTS.md

AI エージェントがこのリポジトリで作業する際の非自明なルール集。設定ファイルから読み取れる情報（インデント、フレームワーク等）は省略している。

## 必須: コード変更後

- **`make ci` を実行**し、エラーをすべて解消してからコミットすること
- `make ci` 後にファイル差分があると CI が落ちる（dirty check）。フォーマットは **事前に `npm run format`** で適用しておくこと

## フォーマッター

- `.astro` ファイル → **Prettier**
- それ以外 → **Biome**
- 混同すると CI が壊れる

## TypeScript

- **`@ts-ignore` 禁止** — カスタムスクリプトで検出される。代わりに `@ts-expect-error` を使うこと
- **`any` 禁止** — Biome の `noExplicitAny: error` で検出される

## 生成ファイル

- `src/data/author-status.json` は自動生成ファイル。**手動編集しない**

## コミット・コメント規約

- コメント、テスト記述、コミットメッセージは**日本語**
- **Conventional Commits** に従うこと（Release Please が使用している）
