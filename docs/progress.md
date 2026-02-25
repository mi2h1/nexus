# 進捗・作業ログ — progress.md

> 最終更新: 2026-02-26

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
│   │   ├── useNexusParticipantStates.ts # 参加者状態フック
│   │   └── useNexusWatchingScreenShares.ts # 画面共有視聴状態フック
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
│           ├── NexusScreenSharePip.tsx  # 画面共有 PiP
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
│       ├── _NexusScreenSharePip.pcss
│       └── _NexusParticipantContextMenu.pcss
├── src-tauri/                  # Tauri 2 Rust バックエンド
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   ├── capabilities/default.json
│   └── src/{main,lib}.rs
├── config.json                 # アプリ設定（Nexus カスタム）
└── .github/workflows/
    ├── pages.yml               # GitHub Pages デプロイ
    └── tauri-release.yml       # Tauri ネイティブビルド + Release
```

## Phase 3: Tauri 2 ネイティブ化 🚧 進行中

### 実装済み
| 機能 | 実装 |
|------|------|
| Tauri 2 基本セットアップ | `src-tauri/` — Rust バックエンド + `tauri.conf.json` |
| TauriPlatform | `WebPlatform` 継承 + 自動更新（`tauri-plugin-updater`） |
| CORS バイパス | Tauri 時は `tauri-plugin-http` で直接 JWT 取得（プロキシ不要） |
| >100% ボリューム | `createMediaStreamSource()` → per-participant `GainNode` → master `GainNode`(0-2.0) |
| CI/CD | `tauri-release.yml` — `v*` タグで Windows ビルド + GitHub Release |
| webpack ポート固定 | devServer port 1420（Tauri devUrl 互換） |
| プラットフォーム検出 | `window.__TAURI_INTERNALS__` → `TauriPlatform` 自動選択 |
| ログイン画面修正 | ロゴ白色化 + 「Nexusにようこそ」テキスト |
| ネイティブ画面キャプチャ | WGC + WASAPI — カスタムピッカー + 音声キャプチャ |
| 画面共有ターゲット切替 | `switch_capture_target` — 配信中のウィンドウ切替（Discord 同等） |
| 画面共有ピッカー リアルタイム更新 | 2秒ポーリングでウィンドウリスト・サムネイル更新 |
| 画面共有 品質プリセット統合 | ピッカー内に4段階プリセット（480p15/720p30/1080p30/1080p60） |
| 音量制御修正 | `createMediaStreamSource` で Web Audio ルーティング（WebView2 対応） |

### ロードマップ

参考: [Discord Voice Connections Docs](https://docs.discord.com/developers/topics/voice-connections)
Discord の Docs で真似できる部分・超えられる部分は積極的に実装する方針。

#### 最優先: VC 接続高速化

| 施策 | 難易度 | 効果 | 状態 | 詳細 |
|------|--------|------|------|------|
| 自前 LiveKit SFU (日本VPS) | 中 | **~1秒短縮** | ✅ 完了 | [vc-optimization.md](vc-optimization.md) |
| パイプライン構築を connect() と並列化 | 低 | ~50-100ms | ✅ 完了 | `buildInputPipeline()` + `livekitRoom.connect()` 並列 |
| OpenID トークンキャッシュ | 低 | ~100-200ms (再接続時) | ✅ 完了 | `getCachedOpenIdToken()` — expires_in の 80% でキャッシュ |
| 起動時プリフェッチ | 低 | 初回接続の cold-start 排除 | ✅ 完了 | `prefetch()` — RNNoise WASM + OpenID トークンを login 後に先行取得 |
| 切断即時化 | 低 | 切断 ~0ms（体感即座） | ✅ 完了 | `leaveRoomSession` + `livekitRoom.disconnect` を fire-and-forget |
| LiveKit reconnect() | 低 | 再接続時大幅短縮 | 未着手 | Discord の Resume に相当 |
| マイク権限の事前取得 | 低 | 初回 ~300ms | 未着手 | VC パネル表示時に先行 getUserMedia |

#### 高優先: ネイティブアプリ体験 (Tauri)

| 施策 | 難易度 | 効果 | 状態 | 詳細 |
|------|--------|------|------|------|
| ネイティブ画面キャプチャ Step 1 | 高 | 共有バー消去、カスタムピッカー | ✅ 完了 | WGC + WASAPI + カスタムピッカー |
| ネイティブ画面キャプチャ Step 2 | 高 | 画面共有に音声追加 | ✅ 完了 | WASAPI 通常ループバック |
| 配信中ターゲット切替 | 中 | Discord 同等のウィンドウ切替 | ✅ 完了 | `switch_capture_target` Rust コマンド |
| ネイティブ画面キャプチャ Step 3 | 高 | VC 声のループ防止 | 未着手 | WASAPI プロセス除外 |
| システムトレイ常駐 | 低 | 閉じてもバックグラウンド動作 | 未着手 | `TrayIconBuilder` API |
| Windows 自動音量低下バイパス | 中 | 通話中に他アプリの音量が下がらない | 未着手 | Windows API auto-ducking 無効化 |

#### 中優先: 音声品質

| 施策 | 難易度 | 効果 | 状態 | Discord 比較 |
|------|--------|------|------|-------------|
| AGC（自動ゲイン制御） | 低 | マイク音量の自動調整 | 未着手 | Discord 標準搭載 |
| VAD 改善 | 低 | RNNoise の VAD 出力を活用 | 未着手 | Discord は Krisp |
| スピーカーミュート（デフ） | 低 | 出力を一括ミュート | 未着手 | Discord 標準搭載 |
| Opus 動的ビットレート | 中 | 接続品質に応じて 32〜128kbps | 未着手 | Discord 実装済み |
| DTLN ノイズキャンセリング | 高 | RNNoise より高品質な NC | 未着手 | Discord は Krisp (有料級) |
| エコーキャンセレーション強化 | 高 | スピーカー利用時のエコー除去 | 未着手 | |

#### 低優先: UI/UX 改善

| 施策 | 難易度 | 効果 | Discord 比較 |
|------|--------|------|-------------|
| VC 品質インジケーター | 低 | ping, ビットレート, コーデック表示 | Discord: 接続情報パネル |
| ユーザーステータス | 中 | オンライン/退席中/取り込み中/オフライン | Discord 標準搭載 |
| キーバインド設定 | 中 | ミュートキー等のカスタマイズ | Discord 標準搭載 |
| 配信モード | 中 | 個人情報を隠す | Discord Streamer Mode |

#### 将来: 基盤

| 施策 | 難易度 | 効果 | 備考 |
|------|--------|------|------|
| Matrix ホームサーバー自前 (Conduit) | 中 | チャットも自前インフラ | matrix.org 依存ゼロ |
| Rust UDP 高速パス (Tauri) | 高 | ICE/DTLS 完全スキップ | Discord 方式。根本改善 |
| WebTransport/MoQ | 高 | ブラウザ版も ICE 不要 | 仕様策定中 |

---

## Phase 2.5: 通話機能の内包 ✅ 完了

> Element Call の iframe 方式を廃止し、livekit-client を Nexus 本体に直接組み込み済み。

### 実装済み機能
| 機能 | 実装 |
|------|------|
| VC 接続/切断 | `NexusVoiceConnection` — LiveKit 直接接続 + MatrixRTC シグナリング |
| VC 接続高速化 | `connect()` で JWT取得+マイクアクセス+WASMプリロードを並列実行 + パイプライン/connect 並列化 + OpenID キャッシュ |
| マイクミュート | `setMicMuted()` — `mediaStreamTrack.enabled` 直接操作（非publish トラック経由） |
| 画面共有 | `startScreenShare()/stopScreenShare()` — `getDisplayMedia()` + 720p30/simulcast エンコーディング |
| 画面共有オプトイン視聴 | Discord 準拠 — 他者の画面共有はプレビュー+「画面を視聴する」クリックで表示 |
| 画面共有 PiP | VC ルーム外で視聴中の画面共有を PiP ウィンドウ表示（クリックで VC に戻る） |
| 視聴停止ボタン | ScreenShareTile ホバーで「視聴を停止」オーバーレイ、PiP はホバーで右下バツアイコン |
| 視聴状態の永続化 | watching state を NexusVoiceConnection に移行（ルーム移動しても視聴状態維持） |
| VC 右パネル状態保持 | 初回訪問は Timeline を開く、2回目以降はユーザーの開閉状態を保持 |
| Ping/遅延表示 | `RTCPeerConnection.getStats()` → `currentRoundTripTime` |
| 個別音量調整 | `setParticipantVolume()` — Web Audio API GainNode（localStorage 永続化） |
| 画面共有個別音量調整 | `setScreenShareVolume()` — Web Audio API GainNode（localStorage 永続化） |
| 画面共有音声 Web Audio ルーティング | ScreenShareAudio を Web Audio パイプライン経由で再生（マスター音量連動） |
| 画面共有音声オプトイン | 視聴ボタン押下まで gain=0、視聴開始で音声開通 |
| VC 接続/切断トランジション UI | 接続中/切断中に参加者リストで自分をスピナー+グレーアウト表示 |
| 入力音量調整 | Web Audio API `GainNode` — 0-200% スライダー |
| 出力マスター音量 | `setMasterOutputVolume()` — 全リモート参加者の受信音量一括調整 |
| 入力感度（ボイスゲート） | `AnalyserNode` RMS 計測 → 閾値以下で `GainNode.gain=0`（300ms リリース遅延） |
| 発話検出 | ポーリング方式（250ms）— ローカルは自前 `inputLevel>5` / リモートは LiveKit `isSpeaking` |
| 画面共有 SE | 画面共有開始/終了時に screen-on/screen-off SE（自分・他者共通） |
| 入退室 SE | 押下時 standby SE → 接続確立時 join SE → 退室時 leave SE |
| ミュート状態保持 | VC 中ミュート→切断後もミュート状態を維持（`_preMicMuted` 同期） |
| 音声タイミング同期 | 接続中は入出力 gain=0、Connected 後に `unmutePipelines()` で復元 |
| VC 参加者グリッド | spotlight/grid 切替 + コントロールバー |
| 音声設定 UI | 入力/出力音量スライダー + 入力感度トグル/閾値 + リアルタイムレベルメーター |
| 設定画面マイクゲージ | VC 未接続時も独立した getUserMedia+AnalyserNode でレベルメーター動作 |
| CORS プロキシ | Cloudflare Workers 経由で LiveKit JWT を取得 |

---

## Phase 2: 機能カスタマイズ

### 完了したタスク

#### 2026-02-26 (VC 参加者リスト精度改善)
- **CallStore ghost cleanup の isCallRoom() フィルタ修正**: `onMembershipsChangedForCleanup` が Nexus の VC ルームをスキップしていたバグを修正
  - 原因: `room.isCallRoom()` は Element Call 専用ルームのみ `true` だが、Nexus は通常の Matrix ルームを VC に使うため全ルームがフィルタされていた
  - 修正: `isCallRoom()` チェックを `session.memberships.length === 0` に変更（membership がないルームをスキップし、全ルームスキャンのコストを回避）
  - 効果: unclean disconnect（ブラウザクラッシュ等）後の自分の ghost membership が正しくクリーンアップされるように
- **未接続時 30s ポーリング追加** (`useVCParticipants`): サーバーの sticky event TTL 削除タイミング遅延に対する安全策
  - `setInterval(30s)` で `session.memberships` を再読み（`MembershipsChanged` イベント欠落をカバー）
  - 接続中は LiveKit イベントで即時更新されるためポーリングをスキップ
  - cleanup で `clearInterval` を確実に実行

#### 2026-02-25 (VC 接続・切断高速化)
- **パイプライン構築を connect() と並列化**: `buildInputPipeline()` メソッドを新設
  - 入力パイプライン構築（ノード作成 + RNNoise AudioWorklet 登録）を `livekitRoom.connect()` と `Promise` で並列実行
  - WebSocket + ICE/DTLS ハンドシェイク中にパイプラインが完成するため ~50-100ms 短縮
- **OpenID トークンキャッシュ**: `getCachedOpenIdToken()` メソッドを新設
  - `getOpenIdToken()` の結果を `expires_in` の 80% でキャッシュ（静的変数、インスタンス間共有）
  - 再接続時に matrix.org へのラウンドトリップ (~100-200ms) を省略
- **起動時プリフェッチ**: `NexusVoiceConnection.prefetch()` を `MatrixChat.onClientStarted()` で呼出し
  - RNNoise WASM + OpenID トークンをログイン完了時に fire-and-forget でプリフェッチ
  - 初回 VC 接続の cold-start コスト（WASM DL + matrix.org RTT）を排除
- **切断即時化**: `disconnect()` の `leaveRoomSession()` と `livekitRoom.disconnect()` を fire-and-forget に変更
  - ローカルのオーディオ停止・ノード切断は同期で完了するため、UI は即座に Disconnected に遷移
  - MatrixRTC 離脱と WebSocket close はバックグラウンドで処理（失敗時は membership 自然タイムアウト + `clean()` で掃除）
- **合計効果**: 接続 ~600ms（初回も再接続も）、切断は体感即座

#### 2026-02-28 (画面共有ターゲット切替 + VC バグ修正)
- **pnpm 403 エラー修正（CI）**: `pnpm/action-setup@v4` に `standalone: true` を追加
  - npm レジストリからの fetch で 403 になる Windows ランナーの問題を回避
  - 全ワークフロー（tauri-check, tauri-release, pages）に適用
- **Rust `switch_capture_target` コマンド**: 配信中に画面キャプチャ対象を切替（Discord デスクトップ同等）
  - WGC キャプチャのみ停止→再開始（WASAPI 音声はシステム全体なので再起動不要）
  - `start_wgc_capture()` ヘルパーに抽出して `start_capture` と共有
- **画面共有ピッカー リアルタイム更新**: 2秒ポーリングで `enumerate_capture_targets` を再取得
  - ウィンドウリスト・サムネイルがピッカー表示中に自動更新
  - 選択中のアイテムが消えた場合は選択をリセット
- **画面共有ピッカー: 品質プリセット統合**: ピッカー内にプリセット行（480p15/720p30/1080p30/1080p60）を追加
  - プリセットパネル（`NexusScreenSharePanel`）をスキップし、ピッカー直接表示に変更
  - 選択したプリセットは SettingsStore に永続化
- **画面共有ピッカー: 切替モード**: `mode="switch"` でボタンレイアウト変更
  - 左: [共有を停止(赤)] [変更]、右: [キャンセル]
  - 音声トグル非表示（音声は切替で変わらないため）
- **コントロールバー配信ボタン分岐**: Tauri 配信中はピッカー表示 / ブラウザ配信中は即停止 / 未配信はピッカー表示
- **ミュート状態の後参加者への共有修正**: VC に後から参加した人にミュート状態が見えない問題を修正
  - 新規参加者接続時に自身のミュート状態を500ms遅延で再ブロードキャスト
  - 自身の接続完了時にも初期ミュート状態をブロードキャスト
- **VC 参加者リスト ログイン後表示修正**: ログイン後に一部参加者が表示されない問題を修正
  - 原因: `resolveIdentityToUserId()` が `room.getMember()` に依存、/sync 完了前は null
  - 修正: LiveKit identity 文字列 (`@user:server:device_id`) から userId を直接パース
  - `_participants` マップのキーを `RoomMember` → `string`(userId) に変更
  - `useVCParticipants` に `RoomStateEvent.Members` リスナー追加（/sync 完了時に RoomMember を遅延解決）
  - `VoiceChannelParticipants` で null member をプレースホルダーアバター表示に対応
- **Tauri 音量制御修正**: マスター音量・個別音量が効かない問題を修正
  - 原因: `createMediaElementSource()` が WebView2 で audio 要素の出力を Web Audio API に正しくリダイレクトしない
  - 修正: `createMediaStreamSource(MediaStream)` に切替（livekit-client の webAudioMix と同じアプローチ）
  - audio 要素は `volume=0` でシステム出力を抑制、MediaStream を直接 AudioContext に接続
  - 参加者音声と画面共有音声の両パスを統一

#### 2026-02-27
- **画面共有 PiP**: VC ルーム外で視聴中のリモート画面共有を PiP ウィンドウで表示
  - `NexusScreenSharePip` コンポーネント新規作成
  - `PipContainer` に `NexusVoiceStore` イベント購読 + PiP レンダリング統合
  - PiP クリックで VC ルームに戻る、ホバーで右下にバツアイコンボタン表示
  - `setState` 非同期問題対策: `updateNexusPipScreenShare()` に `viewedRoomId` を引数で渡す
- **視聴停止ボタン**: 画面共有タイルにホバーで「視聴を停止」オーバーレイ表示
  - `ScreenShareTile` に `onStopWatching` prop 追加
  - CSS `:hover` ベースの半透明オーバーレイ（React state 不要）
- **視聴状態の永続化**: watching state をコンポーネントローカルから NexusVoiceConnection に移行
  - `CallEvent.WatchingChanged` イベント追加（`Call.ts`）
  - `NexusVoiceConnection` に `watchingScreenShareIds` getter + `setScreenShareWatching()` で emit
  - `useNexusWatchingScreenShares` フック新規作成（connection の watching state を購読）
  - `NexusVCRoomView` の `useState<Set<string>>` → フックに置換、auto-cleanup effect 削除
- **VC 右パネル状態保持**: VC ルームの右パネル自動オープン条件修正
  - `RightPanelStore.currentCardForRoom()` で初回訪問（`phase === null`）を判定
  - 初回: Timeline を開く / 2回目以降: `isOpenForRoom()` で保存状態を尊重

#### 2026-02-26
- **画面共有 SE**: 画面共有の開始/終了時に screen-on/screen-off SE を再生
  - `updateScreenShares()` で前回リストとの差分比較（開始=added, 終了=removed）
  - `onTrackUnsubscribed` の直接フィルタリングパスでも screen-off SE を再生
  - 自分の開始/終了・他者の開始/終了どちらも同じパスで処理
- **入室 SE 修正**: `joinVoiceChannel()` で `connect()` 成功後に明示的に join SE 再生
  - `onMembershipsChanged` のカウント差分検出は self-inclusion fallback で不動作だった
- **ミュート状態保持修正**: VC 中ミュート→切断後もミュート状態を維持
  - `leaveVoiceChannel()` で disconnect 前に `_preMicMuted = connection.isMicMuted` で同期
- **音声タイミング同期**: グレーアウト解除と音声通信開始を同期
  - `connect()` 内で `outputMasterGain.gain.value = 0`、`inputGainNode.gain.value = 0` で作成
  - `unmutePipelines()` メソッド追加: Connected 後 + pre-mute 適用後に設定値に復元
  - ミュート中の場合は入力を 0 のまま維持
- **VCチャンネル要素スピナー削除**: チャンネルリスト右側のスピナーを削除
  - 参加者リストのアバター→スピナー差し替えに統一

#### 2026-02-25
- **画面共有音声 Web Audio ルーティング**: 画面共有の受信音声を Web Audio API パイプライン経由に変更
  - `MediaStreamAudioSourceNode` → per-share `GainNode` → `outputMasterGain` → destination
  - マスター出力音量が画面共有音声にも適用されるように
  - `MediaStream` 参照を Map に保持して GC による音声消失を防止
  - `AudioContext` を `livekitRoom.connect()` より前に生成（レースコンディション対策）
- **画面共有個別音量調整**: 画面共有タイル右クリックで音量スライダー表示
  - `NexusScreenShareContextMenu` を `NexusParticipantContextMenu.tsx` に追加
  - `setScreenShareVolume()` / `getScreenShareVolume()` API 追加
- **音量永続化**: 参加者音量・画面共有音量を `localStorage` に保存
  - userId ベースで保存（LiveKit identity はセッション間で変わる可能性があるため）
  - `onTrackSubscribed` 時に保存済み音量を自動復元
- **Firefox スライダー修正**: `hasBackground={false}` + `useClickOutside` フック
  - Firefox が range input ドラッグ中に mouse イベントをオーバーレイに発行する問題を回避
  - `setPointerCapture` は pointer events のみキャプチャし mouse events は漏れるため不採用
- **画面共有音声オプトイン**: 視聴ボタン押下前は音声をミュート
  - `watchingScreenShares` セットで視聴状態を管理
  - `onTrackSubscribed` で ScreenShareAudio の gain を未視聴時は 0 に設定
  - `setScreenShareWatching()` API で視聴開始/終了時に gain を制御
- **画面共有終了時のパネル残留修正**: 3重の対策
  - `onTrackUnsubscribed` で `_screenShares` から直接フィルタリング（publication の stale 参照問題を回避）
  - ScreenShare ビデオトラックの `ended` イベント監視
  - `onParticipantDisconnected` で `updateScreenShares()` も呼び出し
  - `updateScreenShares()` で `readyState === "ended"` なトラックを除外
- **テキスト統一**: 「共有中」→「配信中」に統一
- **VC 接続/切断トランジション UI**: Discord 風の接続状態表示
  - 参加ボタン押下 → 即座にリストに自分を表示（スピナー + opacity 0.5 グレーアウト）
  - 接続完了 → スピナーがアバターに切替、グレーアウト解除
  - 終話ボタン押下 → グレーアウト + スピナーに変化
  - 切断完了 → リストから消える
  - `useVCParticipants` で `ConnectionState` を購読し `transitioningIds` セットを返す
  - `leaveVoiceChannel` を `disconnect()` 完了まで await する方式に変更
  - 遷移中の再参加をブロック（`joinVoiceChannel` で Connecting/Disconnecting 中は return）

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
