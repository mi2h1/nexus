# アプリケーション仕様 — app-spec.md

> 最終更新: 2026-02-23

## 概要

Nexus は Element Web をフォークし、Discord 風の**機能構成**にカスタマイズした Matrix チャットクライアント。
10人以下のプライベート利用を想定。

## デザイン方針

- **テーマ/カラー**: Element 標準のまま（ライト/ダーク切替可能）
- **機能構成**: Discord 風（テキスト/VCチャンネル分離等）
- **新規 UI**: Discord を参考にデザイン
- **既存 UI**: Element のデザインをベースにする

## 主要機能

| 機能 | 提供元 | 状態 |
|------|--------|------|
| テキストチャット | Element Web (matrix-js-sdk) | Element Web に組み込み済み |
| ボイスチャット (VC) | Element Call (LiveKit) | Element Web に組み込み済み |
| 画面共有 | Element Call (LiveKit) | Element Web に組み込み済み |
| E2E 暗号化 | matrix-js-sdk (Olm/Megolm) | Element Web に組み込み済み |
| テキスト/VC チャンネル分離 | Nexus カスタマイズ | **これから実装** |

## UI 構成

```
┌──────┬──────────────┬──────────────────────────┬────────────┐
│Server│ Channel List │      Message Area         │  Member    │
│ Bar  │              │                           │  List      │
│      │ # general    │  User1         12:34      │            │
│ [S1] │ # random     │  メッセージ内容           │  Online    │
│ [S2] │              │                           │  ── User1  │
│ [S3] │ Voice        │  User2         12:35      │  ── User2  │
│      │ 🔊 VC-1     │  メッセージ内容           │            │
│      │ 🔊 VC-2     │                           │  Offline   │
│      │              │                           │  ── User3  │
│      │              ├──────────────────────────┤            │
│      │              │  [メッセージ入力欄]       │            │
└──────┴──────────────┴──────────────────────────┴────────────┘
```

### 各エリアの詳細

#### Server Bar（左端）
- **元コンポーネント**: `SpacePanel`
- Space = Discord の「サーバー」に対応

#### Channel List（左サイドバー）
- **元コンポーネント**: `LeftPanel`, `RoomList`
- テキストチャンネル（`#` アイコン）とボイスチャンネル（`🔊` アイコン）を視覚的に分離
- カテゴリ別グルーピング

#### Message Area（中央）
- **元コンポーネント**: `RoomView`
- ユーザー名 + タイムスタンプ + メッセージ本文

#### Member List（右サイドバー）
- ロール別にグルーピング
- オンライン/オフライン状態の表示

## 無効化した機能

| 機能 | 方法 |
|------|------|
| インテグレーションマネージャ (Scalar) | config から削除 |
| Jitsi | Element Call に一本化 (use_exclusively) |
| 公開ルーム/スペース作成 | UIFeature で無効化 |
| フィードバック/バグ報告 | UIFeature で無効化 |
| 位置情報共有 | UIFeature で無効化 |
| SNS共有/QRコード共有 | UIFeature で無効化 |
| IDサーバー/サードパーティID | UIFeature で無効化 |
| ルーム一覧フィルター | コードで非表示 |
| ルームヘッダーの通話ボタン | コードで非表示 |
| メンバーのステートイベント | setting_defaults で非表示 |

## Phase 別の実装計画

### Phase 1: 環境構築 & 動作確認 ✅
Element Web をそのままデプロイし、全機能が動作することを確認

### Phase 2: 機能カスタマイズ（進行中）
1. ~~カラースキームの変更~~ → Element 標準のまま
2. 不要機能の無効化 ✅
3. ブランディング差し替え ✅
4. テキスト/VC チャンネル分離
5. 不要な UI 要素の非表示 ✅

### Phase 3: Tauri 2 ネイティブ化
Web 版の UI が固まった後に着手
