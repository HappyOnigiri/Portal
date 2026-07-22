# Portal

個人ポートフォリオ兼開発ダッシュボード。プロダクト一覧の表示に加え、複数リポジトリの開発メトリクス（コミット数・PR・CI 実行回数・言語比率など）を自動集計して可視化します。

**Tech stack:** Astro 6 / React 19 / Tailwind CSS 4 / TypeScript 6

## アーキテクチャ

### マルチテーマシステム

5 テーマ（cyber / pop / nagomi / brutal / terminal）を、クライアント JS でのテーマ切替ではなく **テーマごとに独立した静的ルート** として実装。各テーマは `src/components/themes/<name>/` に専用の Astro コンポーネント一式（Home・ProjectCard・ArticlesWidget・AuthorStatusWidget）を持ち、配色だけでなくマークアップやレイアウト自体をテーマごとに分岐できる設計です。共有スタイル層は `src/styles/portal.css` の CSS カスタムプロパティ（50 以上）で制御し、フォントスタック（Space Grotesk / Orbitron / Noto Serif JP など）もテーマ別に切り替わります。

### コンテンツパイプライン

- **プロジェクト** — YAML ベースの Content Collection。Astro の `watcher` による HMR 対応
- **記事** — ビルド時に Zenn / note の外部 API からフェッチするカスタム Content Loader。API 障害時はローカル JSON へフォールバック。Zenn 記事の英語タイトルは `og:title` をスクレイピングして取得

### メトリクス自動集計

`scripts/collect-metrics.ts`（約 1,100 行）で `.portal.yaml` に定義した 19 リポジトリのメトリクスを集計します。

- コミットハッシュ + author スコープの **HMAC ベースキャッシュ** で未変更リポジトリの再集計をスキップ
- `.gitattributes` の `linguist-generated` / `linguist-vendored` 判定を再現し、自動生成コードを除外
- 言語比率は最大剰余法で端数調整し、合計を正確に 100% に
- GraphQL search → REST fallback によるマージ済み PR 数の取得
- GitHub Actions で毎日 JST 2:00 に自動実行し、差分があれば `src/data/` を自動コミット

### i18n

属性ベースの軽量な日英切替。`data-lang-ja` / `data-lang-en` 属性とキーベースの `data-i18n` を併用し、`navigator.language` + `localStorage` で言語を決定。翻訳リソースは Astro の `define:vars` でインライン注入します。

### 構造化データ

`src/utils/structured-data.ts` で JSON-LD `@graph`（Person / WebSite / ItemList / SoftwareApplication / BreadcrumbList / CollectionPage）を生成し `<head>` に注入。

## 開発

```bash
pnpm install      # Node.js 24.x / pnpm 10
pnpm run dev      # localhost:4321
make ci           # lint + typecheck + test + build
```

## ライセンス

`src/data/` 以下を除くプログラム部分は [MIT License](./LICENSE) の下で公開されています。
`src/data/` 以下のデータファイルはライセンスの対象外です。
