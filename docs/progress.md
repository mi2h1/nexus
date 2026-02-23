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
│   ├── models/
│   │   └── NexusVoiceConnection.ts  # LiveKit 直接接続クラス
│   ├── stores/
│   │   └── NexusVoiceStore.ts       # VC 接続管理シングルトン
│   ├── hooks/
│   │   ├── useNexusVoice.ts         # VC 状態フック
│   │   ├── useNexusActiveSpeakers.ts# 発話検出フック
│   │   ├── useNexusScreenShares.ts  # 画面共有フック
│   │   └── useNexusParticipantStates.ts # 参加者状態フック
│   └── components/views/
│       ├── rooms/RoomListPanel/
│       │   ├── NexusChannelListView.tsx  # テキスト/VC チャンネル分離
│       │   ├── NexusChannelIcon.tsx      # チャンネルアイコン
│       │   ├── NexusUserPanel.tsx        # Discord 風ユーザーパネル
│       │   ├── NexusCallStatusPanel.tsx  # 通話ステータスパネル
│       │   └── VoiceChannelParticipants.tsx # VC 参加者リスト
│       └── voip/
│           ├── NexusVCRoomView.tsx       # VC ルームビュー
│           ├── NexusVoiceParticipantGrid.tsx # 参加者グリッド
│           ├── NexusVCControlBar.tsx     # VC コントロールバー
│           ├── NexusScreenShareView.tsx  # 画面共有ビュー
│           └── NexusParticipantContextMenu.tsx # 参加者コンテキストメニュー
├── res/css/views/              # Nexus カスタム CSS
│   ├── rooms/RoomListPanel/
│   │   ├── _NexusChannelList.pcss
│   │   └── _NexusUserPanel.pcss
│   └── voip/
│       ├── _NexusVCRoomView.pcss
│       ├── _NexusVoiceParticipantGrid.pcss
│       ├── _NexusVCControlBar.pcss
│       ├── _NexusScreenShareView.pcss
│       └── _NexusParticipantContextMenu.pcss
├── config.json                 # アプリ設定（Nexus カスタム）
└── .github/workflows/pages.yml # GitHub Pages デプロイ
```

## Phase 2.5: 通話機能の内包 ✅ 完了

> Element Call の iframe 方式を廃止し、livekit-client を Nexus 本体に直接組み込み済み。

### 実装済み機能
| 機能 | 実装 |
|------|------|
| VC 接続/切断 | `NexusVoiceConnection` — LiveKit 直接接続 + MatrixRTC シグナリング |
| マイクミュート | `setMicMuted()` — `LocalAudioTrack.mute()/unmute()` |
| 画面共有 | `startScreenShare()/stopScreenShare()` — `getDisplayMedia()` |
| Ping/遅延表示 | `RTCPeerConnection.getStats()` → `currentRoundTripTime` |
| 個別音量調整 | `setParticipantVolume()` — `HTMLAudioElement.volume` |
| 発話検出 | ポーリング方式（250ms）+ LiveKit `ActiveSpeakersChanged` イベント |
| 入退室 SE | ボタン押下時に即時再生（接続完了を待たない） |
| VC 参加者グリッド | spotlight/grid 切替 + コントロールバー |
| CORS プロキシ | Cloudflare Workers 経由で LiveKit JWT を取得 |

---

## Phase 2: 機能カスタマイズ

### 完了したタスク

#### 2026-02-23
- **VC 入退室 SE 改善**: ボタン押下時に即時再生、退室を非ブロッキング化
- **音量コンテキストメニュー**: サイドバー参加者リストに移動
- **VC 退出後リロード修正**: リロードで参加者が残る問題を修正
- **ElementCall iframe 排除**: VC ルームで不要な ElementCall が作られるのを防止
- **個別音量調整**: 参加者タイル右クリックで音量スライダー表示（NexusParticipantContextMenu）
- **VC 未接続表示**: 「まだ誰もいません」+ 参加ボタンを表示
- **デザイン調整多数**: チャンネル一覧、スペース選択ノッチ、終話ボタン等
- **参加者状態アイコン**: ミュート・画面共有状態をリアルタイム表示
- **VC ルームビュー全面リファクタ**: spotlight/grid 切替 + コントロールバー（NexusVCRoomView / NexusVCControlBar）
- **接続中ステータス**: 「接続中…」を黄色パルスドットで表示（NexusCallStatusPanel）
- **発話検出**: ポーリング方式 + identity 解決ロジック、発話中ユーザーに緑ボーダー表示
- **VC 参加者グリッド**: Discord 風参加者グリッドを追加（NexusVoiceParticipantGrid）
- **ゴーストメンバー対策**: 未接続時の自分のメンバーシップを非表示
- **iframe 完全排除**: VC ルームで常に Timeline を表示
- Discord 風ユーザーパネル & 通話ステータスパネルを追加（NexusUserPanel / NexusCallStatusPanel）
- Discord 風テキスト/VC チャンネル分離を実装（NexusChannelListView）
- VC チャンネル参加者表示を実装（VoiceChannelParticipants）
- 不要な UI 要素を非表示（インテグレーションマネージャ、Jitsi 等）
- Element ブランディングを Nexus に差し替え

## Phase 1: 環境構築 & 動作確認 ✅ 完了

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
