# アプリケーション仕様 — app-spec.md

> 最終更新: 2026-03-02

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
| 画面共有 PiP | Nexus (VC ルーム外で視聴中の画面共有を PiP 表示、クリックで戻る) | 実装済み |
| 視聴停止ボタン | Nexus (コントロールバー終話ボタン右に赤ボーダー+スラッシュアイコン、PiP はバツアイコン) | 実装済み |
| フォーカスビュー | Nexus (Discord Focus ビュー相当 — メンバー非表示+大画面最大化、ホバーでコントロールバー表示) | 実装済み |
| VC 右パネル状態保持 | Nexus (初回は Timeline 開く、2回目以降は保存状態を尊重) | 実装済み |
| VC チャットボタン | Nexus (ホバーでチャットアイコン、クリックで VC 未参加のまま会話表示) | 実装済み |
| E2EE 強制無効化 | Nexus (`shouldForceDisableEncryption()` 常時 true) | 実装済み |
| テキスト/VC チャンネル分離 | Nexus (NexusChannelListView) | 実装済み |
| VC 参加者グリッド | Nexus (JS 計算 + flexbox, 統一 16:9 パネル, 三角配置) | 実装済み |
| VC ポップアウトウィンドウ | Nexus Tauri (`on_new_window` + `createPortal`, FOUC 防止, 戻すボタン) | 実装済み |
| 個別音量調整 | Nexus (NexusParticipantContextMenu, localStorage 永続化) | 実装済み |
| 画面共有個別音量調整 | Nexus (NexusScreenShareContextMenu, localStorage 永続化) | 実装済み |
| 画面共有音声 Web Audio ルーティング | Nexus (MediaStreamAudioSourceNode → GainNode → masterGain) | 実装済み |
| VC 接続/切断トランジション | Nexus (スピナー+グレーアウト、再参加ブロック) | 実装済み |
| 入力/出力音量調整 | Nexus (Web Audio API GainNode) | 実装済み |
| 入力感度（ボイスゲート） | Nexus (AnalyserNode + GainNode) | 実装済み |
| 発話検出 | Nexus (ローカル: inputLevel / リモート: LiveKit isSpeaking) | 実装済み |
| 画面共有 SE | Nexus (screen-on/screen-off、自分・他者共通) | 実装済み |
| ミュート状態保持 | Nexus (VC中ミュート→切断後も維持) | 実装済み |
| 音声タイミング同期 | Nexus (Connected と同時に unmutePipelines()) | 実装済み |
| Ping/遅延表示 | Nexus (RTCPeerConnection.getStats) | 実装済み |
| ネイティブ画面キャプチャ | Nexus Tauri (WGC + WASAPI, カスタムピッカー) | 実装済み |
| プロセス単位オーディオ | Nexus Tauri (WASAPI INCLUDE モード — 共有アプリの音だけ) | 実装済み |
| VC 経過時間表示 | Nexus (NotificationDecoration に経過時間テキスト表示) | 実装済み |
| VC アクティブハイライト | Nexus (参加者がいる VC の緑アイコン + 緑縦ライン) | 実装済み |
| アプリ自動更新 UI | Nexus Tauri (NexusUpdateDialog — プログレスバー付きモーダル) | 実装済み |
| 起動時状態復元 | Nexus (前回のスペース・チャンネルを復元、初回はホーム) | 実装済み |
| 日本語翻訳 88% | Nexus (ja.json に306件追加、設定画面・トースト・通話UI等) | 実装済み |
| 更新確認→アップデートボタン | Nexus (UpdateCheckButton — 更新検知でボタン切替) | 実装済み |
| ユーザー指定の表示名カラー | Nexus (NexusUserColorStore + lk-jwt-service, 20色プリセット + HEX 入力) | 実装済み |

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
│      │ User Panel   ├──────────────────────────┤            │
│      │ 🟢 通話中   │  [メッセージ入力欄]       │            │
│      │ ──────────── │                           │            │
│      │ 🎤 ⚙️       │                           │            │
└──────┴──────────────┴──────────────────────────┴────────────┘
```

### 各エリアの詳細

#### Server Bar（左端）
- **コンポーネント**: `SpacePanel`
- Space = Discord の「サーバー」に対応
- ドラッグ&ドロップでスペースの並び替えが可能（`@hello-pangea/dnd`）

#### Channel List（左サイドバー）
- **コンポーネント**: `NexusChannelListView`
- テキストチャンネル（`#` アイコン）とボイスチャンネル（スピーカーアイコン）を視覚的に分離
- VC チャンネルの下に参加者リストをリアルタイム表示（`VoiceChannelParticipants`）
- 参加者がいる VC: スピーカーアイコン緑化 + 経過時間表示 + 左端に緑縦ライン
- VC チャンネルホバー時: チャットアイコンボタン表示（クリックで VC 未参加のままルームビュー+チャットパネルを開く）
- VC チャンネル名クリック: VC に参加（接続済み時はルームビューを開く）
- VC 未参加時のルームビュー: 「ボイスチャンネルに参加していません」+「参加」ボタン

