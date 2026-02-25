# Nexus プロジェクト - セッション引継書

## 現在の状態

### 直近の作業（2026-02-25）

**VC 接続・切断の高速化**
- **パイプライン並列化** (`a2b8266`): `buildInputPipeline()` を `livekitRoom.connect()` と並列実行（~50-100ms 短縮）
- **OpenID キャッシュ** (`a2b8266`): `getCachedOpenIdToken()` で再接続時の matrix.org RTT 省略（~100-200ms 短縮）
- **起動時プリフェッチ** (`0845fde`): `prefetch()` でログイン後に RNNoise WASM + OpenID トークンを先行取得。初回接続の cold-start 排除
- **切断即時化** (`39b2570`): `leaveRoomSession()` + `livekitRoom.disconnect()` を fire-and-forget。ローカル処理のみ同期で即 Disconnected
- **結果**: 接続 ~600ms（初回・再接続とも）、切断は体感即座

**過去: 自前 LiveKit SFU セットアップ完了**
- VPS（lche2.xvps.jp）に Docker で LiveKit SFU を構築
- 3コンテナ: livekit-server + lk-jwt-service + nginx（TLS終端）
- ポート: 7880(WSS), 7881(TCP TURN), 7882(UDP WebRTC), 7891(HTTPS JWT)
- ブラウザ版（Firefox同士）で自前SFU経由の音声通話動作確認済み

### 未解決・次回やること

1. **アプリ版（Tauri）を最新ビルドでテスト** — `git pull && pnpm tauri:dev` で自前SFUに接続するか確認。古いビルドでは Element の SFU (matrix-org.livekit.cloud) に繋いでいたため、ブラウザ版と混在できなかった
2. **Chrome (Mac) でVCに入れない** — `NotFoundError: Requested device not found`。macOS のマイク権限問題（Firefox では動作する）。コード側の問題ではない
3. **ネイティブ画面キャプチャ（DXGI + WASAPI）** — 計画は `docs/native-capture-plan.md` に記載。3段階で段階的に実装予定（前回一気にやって失敗→revert済み）

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

### VPS (lche2.xvps.jp)
- AMD EPYC 3コア / 3.8GB RAM / 28GB ディスク
- Docker: LiveKit SFU（infra/livekit/docker-compose.yml）
- SSL: Let's Encrypt（/etc/ssl/lche2/）
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
| lk-jwt-service | Element製 JWT ブリッジ（OpenID → LiveKit JWT） |
| Cloudflare Workers | CORS プロキシ（フォールバック用） |
| pnpm 10.x | パッケージマネージャ |
| nx + Webpack | ビルド |
| GitHub Actions | CI/CD |

---

## Nexus カスタムファイル（主要）

### VC コア
- `src/models/NexusVoiceConnection.ts` — LiveKit 直接接続 + MatrixRTC + Web Audio パイプライン
- `src/stores/NexusVoiceStore.ts` — VC 接続管理シングルトン
- `src/hooks/useNexus*.ts` — VC 関連カスタムフック

### VC UI
- `src/components/views/voip/NexusVC*.tsx` — VC ルームビュー関連
- `src/components/views/rooms/RoomListPanel/Nexus*.tsx` — チャンネルリスト・ユーザーパネル

### Tauri
- `src-tauri/` — Rust バックエンド
- `src/vector/platform/TauriPlatform.ts` — Tauri 2 プラットフォーム
- `src/utils/tauriHttp.ts` — Tauri 判定 + CORS-free fetch

### インフラ
- `infra/livekit/docker-compose.yml` — LiveKit SFU Docker構成
- `infra/livekit/livekit.yaml` — LiveKit SFU 設定
- `infra/livekit/nginx.conf` — TLS 終端 + CORS

---

## VC 音声パイプライン設計（重要）

### 入力（マイク）
```
getUserMedia → LocalAudioTrack
  → MediaStreamSource → [RNNoise] → HPF(80Hz) → Compressor
  → Analyser + InputGainNode → MediaStreamDestination → publish to LiveKit
```
- AudioContext はユーザージェスチャー内（await 前）に生成必須
- ミュートは `inputGainNode.gain.value = 0`（LiveKit の track.mute() は使わない — Firefox で壊れるため）

### 出力（リモート音声）
- per-participant `<audio>` 要素で再生（Chrome は remote WebRTC audio を AudioNode 経由でルーティング不可）
- ブラウザ: `audio.volume` で音量制御（0-1）
- Tauri: `createMediaElementSource(audio)` → per-participant GainNode → outputMasterGain(0-2.0) → destination（>100% 増幅対応）

### 画面共有
- `getDisplayMedia()` 直接呼出し（createLocalScreenTracks だと音声失敗時に全体中止）
- 音声なしでも映像のみで続行

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
- Phase 3（Tauri 2 ネイティブ化）: ✅ 基本実装完了（v0.1.3）
- 自前 SFU: ✅ 構築完了、ブラウザ版動作確認済み

### ロードマップ
詳細は `docs/progress.md` 参照。

---

## 開発ルール

- **ビルドは GitHub Actions** — VPS でビルドしない
- **pnpm 10.x** — npm/yarn は使わない
- **tsc --noEmit** には `NODE_OPTIONS="--max-old-space-size=4096"` 必要
- **ブランチ**: main のみ（upstream/develop で element-web 追跡）
- **破壊的変更は事前確認** — 影響範囲と代替案を提示
- **Discord Docs 参照** — 真似できる部分、超えられる部分は積極的に実装

---

## 参考ドキュメント

- [CLAUDE.md](./CLAUDE.md) — AI アシスタント指示
- [docs/conventions.md](./docs/conventions.md) — 開発規約
- [docs/progress.md](./docs/progress.md) — 進捗・ロードマップ
- [docs/tech-stack.md](./docs/tech-stack.md) — 技術スタック詳細
- [docs/app-spec.md](./docs/app-spec.md) — アプリ仕様・UI設計
- [docs/vc-optimization.md](./docs/vc-optimization.md) — VC 接続高速化・SFU 計画
- [docs/native-capture-plan.md](./docs/native-capture-plan.md) — ネイティブ画面キャプチャ計画
