# アプリケーション仕様 — app-spec.md

> 最終更新: 2026-02-23

## 概要

Nexus は Element Web をフォークし、Discord 風の UI にカスタマイズした Matrix チャットクライアント。
10人以下のプライベート利用を想定。

## 主要機能

| 機能 | 提供元 | 状態 |
|------|--------|------|
| テキストチャット | Element Web (matrix-js-sdk) | Element Web に組み込み済み |
| ボイスチャット (VC) | Element Call (LiveKit) | Element Web に組み込み済み |
| 画面共有 | Element Call (LiveKit) | Element Web に組み込み済み |
| E2E 暗号化 | matrix-js-sdk (Olm/Megolm) | Element Web に組み込み済み |
| Discord 風 UI | Nexus カスタマイズ | **これから実装** |

## UI 構成（Discord 風レイアウト）

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
- Discord のサーバーアイコンバー風
- 縦並びの丸アイコン、ホバーで角丸が変化
- Space = Discord の「サーバー」に対応

#### Channel List（左サイドバー）
- **元コンポーネント**: `LeftPanel`, `RoomList`
- テキストチャンネル（`#` アイコン）とボイスチャンネル（`🔊` アイコン）を視覚的に分離
- カテゴリ別グルーピング

#### Message Area（中央）
- **元コンポーネント**: `RoomView`
- Discord 風のメッセージバブルなしレイアウト
- ユーザー名 + タイムスタンプ + メッセージ本文

#### Member List（右サイドバー）
- ロール別にグルーピング
- オンライン/オフライン状態の表示

## カラースキーム

Discord ダークテーマ風のカラーパレット:

| 用途 | カラーコード | 適用箇所 |
|------|-------------|---------|
| メイン背景 | `#36393f` | Message Area |
| サイドバー背景 | `#2f3136` | Channel List, Member List |
| サーバーバー背景 | `#202225` | Server Bar |
| テキスト | `#dcddde` | 本文テキスト |
| アクセント | `#5865f2` | ボタン、リンク等（Discord Blurple） |

## 不要な UI 要素（非表示にする）

- Element 固有のブランディング（ロゴ、フッター）
- 不要な設定項目
- Element のウェルカム画面 → Nexus カスタムに差し替え

## Phase 別の実装計画

### Phase 1: 環境構築 & 動作確認
Element Web をそのままデプロイし、全機能が動作することを確認

### Phase 2: Discord 風 UI カスタマイズ
1. カラースキームの変更（CSS テーマ）
2. Server Bar のカスタマイズ（SpacePanel）
3. Channel List のカスタマイズ（LeftPanel, RoomList）
4. Message Area のカスタマイズ（RoomView）
5. Member List のカスタマイズ
6. 不要な UI 要素の非表示
7. ウェルカム画面のカスタム

### Phase 3: Tauri 2 ネイティブ化
Web 版の UI が固まった後に着手
