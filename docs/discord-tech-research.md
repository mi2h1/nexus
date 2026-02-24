# Discord 技術調査 — discord-tech-research.md

> 最終更新: 2026-02-25
> ソース: Discord Engineering Blog, Discord Developer Docs, 技術記事・分析

---

## 1. アーキテクチャ概要

### フロントエンド

| 項目 | 技術 | 備考 |
|------|------|------|
| UI フレームワーク | React (2015年~) | Virtual DOM + 単方向データフロー |
| 状態管理 | 独自 Flux 実装 | Redux ではなく Facebook Flux ベースのカスタム実装 |
| デスクトップ | Electron | Chromium + Node.js ラッパー |
| モバイル | React Native | 2022年に Android を移行、Hermes JS エンジン使用 |
| バンドラー | Webpack | ルートベースのコード分割 |

#### Flux 状態管理の詳細

Discord は Facebook の Flux アーキテクチャをカスタム実装している:

- **Store**: 状態とロジックを保持するオブジェクト。`getName()` メソッドで識別（2022年追加）
- **PersistedStore**: サーバー同期対応の永続化ストア。`shouldSync()` で同期制御
- **Dispatcher**: アクションを受け取り適切な Store にルーティング
- **`_actionHandlers`/`_subscriptions`**: 内部構造でイベント管理
- クラスコンポーネント: ラッパーコンポーネント経由で Store データにアクセス
- 関数コンポーネント: Hooks API 経由で Store を購読

### バックエンド

| レイヤー | 技術 | 用途 |
|---------|------|------|
| API サーバー | Python (Django → 独自) | REST API モノリス |
| リアルタイム通信 | Elixir (BEAM VM) | Gateway WebSocket、プレゼンス管理 |
| データサービス | Rust | DB アクセス層、ホットパーティション制御 |
| メッセージ DB | ScyllaDB (元 Cassandra) | 兆単位のメッセージ保存 |
| 音声サーバー | C++ | 独自 SFU (Selective Forwarding Unit) |
| メディアプロキシ | Rust (元 Go) | 画像変換・配信 |
| サービスディスカバリ | etcd | 音声サーバーの動的割り当て |

#### Rust + Elixir のスケーリング

Discord は Elixir (BEAM VM) で 1100万同時接続を達成:

- **Rustler** ライブラリで Elixir-Rust の安全なブリッジを構築
- **NIF (Native Implemented Functions)**: Rust コードを BEAM VM にネイティブ統合
- **SortedSet**: メンバーリスト用の高性能ソートデータ構造を Rust で実装
  - 100万アイテム: 最良 0.61us、最悪 3.68us（Elixir 純正比で数百倍高速）
  - 全 Discord サーバーのメンバーリストを駆動

#### ScyllaDB への移行

MongoDB → Cassandra → ScyllaDB と段階的に移行:

- ScyllaDB: C++ 製、GC レス、shard-per-core アーキテクチャ
- **p99 読み取り遅延**: 15ms（Cassandra の 40-125ms から改善）
- **p99 書き込み遅延**: 5ms（Cassandra の 5-70ms から改善）
- Rust 製データサービス層がホットパーティションへの並行アクセスを制御

---

## 2. リアルタイム通信

### Gateway WebSocket API

Discord の Gateway はクライアントとサーバー間の永続 WebSocket 接続を管理する:

- **接続フロー**: WebSocket 確立 → OP 10 Hello (heartbeat_interval 受信) → OP 1 Heartbeat 開始
- **イベント配信**: メッセージ作成、プレゼンス更新、ギルド変更などをリアルタイム配信
- **Gateway Intents**: 必要なイベントのみを購読可能（帯域節約）
- **プレゼンス管理**: ユーザーのオンライン/オフライン/DND 等のステータスをリアルタイム追跡
- **推奨**: クライアント側でリソース状態をキャッシュし、イベントで差分更新（API 呼び出し削減）

### 通知システム

- **デスクトップ**: アプリ起動中のみ通知（プッシュ通知はモバイルのみ）
- **バッジ**: 赤バッジ = @メンション、グレーバッジ = 未読メッセージ（現在は赤に統一）
- **チャンネル単位**: 通知設定をチャンネルごとにオーバーライド可能
- **システムトレイ**: 未読/メンションのバッジ表示

