# Portal

個人ポートフォリオ兼開発ダッシュボード。制作物の一覧、Zenn / note の記事、複数リポジトリから集計した開発メトリクス（コミット数・PR・CI 実行回数・言語比率・日次の活動量）を 1 つのサイトで公開しています。

**Tech stack:** Astro 6 / React 19 / Tailwind CSS 4 / TypeScript 6

## 主な機能

### マルチテーマ

5 つのテーマ（cyber / pop / nagomi / brutal / terminal）を、テーマごとの静的ページとして実装しています。配色だけでなく、レイアウトやコンポーネントもテーマごとに持ちます（`src/components/themes/<name>/`）。共通のスタイルは `src/styles/portal.css` の CSS 変数で切り替えます。

### コンテンツ

- **プロジェクト** — YAML で管理する Content Collection
- **記事** — ビルド時に Zenn / note から取得。取得できない場合はローカルの JSON を使う

### 開発メトリクス

`.portal.yaml`（書式は `.portal.sample.yaml` を参照）に登録したリポジトリから累積メトリクスを集計し、`src/data/` に保存します。GitHub Actions で定期実行し、差分があれば自動でコミットします。

- 変更のないリポジトリは再集計しない
- 自動生成コードや外部コードは行数・言語比率から除外する

### 日次アクティビティ

Commits・Changed Lines・Merged PRs・CI Runs を日ごとに集計し、直近 90 日・12 ヶ月・全期間で切り替えて表示します。

- 集計対象は本人のコミット・PR・CI 実行のみ
- 既存コードの一括投入や bot の定期コミットは、リポジトリ設定の `activityExcludeCommits`（SHA）/ `activityExcludeSubjects`（件名の正規表現）で除外できる
- 取得できなかった期間は 0 ではなく「未取得」として表示する

#### 別環境のリポジトリを取り込む

GitHub から取得できないローカルリポジトリも、Python と Git だけで集計して取り込めます。

```bash
python3 scripts/count-loc.py /path/to/repository \
  --offline --ref main \
  --author-email you@example.com \
  --output work1-totals.json \
  --activity-output work1-daily.json
```

1. `work1-totals.json` を `src/data/repositories/work1.json` に置く
2. `work1-daily.json` を `src/data/activity-repositories/work1.json` に置く
3. `pnpm run generate-activity --aggregate-only` で表示用データを再生成する

出力にはパス・リポジトリ名・著者情報・コミット SHA を含みません。1 リポジトリにつき 1 ファイルとし、更新時は同じファイルを置き換えてください。

### その他

- **i18n** — 日本語 / 英語をブラウザの言語設定で切り替え（手動切替も可）
- **構造化データ** — JSON-LD を生成して `<head>` に埋め込み（`src/utils/structured-data.ts`）

## 開発

```bash
pnpm install      # Node.js 24.x / pnpm 10
pnpm run dev      # localhost:4321
make ci           # lint + typecheck + test + build
make collect      # メトリクスを集計して src/data/ を更新
```

## ライセンス

`src/data/` 以下を除くプログラム部分は [MIT License](./LICENSE) の下で公開されています。
`src/data/` 以下のデータファイルはライセンスの対象外です。
