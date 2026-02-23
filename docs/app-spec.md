# アプリケーション仕様 — app-spec.md

> 最終更新: 2026-02-24

## 概要

Nexus は Element Web をフォークし、Discord 風の**機能構成**にカスタマイズした Matrix チャットクライアント。
10人以下のプライベート利用を想定。

## デザイン方針

- **テーマ/カラー**: Element 標準のまま（ライト/ダーク切替可能）
- **機能構成**: Discord 風（テキスト/VCチャンネル分離等）
- **新規 UI**: Discord を参考にデザイン
- **既存 UI**: Element のデザインをベースにする

## 主要機能

| 機能 | 提供元 | 状態 |
|------|--------|------|
| テキストチャット | Element Web (matrix-js-sdk) | 組み込み済み |
| ボイスチャット (VC) | Nexus (livekit-client + MatrixRTC) | 実装済み |
| 画面共有 | Nexus (livekit-client, 720p30 simulcast) | 実装済み |
| 画面共有オプトイン視聴 | Nexus (Discord 準拠 — プレビュー+クリックで視聴開始) | 実装済み |
| E2E 暗号化 | matrix-js-sdk (Olm/Megolm) | 組み込み済み |
| テキスト/VC チャンネル分離 | Nexus (NexusChannelListView) | 実装済み |
| VC 参加者グリッド | Nexus (NexusVoiceParticipantGrid) | 実装済み |
| 個別音量調整 | Nexus (NexusParticipantContextMenu) | 実装済み |
| 入力/出力音量調整 | Nexus (Web Audio API GainNode) | 実装済み |
| 入力感度（ボイスゲート） | Nexus (AnalyserNode + GainNode) | 実装済み |
| 発話検出 | Nexus (ローカル: inputLevel / リモート: LiveKit isSpeaking) | 実装済み |
| Ping/遅延表示 | Nexus (RTCPeerConnection.getStats) | 実装済み |

## UI 構成

```
┌──────┬──────────────┬──────────────────────────┬────────────┐
│Server│ Channel List │      Message Area         │  Member    │
│ Bar  │              │                           │  List      │
│      │ # general    │  User1         12:34      │            │
│ [S1] │ # random     │  メッセージ内容           │  Online    │
│ [S2] │              │                           │  ── User1  │
│ [S3] │ Voice        │  User2         12:35      │  ── User2  │
│      │ 🔊 VC-1     │  メッセージ内容           │            │
│      │   ├ User1    │                           │  Offline   │
│      │   └ User2    │                           │  ── User3  │
│      │ 🔊 VC-2     │                           │            │
│      ├──────────────┤                           │            │
│      │ Call Status  ├──────────────────────────┤            │
│      │ 🟢 通話中   │  [メッセージ入力欄]       │            │
│      ├──────────────┤                           │            │
│      │ User Panel   │                           │            │
│      │ 🎤 ⚙️       │                           │            │
└──────┴──────────────┴──────────────────────────┴────────────┘
```

### 各エリアの詳細

#### Server Bar（左端）
- **コンポーネント**: `SpacePanel`
- Space = Discord の「サーバー」に対応

#### Channel List（左サイドバー）
- **コンポーネント**: `NexusChannelListView`
- テキストチャンネル（`#` アイコン）とボイスチャンネル（スピーカーアイコン）を視覚的に分離
- VC チャンネルの下に参加者リストをリアルタイム表示（`VoiceChannelParticipants`）
- 未接続の VC チャンネルは「まだ誰もいません」+ 参加ボタンを表示

#### Call Status Panel（左サイドバー下部）
- **コンポーネント**: `NexusCallStatusPanel`
- 接続中: 黄色パルスドット +「接続中…」
- 通話中: 緑丸 + ルーム名 + 終話ボタン
- 未接続: 非表示

#### User Panel（左サイドバー最下部）
- **コンポーネント**: `NexusUserPanel`
- アバター + 表示名 + マイクミュートボタン + 設定ボタン

#### Message Area / VC Room View（中央）
- テキストチャンネル: `RoomView`（メッセージタイムライン）
- VC チャンネル: `NexusVCRoomView`（参加者グリッド + コントロールバー + タイムライン）
  - spotlight/grid 切替対応
  - 画面共有時は自動で spotlight モードに切替

#### Member List（右サイドバー）
- ロール別にグルーピング
- オンライン/オフライン状態の表示

## VC アーキテクチャ

```
NexusVoiceStore (シングルトン)
  └─ NexusVoiceConnection
       ├─ Web Audio API パイプライン
       │    ├─ AudioContext
       │    ├─ MediaStreamSource (マイク入力)
       │    ├─ AnalyserNode (入力レベル監視、50ms ポーリング)
       │    ├─ GainNode (入力音量調整 + ボイスゲート)
       │    └─ MediaStreamDestination → 処理済みトラック
       ├─ LiveKit Room (livekit-client)
       │    ├─ 処理済みオーディオトラック (GainNode 経由)
       │    ├─ リモートオーディオ再生 (HTMLAudioElement + マスター音量)
       │    └─ 画面共有トラック (720p30 + 360p15 simulcast, contentHint: detail)
       ├─ MatrixRTC Session (matrix-js-sdk)
       │    └─ メンバーシップ管理 (参加者リスト)
       └─ CORS Proxy (Cloudflare Workers)
            └─ LiveKit JWT 取得
```

### VC 接続フロー最適化