---

## 3. UI/UX の技術的仕組み

### 仮想スクロール

Discord はチャット、メンバーリスト、絵文字ピッカーで仮想化を採用:

- **原理**: ビューポート内（+α）のアイテムのみ DOM にレンダリング
- **メリット**: DOM ノード数削減、メモリ使用量削減、レンダー時間短縮
- **課題**: スクロール位置の復元（Discord でもジャンプ問題のユーザー報告あり）

#### モバイルでの最適化 (React Native)

Discord は複数の仮想化ライブラリを使い分けている:

| コンポーネント | ライブラリ | 理由 |
|---------------|-----------|------|
| GIF/ステッカーピッカー | FastestList (独自) | ネイティブ RecyclerView + View Portaling |
| DM リスト | FastestList | ブランキング防止 |
| メンバーリスト | FastestList | 高パフォーマンス |
| チャンネルリスト | FastList (独自) | FlashList よりブランキングが少ない |
| 絵文字ピッカー | ネイティブ実装 | JS ブリッジのオーバーヘッド回避 |

**FastestList の View Portaling 技術**:
- Android の `RecyclerView` をネイティブ基盤として使用
- JS でレンダリングしたビューをネイティブコードがビューポート進入時に移動
- JSX ビューが存在しない場合はプレースホルダーを表示（ブランキング防止）

### メッセージレンダリング最適化 (モバイル)

- Application Components / Media Mosaics のリサイクルメカニズム
- スポイラーなど低頻度要素の遅延インフレーション
- Message Container / Reactions の計測速度改善
- リサイクルプールに一般的な要素を事前充填
- **結果**: スローフレーム最大 60% 削減、メモリ使用量 12% 削減

### 画像フォーマット最適化

Discord はメディアインフラを近代化し、WebP/AVIF をサポート:

- **Lilliput**: Discord のオープンソース画像処理ライブラリ（検出・変換・変形）
- **メディアプロキシ**: Go → Rust に移植、オンザフライ変換
- **WebP を主要変換先に選定**: ほぼ全プラットフォームサポート、高速エンコード/デコード
- **絵文字 WebP 化の成果**:
  - 中央値サイズ 29.4% 削減（31.3KB → 22.1KB）
  - p95 サイズ 42.5% 削減（228KB → 131KB）
  - アニメーション絵文字を 60fps で表示可能に
- **AVIF**: HDR→SDR トーンマッピング後に WebP に変換（互換性優先）
- **アニメーション検出**: アップロード時に `is_animated` フラグを解析・保存
- **フォールバック**: 旧クライアント向けに GIF サポート維持

---

## 4. 音声/映像技術

### 音声アーキテクチャ

#### SFU (Selective Forwarding Unit)

Discord は独自の C++ 製 SFU を運用:

- **規模**: 850+ 音声サーバー、13 リージョン、30+ データセンター
- **同時接続**: 260万+ 同時音声ユーザー、220Gbps+ のエグレストラフィック
- **1000人同時発話**: テスト済み（クライアント-サーバーアーキテクチャにより可能）

#### サーバーコンポーネント

音声サーバーは2つのコンポーネントで構成:

1. **シグナリングコンポーネント** (Elixir):
   - ストリーム識別子・暗号化キーの生成
   - 発話インジケーション転送
   - SFU の監視と障害時の自動再起動・状態再構築

2. **メディアリレー (SFU)** (C++):
   - 音声/映像トラフィックの転送
   - ネイティブ/ブラウザ間のトランスポート・暗号化の変換ブリッジ
   - RTCP 処理（映像品質最適化）

#### バックエンド音声サービス群 (Elixir)

- **Discord Gateway**: 永続 WebSocket 接続、イベントシグナリング
- **Discord Guilds**: etcd サービスディスカバリで音声サーバーを動的割り当て
- **Discord Voice**: メディア転送・ストリーミング管理

### 音声プロトコル

| 項目 | 仕様 |
|------|------|
| コーデック | Opus (ステレオ, 48kHz) |
| トランスポート | RTP over UDP |
| 暗号化 | xsalsa20_poly1305 (libsodium) — DTLS/SRTP より高速 |
| 無音検出 | 無音期間は音声データ送信を停止（帯域・CPU 節約） |
| ICE | 不使用（全クライアントがサーバーに直接接続、NAT 問題回避 + IP 秘匿） |

