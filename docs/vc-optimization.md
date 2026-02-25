# VC 接続高速化 調査・設計メモ — vc-optimization.md

> 最終更新: 2026-02-25

## 概要

VC チャンネルクリックから接続完了までの時間を短縮するための調査と設計メモ。
Discord のドキュメント・技術ブログも参考にした。

## 現在の接続フロー（最適化済み）

```
T=0ms    クリック → joinVoiceChannel()
T=10ms   NexusVoiceConnection 作成 + スピナー表示開始
T=50ms   connection.connect() 開始
           │
           ├─ Phase 0: AudioContext 生成（同期、~5ms）
           │
           ├─ Phase 1: Promise.all ──────────────────────
           │    ├─ getJwt()                       ... ~100-200ms (キャッシュ時) / ~200-400ms (初回)
           │    │    ├─ getCachedOpenIdToken()      (キャッシュ or matrix.org)
           │    │    └─ POST /sfu/get              (自前SFU)
           │    ├─ createLocalAudioTrack()         ... 50-200ms (getUserMedia)
           │    └─ preloadRnnoiseWasm()            ... ~0ms (キャッシュ済み)
           │
           ├─ Phase 3+4: 並列実行 ──────────────────────
           │    ├─ livekitRoom.connect()           ... ~60-100ms (自前SFU)
           │    └─ buildInputPipeline()            ... ~10-50ms (並列)
           │         ├─ AudioNode 作成（同期）
           │         ├─ setupRnnoiseNode()         (NC 有効時)
           │         └─ MediaStreamDestination 作成
           │
           ├─ await publishTrack()                 ... 100-300ms
           │
           └─ joinRoomSession()                    ... 0ms（await なし）
           │
T=~600ms ConnectionState.Connected（再接続時、自前SFU）
T=~800ms ConnectionState.Connected（初回接続時、自前SFU）
```

**自前 SFU + 最適化後: 再接続 ~600ms、初回 ~800ms。**

## Discord との比較

### Discord が速い理由（プロトコルレベル）

Discord は WebRTC 標準を大幅に逸脱した独自プロトコルを使用:

| 項目 | Discord | Nexus (LiveKit) |
|------|---------|----------------|
| NAT 越え | 独自 UDP Hole Punching (74B) | ICE/STUN/TURN (100-500ms) |
| 暗号化 | Salsa20/AES-GCM 直接 | DTLS-SRTP (~200ms ハンドシェイク) |
| シグナリング | ~1000B | ~10,000B (SDP) |
| Gateway | 常時接続 WebSocket | 毎回 JWT 取得が必要 |
| ブラウザ版 | 標準 WebRTC にフォールバック | WebRTC |

**結論: Discord のプロトコルレベルの高速化は LiveKit を使う限り真似できない。**

### Discord から学べる設計思想

1. **プリフェッチ**: Gateway 常時接続で VC 参加時に新規接続不要
2. **セッション再開 (Resume)**: session_id で再接続、フルハンドシェイクをスキップ
3. **最小限のデータ交換**: ハンドシェイク全体で約 1000B

参考:
- https://docs.discord.com/developers/topics/voice-connections
- https://discord.com/blog/how-discord-handles-two-and-half-million-concurrent-voice-users-using-webrtc

## SFU 代替の検討

### MatrixRTC と SFU の関係

- MatrixRTC (MSC4143) は仕様上 SFU 非依存（トランスポートはプラグイン方式）
- ただし **実装が存在するのは LiveKit トランスポート (MSC4195) のみ**
- 他の SFU 用トランスポート MSC は存在しない
- Cloudflare SFU との実験 (2024) は PoC レベルで終了

### 代替 SFU の比較

| SFU | 特徴 | 接続速度への影響 |
|-----|------|-----------------|
| **LiveKit** (現在) | フルスタック、SDK 豊富 | 標準 WebRTC |
| **Mediasoup** | C++ 最高性能、低レベル制御 | WebRTC なので同じ |
| **Cloudflare Calls** | Anycast エッジ、ICE 高速化 | エッジが近い分改善 |
| **Janus** | C 言語、安定 | WebRTC なので同じ |

**結論: WebRTC を使う限りどの SFU でも ICE+DTLS (300-900ms) は消えない。SFU 差し替えだけでは根本改善にならない。**

### WebRTC を使わない選択肢

| 方式 | ブラウザ | Tauri | 備考 |
|------|---------|-------|------|
| 独自 UDP (Discord 方式) | 不可 | 可 | ICE/DTLS 完全省略 |
| WebTransport + MoQ | 対応中 | 可 | ICE 不要、未成熟 |

## 最適化戦略

### 実装済み

#### A. 接続フローの並列化 ✅