#### User Panel（左サイドバー最下部）
- **コンポーネント**: `NexusUserPanel`
- `mx_NexusUserPanel_content` 内に以下を縦方向に配置:
  - **Call Status Panel** (`NexusCallStatusPanel`): 通話中のみ表示、ボーダー区切り線で分離
    - 接続中: 黄色パルスドット +「接続中…」
    - 通話中: 緑丸 + ルーム名 + 終話ボタン
    - 未接続: 非表示
  - **プロフィール行** (`mx_NexusUserPanel_row`): アバター + 表示名 + マイクミュートボタン + 設定ボタン

#### Message Area / VC Room View（中央）
- テキストチャンネル: `RoomView`（メッセージタイムライン）
- VC チャンネル: `NexusVCRoomView`（参加者グリッド + コントロールバー + タイムライン）
  - spotlight/grid 切替対応
  - 画面共有時は自動で spotlight モードに切替
  - フォーカスビュー（Discord Focus ビュー相当）:
    - 「メンバーを非表示」でボトムバー+コントロールバーを非表示、大画面を全体に拡大
    - 拡大中はホバーでコントロールバー+「メンバーを表示」ボタンが下部にフェード表示
    - 視聴停止ボタンはコントロールバー内（終話ボタン右、赤ボーダー+スラッシュアイコン）
  - グリッドモード: JS 計算（`calculateGridLayout`）+ flexbox で最適列数とパネルサイズを決定
    - 全パネル統一 16:9（画面共有は黒余白で `object-fit: contain`）
    - 縦に十分なスペースがあれば1列優先、奇数個は最終行中央寄せ（三角配置）
  - ポップアウト: Tauri `on_new_window` で別ウィンドウ表示、「元に戻す」ボタンで復帰

#### Member List（右サイドバー）
- ロール別にグルーピング
- オンライン/オフライン状態の表示

## VC アーキテクチャ

