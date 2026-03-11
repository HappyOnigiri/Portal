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

## CI

```bash
make ci
```

Biome 厳格チェック、TypeScript 型チェック、TypeScript カスタムルール、テスト（カバレッジ付き）、ビルドを一括で実行します。プルリクエストの作成前などに実行してください。
