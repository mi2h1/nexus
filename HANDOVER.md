# Nexus プロジェクト - セッション引継書

## 現在の状態

### 直近の作業（2026-02-26）

**統合コンテキストメニュー**
- VC ルームビューの背景右クリックで統合コンテキストメニューを表示
  - 「画面共有ではないパネルを非表示」チェックボックス — 全参加者タイルを非表示にできる
  - 画面共有タイル右クリック時は音量スライダーも表示（従来の `NexusScreenShareContextMenu` を統合）
- `NexusVCViewContextMenu` を `NexusVCRoomView.tsx` 内に実装
- `ScreenShareTile` から内部コンテキストメニューを削除し `onShareContextMenu` コールバックに変更

**ポップアウト機能（試行→断念→全削除）**
- Document PiP API → WebView2 未サポート
- `window.open()` → Tauri にブロックされる
- Tauri Window API → 元の要件（別ウィンドウに VC を出す）を満たせない別物になった
- 全コードをリバートし、教訓をドキュメント化

**画面共有 A/V 同期（調査→試行→リバート）**
- 画面共有の映像と音声にズレがある問題を調査
- Discord の音声アーキテクチャ（RTCP Sender Report、Speaking flags、playout delay）を詳細調査
- 試行した方策と結果:
  1. 映像+音声を同一 MediaStream に統合 → 改善不十分
  2. Web Audio 経由を廃止し `videoEl.volume` 直接制御 → 悪化
  3. トラック到着タイミング同期（映像到着時に音声を500ms待機）→ 効果不明
  4. `requestVideoFrameCallback` でフリーズ検出→MediaStream再構築 → 悪化
- **結論**: 元の分離パイプライン（`<video muted>` + 別 `<audio>` + Web Audio GainNode）が最も安定。全リバート済み
- **根本原因**: LiveKit SFU が映像・音声を別 RTP ストリームで配信するため、完全な同期はアプリ層では困難。現状のズレ（数十ms）は許容範囲

**過去の主要マイルストーン**
- 自前 LiveKit SFU (lche2.xvps.jp) 構築完了
- VC 接続高速化（~600ms、切断即座）
- ネイティブ画面キャプチャ（WGC + WASAPI）実装完了

### 未解決・次回やること

1. **画面共有 A/V 同期** — 現状数十msのズレあり。LiveKit SFU の RTP 配信特性に起因。根本解決には SFU 側の設定（playout-delay RTP 拡張等）か、カスタムメディアエンジンが必要
2. **Chrome (Mac) でVCに入れない** — `NotFoundError: Requested device not found`。macOS のマイク権限問題（Firefox では動作する）。コード側の問題ではない
3. **システムトレイ常駐** — 閉じてもバックグラウンド動作
4. **日本語翻訳 残り415件** — `devtools`(75), `encryption`(59), `auth`(39), `right_panel`(28) 等の高度な画面

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
  - `nexus-jwt` — lk-jwt-service (Matrix OpenID → LiveKit JWT 変換)
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
| lk-jwt-service | Element製 JWT ブリッジ（OpenID → LiveKit JWT） |
| Cloudflare Workers | CORS プロキシ（フォールバック用） |
| pnpm 10.x | パッケージマネージャ |
| nx + Webpack | ビルド |
| GitHub Actions | CI/CD |

---

## Nexus カスタムファイル（主要）

### ストア
- `src/stores/NexusUpdateStore.ts` — Tauri 自動更新管理（ダウンロード進捗、インストール状態）

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
- per-participant `<audio>` 要素 + Web Audio API で再生
- ブラウザ: `audio.volume` で音量制御（0-1）
- Tauri: `createMediaStreamSource(MediaStream)` → per-participant GainNode → outputMasterGain(0-2.0) → destination（>100% 増幅対応）
  - `createMediaElementSource` は WebView2 で audio 要素の出力を正しくリダイレクトしないため不採用
  - audio 要素は `volume=0` でシステム出力を抑制、`play()` で MediaStream を alive に保持

### 画面共有音声（受信側）
- 映像: `share.track.attach(videoEl)` → `<video autoPlay muted>` — LiveKit のトラック管理に委任
- 音声: 別 `<audio>` 要素で再生 — `onTrackSubscribed` で ScreenShareAudio を受信時に作成
- Tauri: `createMediaStreamSource(MediaStream)` → per-share `GainNode` → `outputMasterGain` → destination（>100% 増幅対応）
- ブラウザ: `audio.volume` で音量制御（0-1）
- **映像と音声は分離パイプライン** — LiveKit SFU が別 RTP ストリームで配信するため。同一 MediaStream 統合は試行したが安定性が低下したためリバート
- 視聴オプトイン: `watchingScreenShares` セットで管理。未視聴時は gain=0 / audio.pause()

### 画面共有（ブラウザ送信側）
- `getDisplayMedia()` 直接呼出し（createLocalScreenTracks だと音声失敗時に全体中止）
- 音声なしでも映像のみで続行

### ネイティブ画面キャプチャ（Tauri）
- 映像: Windows Graphics Capture (WGC)、音声: WASAPI Process Loopback
- ウィンドウ共有: INCLUDE モード（`target_process_id` = アプリの PID → そのアプリの音だけ）
- モニター共有: EXCLUDE モード（`target_process_id` = 0 → 全システム音、Nexus 除く）
- Initialize: `LOOPBACK | EVENTCALLBACK | AUTOCONVERTPCM` + PCM 16bit/48kHz/stereo
- 制限: 同一プロセスの複数ウィンドウの音声は分離不可（Windows API の制約）

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
- Phase 3（Tauri 2 ネイティブ化）: ✅ 基本実装完了（v0.1.10）
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

### Tauri リリース手順

1. コミット → `git tag vX.Y.Z` → `git push && git push origin vX.Y.Z`
2. GitHub Actions `tauri-release` が自動でビルド → GitHub Release 作成
3. バージョンはタグ名から自動注入（`tauri.conf.json` / `Cargo.toml` の手動更新不要）
4. アプリの自動更新が `latest.json` を参照して新バージョンを検出 → ダウンロード＆再起動

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
