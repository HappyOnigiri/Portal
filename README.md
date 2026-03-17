# Portal

Astro 6 を使用したポータルサイトプロジェクト。

## セットアップ

### 前提条件

- Node.js: `>=22.12.0`
- npm: 最新バージョン推奨

### インストール

```bash
npm install
```

## 開発コマンド

### 開発サーバーの起動

```bash
npm run dev
```

ローカルサーバーが起動します（通常は `http://localhost:4321`）。

### ビルド

```bash
npm run build
```

`dist/` ディレクトリにプロダクション用の成果物が生成されます。

### プレビュー

```bash
npm run preview
```

ビルドされた成果物をローカルで確認します。

## ツール

### 静的解析 (Lint)

```bash
npm run lint
```

Biome を使用してコードのチェックを行います。

CI 相当の厳格チェックは以下です。

```bash
npm run check
```

### フォーマット

```bash
npm run format
```

Biome を使用してコードを整形します。

### テスト

```bash
npm run test
```

Vitest を使用してテストを実行します。

カバレッジ計測を含む実行は以下です。

```bash
npm run test:coverage
```

### TypeScript 型チェック

```bash
npm run typecheck
```

`tsc --noEmit` による型整合性検証を行います。

### TypeScript カスタムルールチェック

```bash
npm run check:ts-rules
```

`@ts-ignore` と明示的 `any` の使用を検出します。

### メトリクス収集

```bash
npm run collect-metrics
```

`.portal.yaml`（または `PORTAL_CONFIG` 環境変数）に設定されたリポジトリのメトリクスを収集し、`src/data/repositories/` 以下に JSON を保存します。

#### ローカルリポジトリの集計 (`--local`)

設定ファイルを変更せず、ローカルに存在する任意のリポジトリを集計できます。

```bash
# stdout に JSON を出力
npm run collect-metrics -- --local /path/to/repo

# ファイルに出力
npm run collect-metrics -- --local /path/to/repo --output ./metrics.json

# ダッシュボードに手動で組み込む場合
npm run collect-metrics -- --local /path/to/repo --output src/data/repositories/local/MyProject.json
```

- `--local` — 集計対象のローカルリポジトリのパスを指定します
- `--output` — 出力先ファイルパス。省略すると stdout に出力されます
- GitHub リモート（`origin`）が github.com を指していれば PR 数・CI 実行数も集計します
- GitHub リモートがない場合は `mergedPRs` / `ciRuns` が 0 になります
- 出力は通常の per-repo JSON と同じ形式（`cacheKey` は空文字列）

## CI

```bash
make ci
```

Biome 厳格チェック、TypeScript 型チェック、TypeScript カスタムルール、テスト（カバレッジ付き）、ビルドを一括で実行します。プルリクエストの作成前などに実行してください。
