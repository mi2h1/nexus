# 技術スタック — tech-stack.md

> 最終更新: 2026-02-23

## 実行環境

| 項目 | 内容 |
|------|------|
| 開発環境 | VPS: Ubuntu 25.04, 3コア/4GB RAM |
| Node.js | v20 LTS 以上 |
| パッケージマネージャ | Yarn 1.x（Element Web 標準） |
| ビルド | GitHub Actions（VPS ではビルドしない） |
| ホスティング | GitHub Pages（静的ファイル配信） |

## フロントエンド

| 技術 | バージョン | 役割 |
|------|-----------|------|
| Element Web | latest (フォーク) | ベースとなる Matrix クライアント |
| React | Element Web 同梱 | UI フレームワーク |
| TypeScript | Element Web 同梱 | 型安全な開発 |
| Webpack | Element Web 同梱 | バンドラー |
| matrix-js-sdk | Element Web 同梱 | Matrix プロトコル通信 |
| matrix-react-sdk | Element Web に統合済み | UI コンポーネント群 |
| Element Call | Element Web に統合済み | VC・画面共有（LiveKit ベース） |

## インフラ・サービス

| サービス | 用途 | コスト |
|---------|------|--------|
| matrix.org | Matrix ホームサーバー（公開サーバー利用） | 無料 |
| GitHub Pages | クライアントホスティング | 無料 |
| GitHub Actions | CI/CD（ビルド & デプロイ） | 無料 |
| Element Call (LiveKit) | VC・画面共有のインフラ | 無料（matrix.org 提供） |

## 将来追加予定

| 技術 | 用途 | 時期 |
|------|------|------|
| Tauri 2 | Windows ネイティブアプリ化 | Phase 3（Web UI 完成後） |

## CSS アーキテクチャ

- Element Web 既存: `mx_` プレフィックス + CSS カスタムプロパティ (`--cpd-color-*`)
- Nexus 新規: `nx_` プレフィックス
- テーマ定義: `res/themes/` ディレクトリ
- コンポーネント CSS: 各コンポーネントと同ディレクトリに配置
