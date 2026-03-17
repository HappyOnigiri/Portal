# Portal

HappyOnigiri のプロフィールサイト。<br />
開発したプロダクトを一覧表示します。<br />
リポジトリの開発メトリクス（コミット数、PR、CI 実行回数、言語比率など）を自動集計し、ダッシュボードとして表示します。

**Tech stack:** Astro 6 / React 19 / TailwindCSS 4 / TypeScript

## セットアップ

```bash
# Node.js >=22.12.0
npm install
```

## 開発コマンド

| コマンド | 説明 |
|---|---|
| `npm run dev` | 開発サーバー起動 (`localhost:4321`) |
| `npm run build` | プロダクションビルド → `dist/` |
| `npm run preview` | ビルド成果物のプレビュー |
| `npm run lint` | Biome による静的解析 |
| `npm run check` | CI 相当の厳格チェック |
| `npm run format` | Biome + Prettier によるフォーマット |
| `npm run typecheck` | TypeScript 型チェック |
| `npm run test` | Vitest によるテスト実行 |
| `npm run test:coverage` | カバレッジ付きテスト |
| `npm run collect-metrics` | GitHub メトリクス収集 |
| `make ci` | lint + typecheck + test + build を一括実行 |

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
npm run collect-metrics -- --local /path/to/repo

# author を指定して絞り込み
npm run collect-metrics -- --local /path/to/repo \
  --author-email "user@example.com" \
  --author-email "12345+user@users.noreply.github.com" \
  --author-name "User Name" \
  --author-github "username" \
  --output ./metrics.json
```

## ライセンス

`src/data/` 以下を除くプログラム部分は [MIT License](./LICENSE) の下で公開されています。
`src/data/` 以下のデータファイルはライセンスの対象外です。
