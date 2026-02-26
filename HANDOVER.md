# Nexus プロジェクト - セッション引継書

## 現在の状態

### 直近の作業（2026-02-27）

**画面共有 A/V 同期（再検証完了 — v0.2.2）**
- 前回の試行時に受信側が旧バージョン（v0.2.0）だったため、全4方策を再適用して双方最新で再検証
- 再適用した方策:
  1. 映像+音声を同一 MediaStream に統合（`<video>` 1要素で再生）
  2. Web Audio 経由を廃止し `videoEl.volume` で直接制御
  3. トラック到着タイミング同期（映像到着時に音声を500ms待機）
  4. `requestVideoFrameCallback` でフリーズ検出→MediaStream 再構築
- **結果**: ズレが「数秒」→「100-300ms（映像が先行）」に改善。ユーザー許容範囲内と判断
- `playoutDelayHint` による追加調整も提案したが、ユーザーが現状維持を選択

**パネル非表示の空メッセージ**
- 「画面共有ではないパネルを非表示」ON + 誰も画面共有していないとき:
  - Spotlight: 「画面を共有しているユーザーはいません」テキスト表示
  - Grid: 同上（`nx_VCRoomView_gridEmpty` で全幅中央表示）

**CI バージョン自動コミット**
- `tauri-release.yml` に `update-version` ジョブを追加
- リリースビルド成功後、タグからバージョンを取得し `tauri.conf.json` / `Cargo.toml` を main に自動コミット
- 開発版でバージョンがズレる問題を解消

**バージョン管理修正**
- `tauri.conf.json` / `Cargo.toml` を手動で 0.2.1 に更新（0.1.9 のままだった）
- `Cargo.lock` をリポジトリに追加（Tauri バイナリでは推奨）

**過去の主要マイルストーン**
- 統合コンテキストメニュー（VC 背景右クリック）
- ポップアウト機能（試行→断念→全削除 — WebView2 が Document PiP 未サポート）
- 自前 LiveKit SFU (lche2.xvps.jp) 構築完了
- VC 接続高速化（~600ms、切断即座）
- ネイティブ画面キャプチャ（WGC + WASAPI）実装完了

### 未解決・次回やること

1. **Chrome (Mac) でVCに入れない** — `NotFoundError: Requested device not found`。macOS のマイク権限問題（Firefox では動作する）。コード側の問題ではない
2. **システムトレイ常駐** — 閉じてもバックグラウンド動作
3. **日本語翻訳 残り415件** — `devtools`(75), `encryption`(59), `auth`(39), `right_panel`(28) 等の高度な画面

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
- 映像+音声: 同一 `MediaStream` に統合し `<video>` 1要素で再生（ブラウザの A/V 同期に委任）
- 音量制御: `videoEl.volume` で直接制御（Web Audio 経由ではない — RTCP SR 同期を維持）
- `registerScreenShareVideoElement()` / `unregisterScreenShareVideoElement()` で NexusVoiceConnection に登録
- トラック到着同期: 映像到着時に500ms待機し、音声到着で即座に React に通知（`pendingScreenShareTimers`）
- フリーズ検出: `requestVideoFrameCallback` で500ms以上のギャップを検出 → MediaStream 再構築（3秒クールダウン）
- 視聴オプトイン: `watchingScreenShares` セットで管理。未視聴時は `videoEl.volume=0`

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
