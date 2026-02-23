# 技術スタック — tech-stack.md

> 最終更新: 2026-02-23

## 実行環境

| 項目 | 内容 |
|------|------|
| 開発環境 | VPS: Ubuntu 25.04, 3コア/4GB RAM |
| Node.js | v20 LTS 以上 |
| パッケージマネージャ | pnpm 10.x（Element Web 標準） |
| ビルド | GitHub Actions（VPS ではビルドしない） |
| ホスティング | GitHub Pages（静的ファイル配信） |

## フロントエンド

| 技術 | バージョン | 役割 |
|------|-----------|------|
| Element Web | latest (フォーク) | ベースとなる Matrix クライアント |
| React | Element Web 同梱 | UI フレームワーク |
| TypeScript | Element Web 同梱 | 型安全な開発 |
| Webpack | Element Web 同梱 | バンドラー |
| matrix-js-sdk | Element Web 同梱 | Matrix プロトコル通信（MatrixRTC シグナリング含む） |
| matrix-react-sdk | Element Web に統合済み | UI コンポーネント群 |
| livekit-client | Element Web 同梱 | VC・画面共有（LiveKit SFU 直接接続） |

## インフラ・サービス

| サービス | 用途 | コスト |
|---------|------|--------|
| matrix.org | Matrix ホームサーバー（公開サーバー利用） | 無料 |
| GitHub Pages | クライアントホスティング | 無料 |
| GitHub Actions | CI/CD（ビルド & デプロイ） | 無料 |
| LiveKit SFU (matrix.org 提供) | VC・画面共有の SFU インフラ | 無料 |
| Cloudflare Workers | LiveKit JWT 取得用 CORS プロキシ | 無料 |

## 将来追加予定

| 技術 | 用途 | 時期 |
|------|------|------|
| Tauri 2 | Windows ネイティブアプリ化 | Phase 3（Web UI 完成後） |

## CSS アーキテクチャ

- Element Web 既存: `mx_` プレフィックス + CSS カスタムプロパティ (`--cpd-color-*`)
- Nexus 新規: `nx_` プレフィックス（`mx_Nexus*` も一部使用）
- テーマ定義: `res/themes/` ディレクトリ
- コンポーネント CSS: 各コンポーネントと同ディレクトリに配置

## VC 通信フロー

```
ブラウザ (Nexus)
  │
  ├─ MatrixRTC (matrix-js-sdk)
  │    └─ m.call.member ステートイベントで参加/退出を通知
  │
  ├─ CORS Proxy (Cloudflare Workers)
  │    └─ LiveKit JWT 取得（livekit-jwt.call.matrix.org へ中継）
  │
  └─ LiveKit SFU (livekit-client)
       ├─ 音声トラック送受信
       ├─ 画面共有トラック送受信
       └─ WebRTC stats（遅延計測）
```
