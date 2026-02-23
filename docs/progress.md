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

## Phase 2.5: 通話機能の内包（優先度: 高）

> Element Call を iframe 経由で利用する現行方式から、livekit-client-sdk を Nexus 本体に直接組み込む方式へ移行する。

### 動機
- iframe 方式では毎回 Element Call を丸ごと起動し直すため VC 参加が遅い（数秒のオーバーヘッド）
- WebRTC の stats / メディアストリームが iframe 内に閉じており、外部から制御できない
  - Ping/遅延表示、スピーカーミュート、画面共有の外部制御が不可能

### 内包で可能になること
| 機能 | 現状 | 内包後 |
|------|------|--------|
| VC 参加速度 | iframe ロード + アセット取得で遅い | 事前初期化済みで即接続 |
| Ping/遅延表示 | API なし | `RTCPeerConnection.getStats()` → `currentRoundTripTime` |
| スピーカーミュート | iframe 内で再生、制御不可 | `AudioContext` / `volume` で制御 |
| マイクミュート | Jitsi のみ動作、EC は ack のみ | 直接 `MediaStreamTrack.enabled` 制御 |
| 画面共有の外部制御 | iframe 内部処理 | `getDisplayMedia()` を自前で呼べる |

### 技術方針（暫定）
1. `livekit-client-sdk` を直接依存に追加
2. MatrixRTC シグナリング（ステートイベント）は既存の matrix-js-sdk を利用
3. E2EE は SFrame（LiveKit SDK 内蔵）を利用
4. Element Call の通話ロジック（参加/退出/メディア管理）を Nexus 内に再実装
5. 既存の iframe ウィジェット方式は段階的に廃止

### ステータス: 未着手

---

## Phase 2: 機能カスタマイズ

### 完了したタスク

#### 2026-02-23
- Discord 風ユーザーパネル & 通話ステータスパネルを追加（NexusUserPanel / NexusCallStatusPanel）
  - アバター・表示名・マイクミュート・設定ボタン
  - 通話中: 接続状態ドット + ルーム名 + 終話ボタン
  - SpacePanel 下部のスレッドボタンを削除
- Discord 風テキスト/VC チャンネル分離を実装（NexusChannelListView）
- VC チャンネル参加者表示を実装（VoiceChannelParticipants）
  - チャンネル名の下にアバター + 名前をリアルタイム表示
  - useCall / useParticipatingMembers を活用
- 不要な UI 要素を非表示（インテグレーションマネージャ、Jitsi 等）
- Element ブランディングを Nexus に差し替え

## Phase 1: 環境構築 & 動作確認

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
