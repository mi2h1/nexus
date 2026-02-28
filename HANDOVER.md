# Nexus プロジェクト - セッション引継書

## 現在の状態

### 直近の作業（2026-03-02）

**ユーザー指定の表示名カラー（v0.2.11）**
- 各ユーザーが自分の表示名色を選択可能に（Discord のロールカラーに相当）
- サーバー側: lk-jwt-service に `GET /user-colors` + `PUT /user-color` エンドポイント追加
- クライアント側: `NexusUserColorStore` シングルトン + `getUserNameColorStyle()` ユーティリティ
- UI: 設定 > アカウントに20色プリセット + HEX 自由入力のカラーピッカー
- `ColorsChanged` イベントで DisambiguatedProfileViewModel / ReplyChain / PinnedEventTile が即時再レンダリング
- Tauri: `corsFreeGet` / `corsFreePut` を追加

**VC 音声・画面共有の品質改善（v0.2.8-v0.2.10）**
- 画面共有音声を Web Audio パイプライン経由に変更（Tauri で >100% 音量対応）
- LiveKit PLI throttle 短縮（`high_quality: 3s → 1s`）
- Opus DTX 無効化 — 機械音・ロボット音の発生を防止
- 画面共有ピッカー: キャプチャ中サムネイルキャッシュ

### 未解決・次回やること

1. **RNNoise worklet 読み込み失敗（Tauri）** — `AbortError: Unable to load a worklet's module`。WebView2 で AudioWorklet のモジュールロードに制限がある可能性。フォールバック済み（ノイキャンなし）
2. **Win10 画面共有テスト** — 1名が画面共有できない問題、Win10 環境での検証待ち
3. **Chrome (Mac) でVCに入れない** — `NotFoundError: Requested device not found`。macOS のマイク権限問題
4. **システムトレイ常駐** — 閉じてもバックグラウンド動作
5. **日本語翻訳 残り415件** — `devtools`(75), `encryption`(59), `auth`(39), `right_panel`(28) 等
6. **画面共有 200% 音量テスト** — Tauri で Web Audio パイプライン経由の画面共有音声増幅を実装済み、動作確認済み

---

## プロジェクト概要

**Nexus** は Element Web（Matrix クライアント）のフォークで、Discord 風の機能構成にカスタマイズしたチャットアプリ。

- **リポジトリ**: https://github.com/mi2h1/nexus.git
- **Web版**: https://mi2h1.github.io/nexus/
- **ユーザー規模**: 10人以下のプライベート利用
- **優先順位**: 動作する > 見た目が良い > 速度が速い

---

## アーキテクチャ

```
GitHub Actions → GitHub Pages (Web版)
GitHub Actions → Tauri 2 ビルド → Windows/Mac ネイティブアプリ

Matrix サーバー: matrix.org（公開サーバー利用）
SFU: 自前 LiveKit (lche2.xvps.jp) ← 2026-02-25 構築
  フォールバック: Element の LiveKit Cloud (CORS プロキシ経由)
```