```
Phase 1 (Promise.all):
  ┌─ getJwt() ──────────────────┐
  ├─ createLocalAudioTrack() ───┤  Promise.all
  └─ preloadRnnoiseWasm() ──────┘
            ↓
Phase 3+4 (並列):
  ┌─ livekitRoom.connect()      ┐  並列実行
  └─ buildInputPipeline()       ┘  (パイプライン構築 + RNNoise)
            ↓
  publishTrack(processedTrack)
```

**短縮効果: Phase 1 で ~500ms、Phase 3+4 並列化で ~50-100ms**

#### B. RNNoise WASM のプリロード ✅

- `preloadRnnoiseWasm()` で Phase 1 中に WASM バイナリを static キャッシュ
- `setupRnnoiseNode()` では WASM ダウンロード待ちが不要

#### C. パイプライン構築の並列化 ✅

- `buildInputPipeline()` メソッドで AudioNode 作成 + RNNoise AudioWorklet 登録 + パイプライン接続 + MediaStreamDestination 作成
- `livekitRoom.connect()` と同時実行し、先に終わった方が後方を待つ

#### D. OpenID トークンキャッシュ ✅

- `getCachedOpenIdToken()` で `getOpenIdToken()` の結果をキャッシュ
- `expires_in` の 80% の期間で有効（デフォルト 3600秒 → 2880秒キャッシュ）
- 静的変数で NexusVoiceConnection インスタンス間共有
- **再接続時に ~100-200ms 短縮**（matrix.org へのラウンドトリップ省略）

#### E. 起動時プリフェッチ ✅

- `NexusVoiceConnection.prefetch(client)` を `MatrixChat.onClientStarted()` で fire-and-forget 呼出し
- RNNoise WASM + OpenID トークンをログイン完了時にバックグラウンド取得
- **初回 VC 接続でもキャッシュ済みの恩恵を受けられる**

#### F. 切断即時化 ✅

- `disconnect()` の `leaveRoomSession()` を fire-and-forget に変更（matrix.org への state event PUT を待たない）
- `cleanupLivekit()` 内の `livekitRoom.disconnect()` も fire-and-forget（WebSocket close handshake を待たない）
- ローカルのオーディオ停止・ノード切断は全て同期で完了するため UI は即座に Disconnected
- MatrixRTC membership は自然タイムアウト or 次回 `clean()` で掃除

### 将来の検討

#### E. LiveKit reconnect() の活用

- 一時的なネットワーク断で disconnect() せず reconnect() を使う
- フルハンドシェイクをスキップ

#### F. マイク権限の事前取得

- VC パネル表示時に getUserMedia を先行呼び出し
- 初回接続時の許可ダイアログ待ちを前倒し

### ロードマップ

| フェーズ | 施策 | 効果 |
|---------|------|------|
| ✅ **Phase 2.5** | 並列化 + WASM プリロード | ~500ms 短縮 |
| ✅ **自前 SFU** | 自前 LiveKit SFU (日本VPS) | **~1000-1200ms 短縮** |
| ✅ **接続最適化** | パイプライン並列化 + OpenID キャッシュ + 起動時プリフェッチ | ~150-300ms 短縮 |
| ✅ **切断即時化** | leaveRoomSession + livekitRoom.disconnect を fire-and-forget | 切断 ~0ms |
| **中期** | reconnect() | 再接続時改善 |
| **Tauri 2** | Rust UDP 高速パス + WebRTC フォールバック | 根本改善 |
| **長期** | WebTransport/MoQ 移行 | ブラウザ版も改善 |

---

## 自前 LiveKit SFU 計画

> 作成: 2026-02-28

### 目的

VC 参加ボタン押下 → 音声通信確立までの時間を短縮する。
現在 2-3 秒 → **1 秒前後** を目標。

### なぜ速くなるか

全員日本在住。SFU が日本にあれば、全フェーズの RTT が改善される。

| フェーズ | 今（海外 SFU 経由） | 自前 SFU（日本 VPS） | 短縮 |
|---------|-------------------|-------------------|------|
| JWT 取得 | ~200-400ms (CORS プロキシ → Element JWT → matrix.org 検証) | ~10-30ms (VPS → matrix.org 検証) | **~200-400ms** |
| WebSocket 接続 | ~150ms | ~10ms | **~140ms** |
| ICE (3往復) | ~450ms (RTT ~150ms × 3) | ~30ms (RTT ~10ms × 3) | **~420ms** |
| DTLS (2往復) | ~300ms (RTT ~150ms × 2) | ~20ms (RTT ~10ms × 2) | **~280ms** |
| **合計** | | | **~1000-1200ms** |

