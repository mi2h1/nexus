# 技術スタック — tech-stack.md

> 最終更新: 2026-03-11

## 実行環境

| 項目 | 内容 |
|------|------|
| 開発環境 | VPS: Ubuntu 25.04, 3コア/4GB RAM |
| Node.js | v20 LTS 以上 |
| パッケージマネージャ | pnpm 10.x（Element Web 標準） |
| ビルド | GitHub Actions（VPS ではビルドしない） |
| ホスティング | GitHub Pages（静的ファイル配信） |

## フロントエンド

| 技術 | バージョン | 役割 |
|------|-----------|------|
| Element Web | latest (フォーク) | ベースとなる Matrix クライアント |
| React | Element Web 同梱 | UI フレームワーク |
| TypeScript | Element Web 同梱 | 型安全な開発 |
| Webpack | Element Web 同梱 | バンドラー |
| matrix-js-sdk | Element Web 同梱 | Matrix プロトコル通信（MatrixRTC シグナリング含む） |
| matrix-react-sdk | Element Web に統合済み | UI コンポーネント群 |
| livekit-client | Element Web 同梱 | VC・画面共有（LiveKit SFU 直接接続） |
| @hello-pangea/dnd | ^18.0.0 | スペースパネルのドラッグ&ドロップ（react-beautiful-dnd の React 19 対応 fork） |
| @sapphi-red/web-noise-suppressor | latest | RNNoise AI ノイズキャンセリング（WASM AudioWorklet, 48kHz ネイティブ） |
| Web Audio API | ブラウザ標準 | 入力音声処理（HPF・EQ・AGC・コンプレッサー・ボイスゲート・レベル監視） |

## インフラ・サービス

| サービス | 用途 | コスト |
|---------|------|--------|
| matrix.org | Matrix ホームサーバー（公開サーバー利用） | 無料 |
| GitHub Pages | クライアントホスティング | 無料 |
| GitHub Actions | CI/CD（ビルド & デプロイ） | 無料 |
| LiveKit SFU (自前 VPS) | VC・画面共有の SFU インフラ (lche2.xvps.jp) | VPS 費用 |
| lk-jwt-service (カスタムビルド) | Matrix OpenID → LiveKit JWT 変換 + ユーザーホワイトリスト + ユーザーカラー保存 | 同上 |
| Cloudflare Workers | LiveKit JWT 取得用 CORS プロキシ（フォールバック） | 無料 |

## ネイティブアプリ（Tauri 2）

| 技術 | 用途 |
|------|------|
| Tauri 2 | Windows ネイティブデスクトップアプリ（v0.1.10） |
| tauri-plugin-updater | 自動更新（GitHub Release + latest.json） |
| tauri-plugin-http | CORS バイパス（JWT 取得等） |
| Windows Graphics Capture (WGC) | ネイティブ画面キャプチャ（映像） |
| WASAPI Process Loopback | ネイティブ音声キャプチャ（プロセス単位 INCLUDE/EXCLUDE） |
| windows-capture | WGC Rust バインディング |
| turbojpeg | サムネイル JPEG エンコード |

## 将来追加予定

| 技術 | 用途 | 時期 |
|------|------|------|
| dtln-rs / DeepFilterNet3 | 次世代ノイズキャンセリング（RNNoise より高品質） | dtln-rs の 48kHz 対応待ち / DeepFilterNet の WASM 安定化待ち |

## CSS アーキテクチャ

- Element Web 既存: `mx_` プレフィックス + CSS カスタムプロパティ (`--cpd-color-*`)
- Nexus 新規: `nx_` プレフィックス（`mx_Nexus*` も一部使用）
- テーマ定義: `res/themes/` ディレクトリ
- コンポーネント CSS: 各コンポーネントと同ディレクトリに配置

## VC 通信フロー

```
ブラウザ (Nexus)
  │
  ├─ Web Audio API 入力パイプライン
  │    マイク(EC:on, NS:off, AGC:off, 48kHz)
  │    → HPF(80Hz) → [RNNoise WASM] → Analyser → Delay(50ms)
  │    → VoiceGate(GainNode) → EQ(350Hz/-3dB, 3kHz/+2.5dB)
  │    → AGC(VAD連動) → Compressor → 処理済みトラック
  │
  ├─ Web Audio API 出力パイプライン
  │    ├─ ブラウザ: HTMLAudioElement (マスター音量適用, 0-100%)
  │    └─ Tauri: MediaStreamSource → GainNode → masterGain (0-200%)
  │
  ├─ MatrixRTC (matrix-js-sdk)
  │    └─ m.call.member ステートイベントで参加/退出を通知
  │
  └─ LiveKit SFU (livekit-client)
       ├─ 処理済み音声トラック送信 (Opus 128kbps, DTX:off, RED:on)
       ├─ リモート音声トラック受信
       ├─ 画面共有トラック送受信 (720p30 + 360p15 simulcast)
       └─ WebRTC stats（遅延計測、publisher/subscriber PC 両対応）
```