接続時間短縮のため、`connect()` 内で以下を `Promise.all` で並列実行:

```
┌─ getJwt()              （JWT 取得: 200-500ms）
├─ createLocalAudioTrack() （マイクアクセス: 50-200ms）
└─ preloadRnnoiseWasm()    （WASM プリロード: 50-150ms）
         ↓
livekitRoom.connect()      （WebRTC 確立: 500-5000ms）← JWT 必要なので後
         ↓
AudioContext 構築 + publishTrack ← マイクトラック必要なので後
```

詳細な調査・設計メモは [docs/vc-optimization.md](./vc-optimization.md) を参照。

### SE（効果音）タイミング
- **入室**: ボタン押下時に standby SE → 接続確立（参加者リスト表示）時に join SE
- **退室**: ボタン押下時に leave SE → UI 即クリア → バックグラウンドで切断処理
- **他ユーザー入退室**: MatrixRTC MembershipsChanged イベント時に join/leave SE
- **ミュート/アンミュート**: トグル時に mute/unmute SE

### 音声設定（設定 → 音声・ビデオ）
2カラムレイアウト（左:入力 / 右:出力）:
- **入力デバイス**: マイク選択ドロップダウン
- **マイク音量** (0-200%): Web Audio API GainNode で入力音量調整
- **自動ゲイン**: ブラウザの AGC トグル
- **出力デバイス**: スピーカー選択ドロップダウン
- **スピーカー音量** (0-200%): 全リモート参加者の HTMLAudioElement.volume 一括調整

入力感度セクション:
- **ボイスゲート**: AnalyserNode で RMS 計測、閾値以下で GainNode.gain=0（300ms リリース遅延）
- **リアルタイムレベルメーター**: 50ms 間隔で入力レベルを表示、閾値ラインをオーバーレイ表示
- **VC 未接続時のレベルメーター**: 独立した `getUserMedia` + `AnalyserNode` で動作（VC 接続不要）

### 発話検出の仕組み
- **ローカルユーザー**: Web Audio API の AnalyserNode で計測した `inputLevel > 5` で判定（LiveKit の `isSpeaking` は処理済みトラック publish のため不動作）
- **リモートユーザー**: LiveKit の `participant.isSpeaking` をポーリング（250ms 間隔）
- **ミュート方式**: `mediaStreamTrack.enabled` 直接操作（LiveKit の `mute()/unmute()` は非 publish トラックのため不使用）

### 画面共有オプトイン視聴（Discord 準拠）

他者の画面共有が開始されても自動でスポットライトに表示せず、プレビューオーバーレイ付きタイルを表示。
ユーザーが「画面を視聴する」をクリックして初めてスポットライトに表示される。

| ケース | 動作 |
|-------|------|
| 自分が画面共有 | `isLocal` で自動 watched → プレビューなし、直接表示 |
| 他者が画面共有開始 | ボトムバー/グリッドにプレビューオーバーレイ表示 |
| 「画面を視聴する」クリック | `watchingIds` に追加 → スポットライトに表示 |
| 画面共有が終了 | `useEffect` で `watchingIds` から自動削除 |

- **state**: `watchingIds: Set<string>` — 視聴中の画面共有者の `participantIdentity`
- **SpotlightLayout / GridLayout** 両方で同じ UX

### 画面共有エンコーディング（Discord 準拠）

| 項目 | 設定値 | 理由 |
|------|--------|------|
| 解像度上限 | 720p | Discord 無料版と同等 |
| FPS | 30（帯域不足時 15 に自動低下） | simulcast で適応 |
| ビットレート上限 | 2Mbps (高層) / 400kbps (低層) | 過剰にしない方針 |
| コーデック | VP8（LiveKit デフォルト） | 互換性最高 |
| simulcast | h720fps30 + h360fps15 | 低帯域ユーザー向けフォールバック |
| contentHint | `"detail"` | テキスト/UI の鮮明さ優先 |
| degradationPreference | `"maintain-resolution"` | 帯域不足時は FPS を落として解像度維持 |

## 無効化した機能

| 機能 | 方法 |
|------|------|
| インテグレーションマネージャ (Scalar) | config から削除 |
| Jitsi | Element Call に一本化 (use_exclusively) |
| 公開ルーム/スペース作成 | UIFeature で無効化 |
| フィードバック/バグ報告 | UIFeature で無効化 |
| 位置情報共有 | UIFeature で無効化 |
| SNS共有/QRコード共有 | UIFeature で無効化 |
| IDサーバー/サードパーティID | UIFeature で無効化 |
| ルーム一覧フィルター | コードで非表示 |
| ルームヘッダーの通話ボタン | コードで非表示 |
| メンバーのステートイベント | setting_defaults で非表示 |
| Element Call iframe | コードで完全排除（LiveKit 直接接続に移行） |

## Phase 別の実装計画

### Phase 1: 環境構築 & 動作確認 ✅
Element Web をそのままデプロイし、全機能が動作することを確認

### Phase 2: 機能カスタマイズ ✅
1. ~~カラースキームの変更~~ → Element 標準のまま
2. 不要機能の無効化 ✅
3. ブランディング差し替え ✅
4. テキスト/VC チャンネル分離 ✅
5. 不要な UI 要素の非表示 ✅

### Phase 2.5: 通話機能の内包 ✅
Element Call iframe を廃止し、livekit-client を直接組み込み

### Phase 3: Tauri 2 ネイティブ化
Web 版の UI が固まった後に着手