変わらない部分:
- マイクアクセス (`getUserMedia`): ~200-500ms（ローカル処理）
- WASM プリロード: ~100ms（ローカル処理）
- MatrixRTC シグナリング: matrix.org 経由（変更なし）

### VPS スペック

- CPU: AMD EPYC-Milan 3コア
- メモリ: 3.8GB（空き ~2GB）
- ディスク: 28GB（残り 11GB）
- IP: 162.43.31.143（日本）— lche2.xvps.jp
- OS: Ubuntu 25.04
- Docker 稼働中（cfrp-market 5コンテナ）

10人以下の VC なら十分。

### 構成

```
現在:
  ブラウザ/Tauri → Cloudflare Workers → Element JWT サービス → JWT 取得
  ブラウザ/Tauri → Element LiveKit SFU (海外) → WebRTC 音声/映像

自前 SFU 後:
  ブラウザ/Tauri → VPS (LiveKit SFU + JWT サービス) → WebRTC 音声/映像
  ※ Matrix ホームサーバーは matrix.org のまま（チャットは変更なし）
```

### セットアップ手順

#### 1. VPS に LiveKit SFU を Docker で起動

```bash
docker run -d --name livekit \
  -p 7880:7880 -p 7881:7881 -p 7882:7882/udp \
  -v /etc/livekit.yaml:/etc/livekit.yaml \
  livekit/livekit-server \
  --config /etc/livekit.yaml
```

`livekit.yaml` で設定:
- API キー / シークレット（JWT 署名用）
- ログローテーション（肥大化防止）
- TURN 内蔵設定（NAT 越え）
- 録画: 無効

#### 2. JWT 発行サービス

LiveKit の公式 JWT サービス（`livekit-server` 自体が `/sfu/get` エンドポイントを持つ場合）、
もしくは軽量な JWT 発行サーバーを同居させる。

OpenID トークン検証フロー:
```
Nexus クライアント → VPS /sfu/get (OpenID トークン付き)
  → VPS から matrix.org に検証リクエスト
  → 検証 OK → LiveKit JWT を発行して返却
```

#### 3. SSL 証明書

LiveKit は WebSocket (WSS) + WebRTC で接続するため、HTTPS が必須。
Let's Encrypt + nginx リバースプロキシ、または Caddy で対応。

#### 4. Nexus 側のコード変更

**変更箇所は最小限:**

`src/models/NexusVoiceConnection.ts`:
```typescript
// 方法 A: transports の livekit_service_url を上書き
// matrix.org の設定ではなく自前 SFU を使う
const serviceUrl = SELF_HOSTED_LIVEKIT_URL || livekitTransport.livekit_service_url;
```

- CORS プロキシ (`LIVEKIT_CORS_PROXY_URL`) は空にする or 削除
  - 自前 SFU なら CORS ヘッダーを自分で設定できるので不要
- Tauri 版は既に `corsFreePost` で直接アクセスしてるので、URL を変えるだけ

#### 5. ログローテーション設定

```yaml
# livekit.yaml
logging:
  level: warn  # info だとログが膨らむ
```

Docker のログドライバーでローテーション:
```bash
--log-driver json-file --log-opt max-size=10m --log-opt max-file=3
```

### Discord との比較（真似できる部分）

参考: https://docs.discord.com/developers/topics/voice-connections

| Discord の設計思想 | 真似できるか | 方法 |
|-------------------|------------|------|
| SFU を地理的に近く配置 | **✅ これをやる** | 日本 VPS に SFU 配置 |
| Gateway 常時接続で即時 VC 参加 | ❌ | WebRTC の制約（毎回 ICE/DTLS 必要） |
| セッション再開 (Resume) | △ | LiveKit reconnect() で部分的に可能 |
| 最小限のハンドシェイク (~1000B) | ❌ | WebRTC SDP は ~10,000B |
| 独自 UDP Hole Punching | ❌ ブラウザ / △ Tauri | Tauri なら将来的に Rust UDP パス |
| 品質制限なし | **✅** | 自前 SFU でビットレート自由 |
| Opus 音声の動的ビットレート | **✅ 実装可能** | LiveKit の adaptive streaming |

### 確認チェックリスト

- [ ] VPS で LiveKit SFU が起動し、ヘルスチェックに応答する
- [ ] JWT 発行が動作する（OpenID トークン検証含む）
- [ ] ブラウザ版で VC に接続でき、音声が通る
- [ ] Tauri 版でも同様
- [ ] CORS プロキシなしでブラウザ版が動作する
- [ ] 画面共有（映像+音声）が従来通り動作する
- [ ] 接続時間が体感で短縮されている
- [ ] ログが肥大化しないことを確認（数日運用後）