#### 音声接続フロー

```
クライアント → Gateway WebSocket (OP0 Identify)
         ← OP2 Ready (SSRC, UDP ポート, 暗号化モード, heartbeat_interval)
         → UDP 接続確立
         → RTP + Opus エンコード済みパケット送信
```

### ネイティブ音声エンジン

デスクトップ/iOS/Android は WebRTC ネイティブライブラリをベースにしたカスタム C++ メディアエンジンを使用:

- 生オーディオアクセスによる音声アクティビティ検出 (VAD)
- Windows の自動音量低下 (auto-ducking) バイパス
- OS 設定から独立したカスタム音量制御
- 優先スピーカー表示用のメタデータ付与

### 音声処理パイプライン

| 処理 | 技術 | 詳細 |
|------|------|------|
| ノイズキャンセリング | Krisp (ML) | デバイス上で実行、サーバー送信なし |
| エコーキャンセレーション | 内蔵 | スピーカー音声のマイク混入防止 |
| AGC | 内蔵 | 自動ゲイン制御でレベル一定化 |
| VAD | 内蔵 + Krisp | 発話検出で無音時の送信停止 |
| ボイスゲート | ユーザー設定 | 感度閾値の手動調整 |

#### Krisp ノイズキャンセリングの技術詳細

- **デスクトップ**: C++/ネイティブ SDK でデバイス上推論
- **ブラウザ**: WebAssembly JavaScript SDK
  - Chrome の AudioWorklet は 3ms フレームで供給
  - Krisp の DNN は 30ms フレームで処理
  - → 10 フレームをバッファリングし、30ms フレームを 3ms 以内に処理
  - Web Audio API の `AudioContext` + `AudioWorkletProcessor` + `AudioWorkletNode` を使用
- **特徴**: 犬の鳴き声、掃除機、ドアの音など非音声ノイズを除去
- **プライバシー**: 全処理がデバイス上、音声データの外部送信なし

### 映像コーデック

| コーデック | 用途 | 備考 |
|-----------|------|------|
| VP8 | 標準ビデオ通話 | 広い互換性 |
| H.264 | ハードウェアアクセラレーション対応 | GPU エンコード/デコード |
| VP9 | 高品質・低ビットレート | H.264 比 25-40% ビットレート削減 |
| HEVC | 特定プラットフォーム | 限定サポート |
| AV1 | 最新世代 | RTX 40 / RX 7000 系 GPU 必要 |

### Go Live (画面共有) 技術

Discord の画面共有は多段パイプライン:

#### スクリーンキャプチャ

- OS 固有の最適キャプチャメソッドを使用
- **ロバストフォールバック**: 1つの方法が失敗すると次に自動切替
- 一部はアプリケーションに直接 DLL インジェクトしてレンダリングデータにアクセス
- 子プロセスの音声も含めた複合音声キャプチャ

#### エンコーディングパイプライン

- 未圧縮 1080p フレーム: 約 6MB → 実用的でないため圧縮必須
- **ハードウェアエンコーダー優先**: GPU 内蔵エンコーダー/デコーダーを利用（CPU/メモリ消費削減）
- **帯域適応**: ネットワーク状態に基づき品質をリアルタイム調整
  - 帯域低下時: フレームドロップ → 画質/遅延のバランス調整
  - 最も低速な視聴者の接続速度に合わせて送信
  - 視聴者なしの場合は送信停止

#### 品質モニタリング KPI

- フレームレート、配信一貫性、遅延
- VMAF (画像品質メトリクス)
- CPU/メモリ使用量、ネットワーク利用率
- ユーザーセンチメント調査（定性フィードバック）

### DAVE プロトコル (E2EE for Audio/Video)

2024年9月発表の音声/映像 E2E 暗号化プロトコル:

- **鍵交換**: MLS (Messaging Layer Security, RFC 9420) — スケーラブルなグループ鍵管理
- **暗号化**: WebRTC Encoded Transform API — エンコード後に暗号化、デコード前に復号
- **コーデック認識**: 暗号化変換はコーデックメタデータの非暗号化範囲を識別
- **エポック管理**: 参加者の入退出で新エポックに移行、全 per-sender キーが変更
  - 新メンバー: 過去エポックのメディアを復号不可
  - 退出メンバー: 将来エポックのメディアを復号不可
- **検証**: Voice Privacy Code (MLS エポック認証子) + ペアワイズ ECDSA P-256 ID キー
- **監査**: Trail of Bits による外部設計・実装レビュー
- **オープンソース**: `libdave` ライブラリとホワイトペーパーを GitHub で公開

---

## 5. パフォーマンス最適化

### コード分割とバンドルサイズ

Discord の初期ロードは約 **700KB**（JS + フォント + 画像 + スタイルシート）:

- **ルートベース分割**: 各ルートのコンポーネントを関数でラップ → Webpack が自動的に別チャンクにバンドル
- **makeLazy ローダー**: チャンク読み込み失敗時に増加間隔でリトライする独自ローダー
- **スタイルシート分割**: CSS も遅延読み込みチャンクに分割
- **アニメーション遅延読み込み**: アプリ全体のアニメーションを遅延読み込み
- **翻訳最適化**: 27言語 × 30KB = 810KB → アクティブ言語のみ読み込み（約 1MB 節約）

### 64ビットアーキテクチャ移行 (2024年12月)

- **動機**: 32bit の 4GB メモリ制限による OOM クラッシュ解消
- **更新機構**: 既存の auto-updater でアーキテクチャ検出 → 64bit ビルド配信
- **フォールバック**: 移行エラー時は自動的に 32bit ビルドに戻る
- **バージョン戦略**: 64bit バージョン番号を +100 して「新しい」と認識させる
- **デルタ更新無効化**: 完全更新で全ファイルの正確な移行を保証
- **結果**: OOM クラッシュ削減、CPU 使用量低下

### モバイルパフォーマンス最適化

#### 起動時間

- React Native 移行後の Android 起動時間を 2023年に半減
- サーバーリスト仮想化: 100+ サーバーユーザーでメモリ 14% 削減、起動時間 10% 短縮

#### レンダリング

- チャットリストのリサイクル最適化: スローフレーム最大 60% 削減
- アニメーション絵文字 GIF → WebP: 低性能デバイスで 60fps 達成
- iOS メディアピッカー: プレビュー生成の 4.5秒待ちを解消

#### 2025年の計画

- React Native New Architecture の安定版有効化
- Static Hermes の検討
- コアストアと通信ロジックを Rust に移行（速度・メモリ改善）

---

## 6. デスクトップアプリ特有の機能

### Electron ベースアーキテクチャ

Discord デスクトップは Electron（Chromium + Node.js）で構築:

- **メリット**: Web と同一コードベース、ネイティブ API アクセス
- **ネイティブ機能**: システムトレイ、通知、ファイルシステムアクセス
- **Electron + WebRTC**: 両方が 64bit ビルドをデフォルトサポート

### グローバルキーボードショートカット

- デスクトップアプリでは Discord がフォーカスされていなくても動作
- **Push-to-Talk**: デスクトップのみシステムワイドで動作（ブラウザはフォーカス時のみ）
- **PTT リリース遅延**: キーバインド離した後の音声カット遅延を調整可能
- 主要ショートカット: ミュート (Ctrl+Shift+M)、切断 (Ctrl+Shift+D)、カメラ (Ctrl+Shift+V)

### In-Game オーバーレイ

- ゲームプレイ中に Discord の VC 情報を表示
- **Windows のみ**: Linux ではサポートなし（サードパーティ代替あり）
- オーバーレイチャットのアクティベーション、トグル、ロックのキーバインド
- DLL インジェクションでゲームのレンダリングパイプラインにアクセス

### ゲーム検出

- 実行中のプロセスを監視してゲームを自動検出
- Rich Presence / Activity 情報の表示
- ゲーム中の最適化（帯域/CPU の使い分け）

### Rich Presence (Activity)

- `ActivityTypes::Playing` で現在のゲーム/アクティビティを表示
- 3行構成: ゲーム名 / Details / State + Party 情報
- SDK ベースのカスタマイズが可能
- StreamKit: OBS 等への Discord オーバーレイ統合

