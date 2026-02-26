# Nexus プロジェクト - セッション引継書

## 現在の状態

### 直近の作業（v0.1.7 — 2026-02-26）

**VC チャンネル経過時間表示 + アクティブハイライト**
- **経過時間表示**: VC に参加者がいる場合、チャンネルリスト右側（NotificationDecoration）に `0:32` 形式の経過時間を表示
- **アクティブ表示**: 参加者がいる VC のスピーカーアイコンを緑に変更 + 左端に緑の縦ラインを表示
- **経過時間の算出**: MatrixRTC `CallMembership.createdTs()` から実際の参加者のみの最古タイムスタンプを使用
- **受話器アイコン廃止**: NotificationDecoration から VoiceCallSolidIcon/VideoCallSolidIcon を完全削除、経過時間テキストに置換

**起動画面の統一**
- **スプラッシュ統一**: LOADING → PENDING_CLIENT_START → LOGGED_IN(未同期) を全て同じロゴ+スピナー画面に
- **ロゴ SVG 化**: nexus-logo.png → nexus-logo.svg に変更（線画ロゴ）
- **スピナー配置修正**: ウィンドウ下部から 48px に固定（`position: absolute; bottom: 48px`）

**起動時の状態復元**
- **前回のスペース・チャンネル復元**: `mx_last_room_id` + SpaceStore の localStorage から前回の状態を復元
- **初回起動はホーム表示**: `mx_last_room_id` がない場合のみ ViewHomePage をディスパッチ
- **ホームフラッシュ防止**: SpaceStore の `_activeSpace` 初期値を空文字にして `onReady` まで何もハイライトしない
- **自動フォーカス防止**: LOGGED_IN 遷移直後に `activeElement.blur()` でツールチップ表示を抑制

**UI 調整**
- **アップデートダイアログ**: Tauri アプリ更新時にプログレスバー付きモーダル表示
- **E2E アイコン非表示**: `mx_EventTile_e2eIcon` を `display: none`
- **アバターサイズ**: メッセージのアバターを 40px → 35px に
- **タイムスタンプ常時表示**: ホバー時のみでなく常に名前の右に表示、sender 非表示時は非表示
- **チャンネルリスト余白調整**: `mx_RoomListItemView` min-height 36px→30px、VC 参加者 padding 縮小
- **チャット入力欄**: 右パディングを 32px に調整

**過去の主要マイルストーン**
- 自前 LiveKit SFU (lche2.xvps.jp) 構築完了
- VC 接続高速化（~600ms、切断即座）
- ネイティブ画面キャプチャ（WGC + WASAPI）実装完了

### 未解決・次回やること

1. **Chrome (Mac) でVCに入れない** — `NotFoundError: Requested device not found`。macOS のマイク権限問題（Firefox では動作する）。コード側の問題ではない
2. **システムトレイ常駐** — 閉じてもバックグラウンド動作

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

### 画面共有（ブラウザ）
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
- Phase 3（Tauri 2 ネイティブ化）: ✅ 基本実装完了（v0.1.7）
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

1. `src-tauri/tauri.conf.json` と `src-tauri/Cargo.toml` の `version` をバンプ
2. コミット → `git tag vX.Y.Z` → `git push && git push origin vX.Y.Z`
3. GitHub Actions `tauri-release` が自動でビルド → GitHub Release 作成
4. アプリの自動更新が `latest.json` を参照して新バージョンを検出 → ダウンロード＆再起動

**重要**: `tauri.conf.json` の version がそのまま `latest.json` の version と exe ファイル名に使われる。タグだけ打って version を上げ忘れると自動更新が動かない。
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