```
NexusVoiceStore (シングルトン)
  └─ NexusVoiceConnection
       ├─ Web Audio API パイプライン（入力）
       │    ├─ AudioContext（livekitRoom.connect() より前に生成）
       │    ├─ MediaStreamSource (マイク入力)
       │    ├─ [RnnoiseWorkletNode (ノイズキャンセリング、任意)]
       │    ├─ AnalyserNode (入力レベル監視、50ms ポーリング)
       │    ├─ GainNode (入力音量調整 + ボイスゲート)
       │    └─ MediaStreamDestination → 処理済みトラック
       ├─ Web Audio API パイプライン（出力）
       │    ├─ per-participant: MediaStreamAudioSourceNode → GainNode → masterGain
       │    ├─ per-screenshare: MediaStreamAudioSourceNode → GainNode → masterGain
       │    ├─ outputMasterGain → audioContext.destination
       │    ├─ MediaStream 参照を Map で保持（GC 防止）
       │    └─ 音量は localStorage に永続化（userId ベース）
       ├─ LiveKit Room (livekit-client)
       │    ├─ 処理済みオーディオトラック (GainNode 経由)
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

### 音声タイミング同期

接続中は入出力パイプラインをミュートし、UI のグレーアウト解除と同時に音声通信を開始する:

```
connect() Phase 2: outputMasterGain.gain = 0  ← 出力ミュート
connect() Phase 3: livekitRoom.connect()       ← LiveKit 接続（音声は流れるが聞こえない）
connect() Phase 4: inputGainNode.gain = 0      ← 入力ミュート
connect() Phase 5: connectionState = Connected ← UI グレーアウト解除
joinVoiceChannel(): pre-mute 適用
joinVoiceChannel(): unmutePipelines()          ← 入出力 gain を設定値に復元
joinVoiceChannel(): join SE 再生
```

- `unmutePipelines()`: `outputMasterGain` を設定値に、`inputGainNode` をミュートでなければ設定値に復元
- ミュート中の場合は `inputGainNode` を 0 のまま維持

### ミュート状態保持

VC 中にマイクミュートして切断した場合も、ミュート状態を維持する:
- `leaveVoiceChannel()` で disconnect 前に `_preMicMuted = connection.isMicMuted` で同期
- 次回接続時に `_preMicMuted` が true なら `setMicMuted(true)` を適用

### SE（効果音）タイミング
- **入室**: ボタン押下時に standby SE → 接続確立時に join SE（`joinVoiceChannel` で明示再生）
- **退室**: ボタン押下時に leave SE → スピナー+グレーアウト表示 → 切断完了後にリストから削除
- **他ユーザー入退室**: LiveKit ParticipantConnected/Disconnected イベント時に join/leave SE
  - MatrixRTC MembershipsChanged より先に発火するため、LiveKit イベントが正しいトリガーポイント
- **ミュート/アンミュート**: トグル時に mute/unmute SE
- **画面共有開始**: screen-on SE（`updateScreenShares()` で新規 identity 検出時）
- **画面共有終了**: screen-off SE（`updateScreenShares()` / `onTrackUnsubscribed` で identity 消失時）

### 音声設定（設定 → 音声・ビデオ）
2カラムレイアウト（左:入力 / 右:出力）:
- **入力デバイス**: マイク選択ドロップダウン
- **マイク音量** (0-200%): Web Audio API GainNode で入力音量調整
- **自動ゲイン**: ブラウザの AGC トグル
- **出力デバイス**: スピーカー選択ドロップダウン
- **スピーカー音量** (0-200%): Web Audio API `outputMasterGain` で全リモート音声一括調整（画面共有音声含む）

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
| 「画面を視聴する」クリック | `setScreenShareWatching(id, true)` → スポットライトに表示 |
| 視聴中にホバー | 「視聴を停止」オーバーレイ表示 → クリックで視聴解除 |
| VC ルーム外で視聴中 | PiP ウィンドウ表示（右下バツアイコンで停止、クリックで VC に戻る） |
| 画面共有が終了 | `onTrackUnsubscribed` が `watchingScreenShares` から自動削除 |

- **state**: `NexusVoiceConnection.watchingScreenShares: Set<string>` — 視聴中の画面共有者の `participantIdentity`（コンポーネントローカルではなく connection に保持し、ルーム移動しても維持）
- **フック**: `useNexusWatchingScreenShares()` — `CallEvent.WatchingChanged` を購読して watching state をリアクティブに返す
- **音声オプトイン**: `onTrackSubscribed` で ScreenShareAudio の gain を未視聴時は 0 に設定。視聴開始で `setScreenShareWatching(id, true)` → gain 復元
- **PiP**: `PipContainer` が `NexusVoiceStore` の接続変更 + `ScreenShares`/`WatchingChanged` イベントを購読し、VC ルーム外で視聴中の画面共有を `NexusScreenSharePip` で表示
- **個別音量**: 画面共有タイル右クリックで `NexusScreenShareContextMenu` 表示（`setScreenShareVolume()`）
- **音量永続化**: `localStorage` に userId ベースで保存、再接続時に自動復元
- **SpotlightLayout / GridLayout** 両方で同じ UX

### ネイティブ画面キャプチャ（Tauri）

映像: Windows Graphics Capture (WGC)、音声: WASAPI Process Loopback

| 共有タイプ | 映像 | 音声モード | 動作 |
|-----------|------|-----------|------|
| ウィンドウ | WGC (HWND) | INCLUDE (`target_process_id` = アプリの PID) | そのアプリの音だけキャプチャ |
| モニター | WGC (HMONITOR) | EXCLUDE (`target_process_id` = 0 → Nexus の PID) | 全システム音（Nexus 除く） |

- **Initialize フラグ**: `LOOPBACK | EVENTCALLBACK | AUTOCONVERTPCM`（Microsoft 公式 ApplicationLoopback サンプル準拠）
- **フォーマット**: PCM 16bit / 48kHz / stereo
- **ターゲット切替**: `switch_capture_target` で WGC + WASAPI を同時に新ターゲットへ切替
- **制限**: 同一プロセスの複数ウィンドウ（例: Firefox PiP×2）の音声は分離不可（Windows API の制約）

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

### VC 接続/切断トランジション UI

| 状態 | 参加者リスト表示 | 操作ブロック |
|------|------------------|-------------|
| Connecting | 自分をスピナー + opacity 0.5 で表示 | VC クリック無効 |
| Connected | 通常アバター表示、グレーアウト解除 | — |
| Disconnecting | 自分をスピナー + opacity 0.5 で表示 | VC クリック無効 |
| Disconnected | リストから削除 | — |

- **`useVCParticipants`**: `ConnectionState` を購読し `transitioningIds: Set<string>` を返す
- **`VoiceChannelParticipantItem`**: `isTransitioning` 時にアバターを `InlineSpinner` に差替え
- **`leaveVoiceChannel`**: `disconnect()` 完了まで await（Disconnecting 中は connection を保持）
- **`joinVoiceChannel`**: Connecting/Disconnecting 中は早期 return で再参加をブロック
- **Connected 直後の名前消え防止**: `conn.participants` に自分がまだいない場合も明示的に追加

### VC 参加者リストの精度保証

VC 参加者リスト（チャンネルサイドバー、参加者グリッド）は、接続状態に応じて 2 つのデータソースを使い分ける:

| 状態 | データソース | 更新契機 |
|------|-------------|---------|
| 接続中 | `NexusVoiceConnection.participants`（LiveKit + MatrixRTC マージ） | LiveKit `ParticipantConnected/Disconnected` イベント（即時） |
| 未接続 | `session.memberships`（MatrixRTC sticky event） | `MembershipsChanged` イベント + 30s ポーリング |

#### Ghost（幽霊参加者）対策

MatrixRTC の `m.call.member` (MSC4143) は sticky state event であり、以下の理由で ghost が発生する:
- ブラウザクラッシュ等の unclean disconnect で `leaveRoomSession()` が呼ばれない
- サーバー（matrix.org）の TTL 削除（60分）が遅延する場合がある
- `isExpired()` がクライアント側では常に `false`

対策は 3 層:

1. **起動時クリーンアップ** (`CallStore.cleanupStaleMatrixRTCMemberships`): ログイン後に全ルームをスキャンし、自分のデバイスの stale membership を `leaveRoomSession()` で削除
2. **イベント駆動クリーンアップ** (`CallStore.onMembershipsChangedForCleanup`): `MembershipsChanged` イベント発火時に、membership があるルームで自分が未接続なら stale と判定して削除
3. **30s ポーリング** (`useVCParticipants`): 未接続時に 30 秒ごとに `session.memberships` を再読みし、サーバーの TTL 削除反映遅延をカバー

#### Discord との比較

| 観点 | Discord | Nexus (現状) |
|------|---------|-------------|
| 参加状態の管理 | Gateway `VOICE_STATE_UPDATE`（サーバー集中管理、インメモリ） | MatrixRTC `m.call.member` sticky state event（分散、永続化） |
| クラッシュ検出 | WebSocket 切断を即座に検出（heartbeat OP 1） | 検出不可。サーバー TTL（60分）待ちまたはクライアント再起動時クリーンアップ |
| 参加通知遅延 | ~200-500ms（Gateway push） | ~1-5s（Matrix sync + state event 反映） |
| 離脱通知遅延 | ~100-300ms（WebSocket close → state 即削除） | 正常: ~2s / クラッシュ: 最大60分（TTL 依存） |
| Ghost 耐性 | 極めて高い（heartbeat + ephemeral state） | 中程度（3層対策で軽減するが、他人の ghost は TTL 依存） |

**根本的な差**: Discord は voice state をサーバーメモリ上のエフェメラルデータとして管理し、WebSocket 切断で即座に消える。MatrixRTC は分散プロトコルのため state event が永続化されており、クライアント主導の削除が必要。

**Nexus で対処不可能な点**: 他人のクラッシュ後の ghost は、そのユーザーのクライアント（または matrix.org の TTL）が membership を削除するまで残る。Discord のようなサーバー主導の即時削除は Matrix プロトコルの設計上不可能。

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
| E2E 暗号化 | `shouldForceDisableEncryption()` で強制無効化 + アイコン要素完全削除 |

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
