# 進捗・作業ログ — progress.md

> 最終更新: 2026-02-23

## リポジトリ情報

- **URL**: https://github.com/mi2h1/nexus.git
- **ホスティング**: GitHub Pages (`https://mi2h1.github.io/nexus/`)
- **ブランチ運用**: `main` = デプロイ対象

## ディレクトリ構成

```
nexus/                          # element-web フォーク（予定）
├── CLAUDE.md                   # プロジェクトルール
├── HANDOVER.md                 # セッション引き継ぎ
├── docs/                       # プロジェクトドキュメント
│   ├── conventions.md          # 開発規約
│   ├── progress.md             # 進捗（このファイル）
│   ├── tech-stack.md           # 技術スタック
│   └── app-spec.md             # アプリ仕様・UI設計
├── src/                        # ソースコード（element-web フォーク後）
├── res/                        # リソース・CSS（element-web フォーク後）
├── config.json                 # アプリ設定
└── .github/workflows/deploy.yml # CI/CD
```

## Phase 1: 環境構築 & 動作確認

### 次のタスク

1. **element-web のフォーク内容をリポジトリに取り込む**
   - element-hq/element-web のコードを nexus リポジトリに配置
   - upstream として element-hq/element-web を登録
2. **config.json を作成・設定**
   - matrix.org をデフォルトサーバーに設定
   - ブランド名を "Nexus" に変更
3. **GitHub Actions デプロイ設定**
   - `.github/workflows/deploy.yml` を作成
   - GitHub Pages の Source を "GitHub Actions" に変更
4. **初回デプロイ & 動作確認**
   - テキストチャット / VC / 画面共有の動作確認
5. **Hooks 設定（ESLint + Prettier）**
   - Element Web 同梱のリンター/フォーマッターを Hooks で自動実行

### 完了したタスク

#### 2026-02-23
- プロジェクトドキュメント一式を作成（CLAUDE.md, conventions.md, progress.md, tech-stack.md, app-spec.md）
- GitHub リポジトリ作成済み（空の状態）
