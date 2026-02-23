# 進捗・作業ログ — progress.md

> 最終更新: 2026-02-24

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
│   ├── app-spec.md             # アプリ仕様・UI設計
│   └── vc-optimization.md      # VC 接続高速化 調査・設計メモ
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
│   ├── settings/
│   │   └── _NexusVoiceSettings.pcss    # 音声設定スライダー・レベルメーター
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
| VC 接続高速化 | `connect()` で JWT取得+マイクアクセス+WASMプリロードを並列実行 |
| マイクミュート | `setMicMuted()` — `mediaStreamTrack.enabled` 直接操作（非publish トラック経由） |
| 画面共有 | `startScreenShare()/stopScreenShare()` — `getDisplayMedia()` + 720p30/simulcast エンコーディング |
| 画面共有オプトイン視聴 | Discord 準拠 — 他者の画面共有はプレビュー+「画面を視聴する」クリックで表示 |
| Ping/遅延表示 | `RTCPeerConnection.getStats()` → `currentRoundTripTime` |
| 個別音量調整 | `setParticipantVolume()` — `HTMLAudioElement.volume` |
| 入力音量調整 | Web Audio API `GainNode` — 0-200% スライダー |
| 出力マスター音量 | `setMasterOutputVolume()` — 全リモート参加者の受信音量一括調整 |
| 入力感度（ボイスゲート） | `AnalyserNode` RMS 計測 → 閾値以下で `GainNode.gain=0`（300ms リリース遅延） |
| 発話検出 | ポーリング方式（250ms）— ローカルは自前 `inputLevel>5` / リモートは LiveKit `isSpeaking` |
| 入退室 SE | 押下時 standby SE → 接続確立時 join SE → 退室時 leave SE |
| VC 参加者グリッド | spotlight/grid 切替 + コントロールバー |
| 音声設定 UI | 入力/出力音量スライダー + 入力感度トグル/閾値 + リアルタイムレベルメーター |
| 設定画面マイクゲージ | VC 未接続時も独立した getUserMedia+AnalyserNode でレベルメーター動作 |
| CORS プロキシ | Cloudflare Workers 経由で LiveKit JWT を取得 |

---

## Phase 2: 機能カスタマイズ

### 完了したタスク

#### 2026-02-24
- **画面共有オプトイン視聴機能**: Discord 準拠の画面共有視聴 UX を実装
  - 他者の画面共有は自動表示せず、ボトムバー/グリッドにプレビューオーバーレイ付きタイル表示
  - 「画面を視聴する」クリックで初めてスポットライトに表示
  - 自分の画面共有は従来通り自動表示（`isLocal` 判定）
  - `watchingIds` state で視聴中の画面共有を管理、終了時に自動クリーンアップ
- **VC 接続フロー並列化**: 接続時間を最大 500ms 短縮
  - `connect()` 内で JWT取得 + マイクアクセス + RNNoise WASM プリロードを `Promise.all` で並列実行
  - `preloadRnnoiseWasm()` スタティックメソッド追加（AudioContext 不要で WASM だけ先にダウンロード）
- **設定画面マイクゲージ独立動作**: VC 未接続時も入力レベルメーターが動作
  - `useSettingsInputLevel` フック追加 — 独立した `getUserMedia` + `AnalyserNode` で 50ms ポーリング
  - VC 接続時は接続の `CallEvent.InputLevel` をそのまま使用（従来動作）
- **VC 接続高速化調査ドキュメント**: `docs/vc-optimization.md` 追加
  - Discord のボイス接続アーキテクチャとの比較分析
  - SFU 代替（Mediasoup, Cloudflare Calls 等）の検討
  - 最適化ロードマップ（並列化 → JWT キャッシュ → Tauri UDP 高速パス）
- **画面共有エンコーディング修正**: 高解像度モニターで受信側が真っ暗になる問題を修正
  - `ScreenSharePresets.h720fps30` (2Mbps/30fps) をエンコーディング上限に設定
  - `ScreenSharePresets.h360fps15` (400kbps/15fps) の simulcast 層で低帯域対応
  - `contentHint: "detail"` でテキスト/UI の鮮明さを優先
  - `degradationPreference: "maintain-resolution"` で帯域不足時はFPSを落として解像度維持
  - Discord 無料版と同等の品質設定（720p/30fps 上限）

#### 2026-02-23
- **Discord 風音声設定**: 入力音量・出力音量・入力感度（ボイスゲート）を追加
  - Web Audio API パイプライン（AnalyserNode + GainNode）で入力音量調整・レベル監視
  - ボイスゲート: 閾値以下の入力を自動ミュート（300ms リリース遅延、ポップノイズなし）
  - 設定 UI: 2カラムレイアウト（左:入力デバイス+音量 / 右:出力デバイス+音量）+ 入力感度セクション
  - リアルタイムレベルメーター + 閾値ラインオーバーレイ
  - コントロールバー設定ボタンが音声・ビデオタブを直接オープン
  - VC 接続開始 SE を standby SE に分離（接続確立時に join SE）
- **発話インジケーター修正**: Web Audio API 経由で処理済みトラックを publish するため LiveKit の `isSpeaking` が不動作 → 自前の `inputLevel > 5` で検知に変更
- **マイクミュート方式変更**: `LocalAudioTrack.mute()/unmute()` → `mediaStreamTrack.enabled` 直接操作（publish されたのは処理済みトラックのため）
- **SE 差し替え**: join/leave/mute の SE を高品質版に差し替え、音量を 0.25 に調整
- **ブラウザ更新直後の VC 接続修正**: transports 未取得時に TransportsUpdated イベントを待機 + 参加者リスト retry ポーリング追加
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