### StreamKit

- OBS/XSplit 等のストリーミングソフトと連携
- 音声/テキストチャットのアクティビティをブラウザソースとして表示
- カスタマイズ可能なウィジェット

---

## 7. インフラストラクチャ

### 開発環境

- **Coder V2**: クラウド開発環境 (VM ベース)
- **Tailscale + WireGuard**: ネットワーキングスタック
- 安定的・安全・高性能なリモート開発を実現

### CDN とメディア配信

- カスタムメディアプロキシ（Go → Rust に移植）
- オンザフライ画像変換（リサイズ、フォーマット変換）
- Lilliput (オープンソース画像処理ライブラリ)
- WebP/AVIF サポートの段階的ロールアウト

---

## 参考リンク

### Discord Engineering Blog
- [How Discord Handles Two and Half Million Concurrent Voice Users using WebRTC](https://discord.com/blog/how-discord-handles-two-and-half-million-concurrent-voice-users-using-webrtc)
- [How Discord Maintains Performance While Adding Features](https://discord.com/blog/how-discord-maintains-performance-while-adding-features)
- [How It All Goes Live: An Overview of Discord's Streaming Technology](https://discord.com/blog/how-it-all-goes-live-an-overview-of-discords-streaming-technology)
- [Using Rust to Scale Elixir for 11 Million Concurrent Users](https://discord.com/blog/using-rust-to-scale-elixir-for-11-million-concurrent-users)
- [Meet DAVE: E2EE for Audio & Video](https://discord.com/blog/meet-dave-e2ee-for-audio-video)
- [How Discord Seamlessly Upgraded Millions of Users to 64-Bit Architecture](https://discord.com/blog/how-discord-seamlessly-upgraded-millions-of-users-to-64-bit-architecture)
- [Modern Image Formats at Discord: Supporting WebP and AVIF](https://discord.com/blog/modern-image-formats-at-discord-supporting-webp-and-avif)
- [Supercharging Discord Mobile: Our Journey to a Faster App](https://discord.com/blog/supercharging-discord-mobile-our-journey-to-a-faster-app)
- [How Discord Moved Engineering to Cloud Development Environments](https://discord.com/blog/how-discord-moved-engineering-to-cloud-development-environments)

### Discord Developer Docs
- [Gateway API](https://docs.discord.com/developers/events/gateway)
- [Voice Connections](https://discord.com/developers/docs/topics/voice-connections)
- [Setting Rich Presence](https://discord.com/developers/docs/discord-social-sdk/development-guides/setting-rich-presence)

### DAVE Protocol
- [DAVE Protocol Whitepaper](https://daveprotocol.com/)
- [GitHub: discord/dave-protocol](https://github.com/discord/dave-protocol)

### 外部解説
- [Does Discord Use React or SolidJS?](https://medium.com/@bhagyarana80/does-discord-use-react-or-solidjs-a-deep-dive-into-their-frontend-stack-7e2874c50198)
- [How Discord Stores Trillions of Messages](https://blog.bytebytego.com/p/how-discord-stores-trillions-of-messages)
- [Discord's Voice Chat Architecture](https://medium.com/@sohail_saifi/the-genius-architecture-behind-discords-voice-chat-that-zoom-could-learn-from-1da9a8c5b08f)
- [Flux and Discord (Zerthox)](https://zerthox.github.io/guides/bd/flux/)

### Krisp
- [Krisp FAQ - Discord](https://support.discord.com/hc/en-us/articles/360040843952-Krisp-FAQ)
- [How We Shrunk DNN to Run Inside Chrome](https://krisp.ai/blog/how-we-shrunk-dnn-to-run-inside-chrome/)
- [Discord Expands Krisp Integration](https://krisp.ai/blog/discord-expands-krisp-integration-to-provide-ai-powered-voice-clarity-to-its-browser-application/)

### Tauri 2 (Nexus 関連)
- [Global Shortcut Plugin](https://v2.tauri.app/plugin/global-shortcut/)
- [System Tray](https://v2.tauri.app/learn/system-tray/)
- [Window Customization](https://v2.tauri.app/learn/window-customization/)
