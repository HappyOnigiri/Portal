# Portal

HappyOnigiri のプロフィールサイト。<br />
開発したプロダクトを一覧表示します。<br />
リポジトリの開発メトリクス（コミット数、PR、CI 実行回数、言語比率など）を自動集計し、ダッシュボードとして表示します。

**Tech stack:** Astro 6 / React 19 / TailwindCSS 4 / TypeScript

## セットアップ

```bash
# Node.js >=22.12.0
pnpm install
```

## 開発コマンド

| コマンド | 説明 |
|---|---|
| `pnpm run dev` | 開発サーバー起動 (`localhost:4321`) |
| `pnpm run build` | プロダクションビルド → `dist/` |
| `pnpm run preview` | ビルド成果物のプレビュー |
| `pnpm run lint` | Biome による静的解析 |
| `pnpm run check` | CI 相当の厳格チェック |
| `pnpm run format` | Biome + Prettier によるフォーマット |
| `pnpm run typecheck` | TypeScript 型チェック |
| `pnpm run test` | Vitest によるテスト実行 |
| `pnpm run test:coverage` | カバレッジ付きテスト |
| `pnpm run collect-metrics` | GitHub メトリクス収集 |
| `make ci` | lint + typecheck + test + build を一括実行 |

## SEO と検索向け運用

本番 URL は `astro.config.mjs` の `site`（`https://onigiri-portal.vercel.app`）と [src/constants/site.ts](src/constants/site.ts) の `SITE_ORIGIN` で管理しています。**ドメインを変える場合は両方を同期**してください。

- **メタ・OGP（画像タグ除く）・Twitter Card・canonical** — `src/layouts/BaseLayout.astro`
- **構造化データ（JSON-LD）** — 各ページと `src/utils/structured-data.ts`
- **サイトマップ** — `@astrojs/sitemap` によりビルド時に `dist/sitemap-index.xml` が生成される
- **robots.txt** — `public/robots.txt`（`Sitemap:` は本番オリジンに合わせて更新）

### Google Search Console（推奨）

1. [Search Console](https://search.google.com/search-console) でプロパティを追加（URL プレフィックス `https://onigiri-portal.vercel.app/` またはドメイン資源）。
2. 所有権確認（HTML ファイル / DNS / Google Analytics 等、Vercel の案内に従う）。
3. **サイトマップ**に `https://onigiri-portal.vercel.app/sitemap-index.xml` を送信。
4. 定期的に **ページのインデックス登録**・**検索パフォーマンス**・**体験**（コアウェブバイタル等）を確認。

### その他の確認

- [Bing Webmaster Tools](https://www.bing.com/webmasters) に同様にサイトを登録し、サイトマップを送信するとよい。
- リリース後は [リッチリザルトテスト](https://search.google.com/test/rich-results) で JSON-LD を spot check する。
- **ゲーム等は別ドメイン**でホストしている。ポータル側の canonical は常に `onigiri-portal.vercel.app` 上の URL とし、ゲーム本体の評価は別プロパティ（別ドメイン）で見る。

### メトリクス収集

`.portal.yaml` に定義されたリポジトリごとに以下を集計し、`src/data/` に JSON として保存します。

- **追加・削除行数** — `git log --numstat` からソースコード拡張子のみを対象にカウント（`.gitattributes` の `linguist-generated` / `linguist-vendored` は除外）
- **コミット数** — `git rev-list --count` で算出
- **マージ済み PR 数 / CI 実行回数** — `gh` CLI で GitHub API から取得
- **言語比率** — 拡張子ごとの追加行数を言語グループに集約し、上位 10 言語を百分率で算出
- **キャッシュ** — デフォルトブランチの HEAD コミットハッシュと author 設定の HMAC をキーとし、変更がなければ再集計をスキップ

GitHub Actions により毎日 JST 2:00 に自動集計され、変更があれば `src/data/author-status.json` が自動コミットされます。`workflow_dispatch` による手動実行も可能です。

`--local` オプションで任意のローカルリポジトリも集計できます。`.portal.yaml` は不要で、author はCLI 引数で指定します。

```bash
# 全コミット対象
pnpm run collect-metrics -- --local /path/to/repo

# author を指定して絞り込み
pnpm run collect-metrics -- --local /path/to/repo \
  --author-email "user@example.com" \
  --author-email "12345+user@users.noreply.github.com" \
  --author-name "User Name" \
  --author-github "username" \
  --output ./metrics.json
```

## ライセンス

`src/data/` 以下を除くプログラム部分は [MIT License](./LICENSE) の下で公開されています。
`src/data/` 以下のデータファイルはライセンスの対象外です。
