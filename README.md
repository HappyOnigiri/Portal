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

`scripts/collect-metrics.ts` で `.portal.yaml` に定義したリポジトリの累積メトリクスを集計します。

- コミットハッシュ + author スコープの **HMAC ベースキャッシュ** で未変更リポジトリの再集計をスキップ
- `.gitattributes` の `linguist-generated` / `linguist-vendored` 判定を再現し、自動生成コードを除外
- 言語比率は最大剰余法で端数調整し、合計を正確に 100% に
- GraphQL search → REST fallback によるマージ済み PR 数の取得
- GitHub Actions で毎日 JST 2:00 に自動実行し、差分があれば `src/data/` を自動コミット

### 日次アクティビティ

`scripts/generate-activity.ts` が集計元から直接取得します。Portal側の既存JSONログ・Git履歴からの日次復元や、日数による均等配分は使いません。新方式で再集計したリポジトリだけを反映し、未集計のローカルリポジトリは日次ファイルを取り込むまで含めません。

- Changed Lines / Commits: デフォルトブランチから到達できる、本人フィルターに一致する非マージコミットを、元の作成日時でJSTの日次に集計。Changed Linesはソースコードの追加＋削除行数で、生成・外部コードを除外し、リネームを検出します。
- Merged PRs: 本人が作成したPRをマージ日時で集計。クローズのみのPRは含めません。
- CI Runs: 本人が起動したrunを作成日時で集計。同じrunの再実行は別件にしません。1000件を超えるAPI検索は時間区間を分割します。
- 当日は途中経過のため表示せず、前日までを90日・12ヶ月・全期間で切り替えます。12ヶ月は終端月を含む12暦月です。
- Gitの初回コミットも元の日付に含めます。既存コードの一括投入など、日次活動から除外したいコミットは、リポジトリ設定の `activityExcludeCommits` に完全なSHAを指定します。
- GitはHEADと集計設定が変わったときに履歴を再計算します。PR・CIはGitの更新に関係なく、取得済みの完了日の翌日から更新します。
- リポジトリ別データを `src/data/activity-repositories/`、表示用データを `src/data/activity.json` に保存します。alias指定時は元のリポジトリ名・コミットSHA・著者情報を出力しません。

#### 表示スケールと未取得データ

最大10段の平方根スケールです。全期間の活動日の95パーセンタイルを切り上げた共通上限を使い、期間切替で同じ日の高さを変えません。0は0段、小さな活動は最低1段、上限を超えた実値はツールチップで確認できます。中央の目盛りは上限の1/4です。

CIは削除済みのrunを復元できません。初回取得より前は取得できた下限値として「≥」と注記を表示します。APIの取得失敗やローカルデータのPR・CIも未取得として扱い、未取得の0は「Unavailable」と表示します。後続の収集ではアーカイブ済みの過去の件数を保持します。

```bash
pnpm run generate-activity                  # 元リポジトリから取得して合算
pnpm run generate-activity --aggregate-only # 保存済みデータとローカル取り込みだけを合算
```

`--aggregate-only` は日次ファイルを合算するだけで、取得日時や表示の終端日を進めません。最新の実収集日時を基準にします。

#### 別環境のローカルリポジトリを取り込む

PythonとGitだけで日次のChanged Lines・Commitsを書き出せます。完全なGit履歴が必要です。`--ref` には公開したい集計対象ブランチを指定してください。

```bash
python3 scripts/count-loc.py /path/to/repository \
  --offline --ref main \
  --author-email you@example.com \
  --output work1-totals.json \
  --activity-output work1-daily.json
```

- `work1-totals.json` は従来どおり `src/data/repositories/work1.json` へ置きます。
- `work1-daily.json` は `src/data/activity-imports/work1.json` へ置き、`pnpm run generate-activity --aggregate-only` で表示用データを再生成します。
- 次回は同じファイルを置き換えます。コピー前の古いJSONを別名で残すと重複集計になるため、1リポジトリにつき1ファイルにしてください。オンライン収集対象と同じリポジトリは取り込まないでください。
- 初期投入を除外する場合は `--exclude-commit <40文字のSHA>` を追加します。
- shallow cloneは既定で拒否します。`--allow-shallow` を付けると、本人の最初のコミットが切り詰めの境界より後にある場合だけ集計します。境界以前に本人の活動があるときはエラーにします。
- ローカル日次ファイルにパス・リポジトリ名・著者情報・コミットSHAは含みません。PR・CIの日次情報は取得しないため、未取得として合算します。
- ローカルファイルの集計日以降は未取得扱いです。累積値から日次を推測して補いません。

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
