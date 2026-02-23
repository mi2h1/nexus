# VC 接続高速化 調査・設計メモ — vc-optimization.md

> 最終更新: 2026-02-24

## 概要

VC チャンネルクリックから接続完了までの時間を短縮するための調査と設計メモ。
Discord のドキュメント・技術ブログも参考にした。

## 現在の接続フロー（直列）

```
T=0ms    クリック → joinVoiceChannel()
T=10ms   NexusVoiceConnection 作成 + スピナー表示開始
T=50ms   connection.connect() 開始
           │
           ├─ ① await getJwt()                    ... 200-500ms
           │    ├─ await getOpenIdToken()           （Homeserver 通信）
           │    └─ await fetch(CORS プロキシ)       （JWT 取得）
           │
           ├─ ② await livekitRoom.connect()        ... 500-5000ms ★最大ボトルネック
           │    └─ ICE candidate + DTLS handshake   （WebRTC 確立）
           │
           ├─ ③ await createLocalAudioTrack()       ... 50-200ms
           │    └─ getUserMedia()                   （マイクアクセス）
           │
           ├─ ④ AudioContext 構築                    ... 同期
           │
           ├─ ⑤ await setupRnnoiseNode()            ... 50-150ms（NC 有効時のみ）
           │    ├─ await loadRnnoise()               （WASM 読み込み）
           │    └─ await addModule()                 （AudioWorklet 登録）
           │
           ├─ ⑥ await publishTrack()                 ... 100-300ms
           │
           └─ ⑦ joinRoomSession()                    ... 0ms（await なし）
           │
T=1-2.5s ConnectionState.Connected
T=1.5-3s MatrixRTC メンバーシップ反映 → スピナー消滅
```

**低遅延環境で 1〜2.5 秒、高遅延環境で 3〜10 秒。**

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

### 実装済み / 実装予定

#### A. 接続フローの並列化（実装予定）

```
Before (直列):
  getJwt() → livekitRoom.connect() → createLocalAudioTrack() → setupRnnoise → publishTrack

After (並列化):
  ┌─ getJwt() ──────────────────┐
  ├─ createLocalAudioTrack() ───┤  Promise.all
  └─ preloadRnnoiseWasm() ──────┘
            ↓
  livekitRoom.connect() ← JWT が必要なので後
            ↓
  AudioContext構築 + publishTrack ← マイクトラックが必要なので後
```

**短縮見込み: 最大 500ms**

#### B. RNNoise WASM のプリロード（実装予定）

- `loadRnnoise()` はアプリ起動時に実行可能（static キャッシュ済み）
- 接続フロー内では WASM ダウンロード待ちが不要になる

#### C. RNNoise AudioWorklet の事前登録（実装予定）

- AudioContext は connect() 内で作るが、AudioWorklet 登録も含めて並列化

### 将来の検討

#### D. JWT キャッシュ

- 有効期限内の JWT を再利用
- 再接続時に 200-500ms 短縮

#### E. LiveKit reconnect() の活用

- 一時的なネットワーク断で disconnect() せず reconnect() を使う
- フルハンドシェイクをスキップ

#### F. マイク権限の事前取得

- VC パネル表示時に getUserMedia を先行呼び出し
- 初回接続時の許可ダイアログ待ちを前倒し

### ロードマップ

| フェーズ | 施策 | 効果 |
|---------|------|------|
| **今 (Phase 2.5)** | 並列化 + WASM プリロード | ~500ms 短縮 |
| **中期 (Phase 3)** | JWT キャッシュ + reconnect() | 再接続時改善 |
| **Tauri 2** | Rust UDP 高速パス + WebRTC フォールバック | 根本改善 |
| **長期** | WebTransport/MoQ 移行 | ブラウザ版も改善 |