### VPS (lche2.xvps.jp / 162.43.31.143)
- AMD EPYC 3コア / 3.8GB RAM / 28GB ディスク
- **Docker コンテナ** (3つ): `infra/livekit/docker-compose.yml` で管理
  - `nexus-livekit` — LiveKit SFU (WebRTC メディア中継)
  - `nexus-jwt` — lk-jwt-service (Matrix OpenID → LiveKit JWT 変換 + ユーザーカラー保存、カスタムビルド + ユーザーホワイトリスト)
  - `nexus-nginx` — TLS 終端 (Let's Encrypt)
- **ポート**: 7880(WSS), 7881(TCP TURN), 7882(UDP WebRTC), 7891(HTTPS JWT)
- **SSL 証明書**: `/etc/ssl/lche2/` (fullchain.pem + privkey.pem)
- **設定ファイル**: `infra/livekit/` (docker-compose.yml, livekit.yaml, nginx.conf)
- **セットアップ手順**: [docs/server-migration.md](./docs/server-migration.md)
- 開発環境: Claude Code でコード編集 → git push

---

## 技術スタック

| 技術 | 用途 |
|------|------|
| Element Web (フォーク) | ベースの Matrix クライアント |
| React + TypeScript | UI |
| matrix-js-sdk | Matrix プロトコル + MatrixRTC シグナリング |
| livekit-client | VC・画面共有（SFU 直接接続） |
| Tauri 2 | ネイティブデスクトップアプリ（src-tauri/） |
| LiveKit SFU | 自前ホスト（lche2.xvps.jp, Docker） |
| lk-jwt-service | Element製 JWT ブリッジ（OpenID → LiveKit JWT）+ ユーザーカラー保存 |
| Cloudflare Workers | CORS プロキシ（フォールバック用） |
| pnpm 10.x | パッケージマネージャ |
| nx + Webpack | ビルド |
| GitHub Actions | CI/CD |

---

## Nexus カスタムファイル（主要）

### ストア
- `src/stores/NexusUpdateStore.ts` — Tauri 自動更新管理（ダウンロード進捗、インストール状態）
- `src/stores/NexusUserColorStore.ts` — ユーザーカラー管理（lk-jwt-service 連携、色の取得・キャッシュ・設定）

### VC コア
- `src/models/NexusVoiceConnection.ts` — LiveKit 直接接続 + MatrixRTC + Web Audio パイプライン
- `src/stores/NexusVoiceStore.ts` — VC 接続管理シングルトン
- `src/hooks/useNexus*.ts` — VC 関連カスタムフック

### VC UI
- `src/components/views/voip/NexusVC*.tsx` — VC ルームビュー関連
- `src/components/views/voip/NexusVCPopout.tsx` — ポップアウトウィンドウ（createPortal）
- `src/components/views/rooms/RoomListPanel/Nexus*.tsx` — チャンネルリスト・ユーザーパネル

### Tauri
- `src-tauri/` — Rust バックエンド（`on_new_window` でポップアウトウィンドウ管理）
- `src/vector/platform/TauriPlatform.ts` — Tauri 2 プラットフォーム（SW は親の WebPlatform に委譲）
- `src/utils/tauriHttp.ts` — Tauri 判定 + CORS-free fetch
- `src/utils/popoutStyles.ts` — ポップアウトウィンドウへの CSS 転送

### インフラ
- `infra/livekit/docker-compose.yml` — LiveKit SFU Docker構成
- `infra/livekit/livekit.yaml` — LiveKit SFU 設定
- `infra/livekit/nginx.conf` — TLS 終端 + CORS

---

## VC ポップアウト設計（重要）

### フロー
```
1. ユーザーがポップアウトボタンをクリック
2. window.open("popout.html", "_blank", "width=480,height=640")
3. Rust on_new_window → WebviewWindowBuilder("vc-popout") + .window_features(features) + .visible(false)
4. NewWindowResponse::Create { window } → WebView2 が Tauri 管理ウィンドウを使用
5. JS: setupChild() → about:blank をスキップ → 背景色設定 + FOUC 防止オーバーレイ作成
6. JS: invoke("plugin:window|show") → ウィンドウ即座表示（オーバーレイが覆うので未スタイルは見えない）
7. copyStylesToChild() + setPortalContainer() → ReactDOM.createPortal() で描画
8. スタイルシート読み込み完了（or 500ms タイムアウト）→ オーバーレイ除去
```

### アーキテクチャ
- ポップアウト状態は `NexusVoiceStore` が管理（`getPopoutWindow()` / `setPopoutWindow()`）
- `NexusVCPopoutContainer`（`LoggedInView` 内、常時マウント）がポップアウトを描画
- `NexusVCRoomView` はストアの状態を参照してポップアウトボタンの表示/非表示を制御
- `PipContainer` はポップアウト時に画面共有 PiP を抑制

### クローズ検出
- `pagehide` / `unload` イベント + `setTimeout` + `child.closed` チェック（ナビゲーション偽陽性防止）
- `child.closed` ポーリング（500ms、フォールバック）
- 通話切断時: `NexusVoiceStore.leaveVoiceChannel()` → `invoke("plugin:window|close", { label: "vc-popout" })`

### Strict Mode 対策
- cleanup で `setTimeout(0)` で deferred close（closeTimerRef に保存）
- remount で `clearTimeout(closeTimerRef.current)` でキャンセル
- 実際のアンマウント: timeout が発火しウィンドウを閉じる

### SW 認証（ポップアウト WebView）
- ポップアウトは `popout.html`（SW スコープ内）を開くため、SW がメディアリクエストをインターセプト可能
- ポップアウト WebView には `WebPlatform` のメッセージハンドラーがないため、SW の `postMessage` がタイムアウト
- `askClientForUserIdParams()` がフォールバックで `clients.matchAll()` → メインウィンドウに問い合わせ
- MutationObserver で `loading="lazy"` の img を `eager` に強制（WebView2 の Radix Avatar 対策）

---

## VC 音声パイプライン設計（重要）

### 入力（マイク）
```
getUserMedia → LocalAudioTrack
  → MediaStreamSource → [RNNoise] → HPF(80Hz) → Compressor
  → Analyser (遅延なし、即時レベル検出)
  → DelayNode(50ms) → InputGainNode → MediaStreamDestination → publish to LiveKit
```
- AudioContext はユーザージェスチャー内（await 前）に生成必須
- ミュートは `inputGainNode.gain.value = 0`（LiveKit の track.mute() は使わない — Firefox で壊れるため）

### 出力（リモート音声）
- per-participant `<audio>` 要素 + Web Audio API で再生
- ブラウザ: `audio.volume` で音量制御（0-1）
- Tauri: `createMediaStreamSource(MediaStream)` → per-participant GainNode → outputMasterGain(0-2.0) → destination（>100% 増幅対応）

### 画面共有音声（受信側）
- 映像+音声: 同一 `MediaStream` に統合し `<video>` 1要素で再生（ブラウザの A/V 同期に委任）
- 音量制御: `videoEl.volume` で直接制御（Web Audio 経由ではない — RTCP SR 同期を維持）

---

## SFU 接続フロー

```
Phase 0: AudioContext 生成（同期、ユーザージェスチャー内）
Phase 1: Promise.all([getJwt(), createLocalAudioTrack(), preloadRnnoiseWasm()])
  └─ getJwt():
     ├─ getCachedOpenIdToken() — キャッシュヒット時は matrix.org スキップ
     ├─ 優先: 自前 JWT サービス (https://lche2.xvps.jp:7891/sfu/get)
     └─ フォールバック: Element の JWT via CORS プロキシ
Phase 3+4: 並列実行
  ├─ livekitRoom.connect(url, jwt) — wss://lche2.xvps.jp:7880
  └─ buildInputPipeline() — AudioNode + RNNoise + MediaStreamDestination
Phase 5: publishTrack(processedTrack)
```

---

## 進捗

- Phase 1（環境構築）: ✅ 完了
- Phase 2（Discord風UIカスタマイズ）: ✅ 完了
- Phase 2.5（通話機能内包）: ✅ 完了
- Phase 3（Tauri 2 ネイティブ化）: ✅ 基本実装完了（v0.2.11）
- 自前 SFU: ✅ 構築完了、ブラウザ版動作確認済み
- VC ポップアウト: ✅ 実装完了（Tauri `NewWindowResponse::Create` 方式）

### ロードマップ
詳細は `docs/progress.md` 参照。

---

## 開発ルール

- **コミットメッセージは日本語** — `docs/conventions.md` 参照
- **ビルドは GitHub Actions** — VPS でビルドしない
- **pnpm 10.x** — npm/yarn は使わない
- **tsc --noEmit** には `NODE_OPTIONS="--max-old-space-size=4096"` 必要
- **ブランチ**: main のみ（upstream/develop で element-web 追跡）
- **破壊的変更は事前確認** — 影響範囲と代替案を提示

### Tauri リリース手順

1. コミット → `git tag vX.Y.Z` → `git push && git push origin vX.Y.Z`
2. GitHub Actions `tauri-release` が自動でビルド → GitHub Release 作成
3. バージョンはタグ名から自動注入（`tauri.conf.json` / `Cargo.toml` の手動更新不要）
4. ビルド成功後、`update-version` ジョブが `tauri.conf.json` / `Cargo.toml` のバージョンを main に自動コミット
5. アプリの自動更新が `latest.json` を参照して新バージョンを検出 → ダウンロード＆再起動

### Web 版リリース手順

1. main にプッシュすると `pages.yml` が自動デプロイ
2. ビルド時に `git describe --tags --always` で VERSION を決定（`/version` ファイルに書き出し）
3. 既存ユーザーのブラウザが 10 分ポーリングで `/version` の変化を検知 → アップデートトースト表示
- **Discord Docs 参照** — 真似できる部分、超えられる部分は積極的に実装

---

## 参考ドキュメント

- [CLAUDE.md](./CLAUDE.md) — AI アシスタント指示
- [docs/conventions.md](./docs/conventions.md) — 開発規約
- [docs/progress.md](./docs/progress.md) — 進捗・ロードマップ
- [docs/tech-stack.md](./docs/tech-stack.md) — 技術スタック詳細
- [docs/app-spec.md](./docs/app-spec.md) — アプリ仕様・UI設計
- [docs/vc-optimization.md](./docs/vc-optimization.md) — VC 接続高速化・SFU 計画
- [docs/server-migration.md](./docs/server-migration.md) — VPS セットアップ・移行手順
- [docs/native-capture-plan.md](./docs/native-capture-plan.md) — ネイティブ画面キャプチャ計画
