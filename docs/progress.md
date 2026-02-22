# 進捗・作業ログ — progress.md

> 最終更新: 2026-02-23

## リポジトリ情報

- **URL**: https://github.com/mi2h1/nexus.git
- **ホスティング**: GitHub Pages (`https://mi2h1.github.io/nexus/`)
- **ブランチ運用**: `main` = デプロイ対象
- **upstream**: https://github.com/element-hq/element-web.git (`develop` ブランチ)

## ディレクトリ構成

```
nexus/                          # element-web フォーク
├── CLAUDE.md                   # プロジェクトルール
├── HANDOVER.md                 # セッション引き継ぎ
├── docs/                       # プロジェクトドキュメント
│   ├── conventions.md          # 開発規約
│   ├── progress.md             # 進捗（このファイル）
│   ├── tech-stack.md           # 技術スタック
│   └── app-spec.md             # アプリ仕様・UI設計
├── src/                        # ソースコード
├── res/                        # リソース・CSS
├── config.json                 # アプリ設定（Nexus カスタム）
└── .github/workflows/pages.yml # GitHub Pages デプロイ
```

## Phase 1: 環境構築 & 動作確認

### 次のタスク

1. **ブラウザで動作確認**
   - https://mi2h1.github.io/nexus/ にアクセス
   - matrix.org アカウントでログイン
   - テキストチャット / VC / 画面共有の動作確認
2. **Hooks 設定（ESLint + Prettier）**
   - Element Web 同梱のリンター/フォーマッターを Hooks で自動実行

### 完了したタスク

#### 2026-02-23
- プロジェクトドキュメント一式を作成（CLAUDE.md, HANDOVER.md, conventions.md, progress.md, tech-stack.md, app-spec.md）
- element-hq/element-web を nexus リポジトリに取り込み
  - upstream として element-hq/element-web を登録
  - デフォルトブランチを `develop` → `main` にリネーム
- config.json を作成（brand: Nexus, theme: dark, country: JP）
- GitHub Actions デプロイワークフロー作成（pnpm + nx build → GitHub Pages）
  - Element Web 固有の不要なワークフロー 37 個を削除
  - `pages.yml` を新規作成
- .gitignore を修正（config.json をリポジトリに含める）
- GitHub Pages を有効化、初回ビルド & デプロイ成功
- **注意**: HANDOVER.md に書かれていた技術スタックは一部古い情報だった
  - パッケージマネージャ: Yarn 1.x → **pnpm 10.x**
  - ビルドツール: Webpack (直接) → **nx + Webpack**
