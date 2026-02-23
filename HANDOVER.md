# Nexus プロジェクト - Claude Code 引継書

## プロジェクト概要

**Nexus** は、Element Web（Matrix クライアント）をフォークして、Discord 風の UI にカスタマイズするプロジェクト。

### ゴール
- Discord ライクな UI のチャットアプリを作る
- テキストチャット、ボイスチャット（VC）、画面共有が必須機能
- Windows で動けばよい（まずは Web 版、将来 Tauri 2 でネイティブ化）
- 完全無料で運用する

### ユーザー規模
- 10人以下のプライベート利用

---

## アーキテクチャ

```
開発環境 (VPS: Ubuntu 25.04, 3コア/4GB RAM)
  └ Claude Code でコード編集 → git push
      ↓
GitHub Actions
  └ pnpm install → pnpm build → GitHub Pages にデプロイ
      ↓
https://<github-username>.github.io/nexus/
  └ ユーザーがブラウザでアクセス
  └ matrix.org アカウントでログイン
  └ テキストチャット / VC / 画面共有 すべて利用可能
```

### サーバー構成
- **Matrix サーバー**: matrix.org の公開サーバーを利用（自前サーバー不要）
- **クライアントホスティング**: GitHub Pages（無料）
- **VC / 画面共有**: Element Call（matrix.org が提供する LiveKit インフラ）
- **CI/CD**: GitHub Actions（無料）
- **ドメイン**: 不要（GitHub Pages の URL を使用）

### コスト
- **完全無料**（ドメイン取得なし、サーバー運用なし）

---

## 技術スタック

| 技術 | 用途 |
|------|------|
| Element Web (フォーク) | ベースとなる Matrix クライアント |
| React + TypeScript | UI フレームワーク |
| matrix-js-sdk | Matrix プロトコル通信 + MatrixRTC シグナリング |
| matrix-react-sdk | Element Web に統合済み |
| livekit-client | VC・画面共有（LiveKit SFU 直接接続） |
| Cloudflare Workers | LiveKit JWT 取得用 CORS プロキシ |
| Webpack | ビルドツール（Element Web 標準） |
| GitHub Actions | CI/CD（ビルド & デプロイ） |
| GitHub Pages | 静的ファイルホスティング |

---

## 開発環境セットアップ

### 前提条件
- Node.js LTS (v20 以上)
- pnpm 10.x（Element Web 標準）
- Git

### 初期セットアップ手順

```bash
# 1. Element Web をフォークした自分のリポジトリをクローン
git clone https://github.com/<github-username>/nexus.git
cd nexus

# 2. 依存関係インストール
pnpm install

# 3. 設定ファイル作成
cp config.sample.json config.json

# 4. config.json を編集（matrix.org をデフォルトサーバーに設定）
# → default_server_config の内容を確認・調整

# 5. ローカル開発サーバー起動（確認用、VPS では不要な場合が多い）
pnpm start
```

### 重要: matrix-react-sdk は element-web に統合済み
以前は matrix-react-sdk が別リポジトリだったが、現在は element-web リポジトリに統合されている。フォークは element-web の単一リポだけでOK。

- リポジトリ: https://github.com/element-hq/element-web
- ライセンス: AGPL-3.0（私的利用は問題なし）

---

## GitHub Actions デプロイ設定

リポジトリに `.github/workflows/deploy.yml` を作成：

```yaml
name: Deploy to GitHub Pages

on:
  push:
    branches: [main]

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: "pages"
  cancel-in-progress: false

jobs:
  build-and-deploy:
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'yarn'

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Build
        run: pnpm build

      - name: Setup Pages
        uses: actions/configure-pages@v4

      - name: Upload artifact
        uses: actions/upload-pages-artifact@v3
        with:
          path: ./webapp

      - name: Deploy to GitHub Pages
        id: deployment
        uses: actions/deploy-pages@v4
```

### GitHub リポジトリ設定
1. Settings → Pages → Source を「GitHub Actions」に変更
2. リポジトリは public にする（GitHub Pages の無料利用条件）

---

## カスタマイズ方針

### Phase 1: 環境構築 & 動作確認
1. element-web をフォーク（リポジトリ名を nexus に変更）
2. VPS にクローン
3. config.json で matrix.org をデフォルトサーバーに設定
4. GitHub Actions でビルド & GitHub Pages にデプロイ
5. ブラウザでアクセスし、ログイン・テキストチャット・VC・画面共有が動作することを確認

### Phase 2: Discord 風 UI カスタマイズ ✅
実装済み：

#### 2.1 レイアウト
- テキスト/VC チャンネル分離（NexusChannelListView）
- VC チャンネル参加者リスト（VoiceChannelParticipants）
- Discord 風ユーザーパネル（NexusUserPanel）
- 通話ステータスパネル（NexusCallStatusPanel）

#### 2.2 テーマ/カラー
- Element 標準のまま（ライト/ダーク切替可能を維持）

#### 2.3 不要要素の非表示
- Element ブランディングを Nexus に差し替え
- 不要機能の無効化（詳細は docs/app-spec.md 参照）

### Phase 2.5: 通話機能の内包 ✅
- Element Call iframe を廃止し livekit-client で直接接続
- NexusVoiceConnection: LiveKit SFU + MatrixRTC シグナリング
- VC ルームビュー: 参加者グリッド + コントロールバー + 画面共有
- 画面共有: 720p30 エンコーディング + 360p15 simulcast + contentHint: detail（Discord 準拠）
- 画面共有オプトイン視聴: Discord 準拠（プレビューオーバーレイ + クリックで視聴開始）
- VC 接続高速化: JWT取得+マイクアクセス+WASMプリロードを並列実行（最大500ms短縮）
- 個別音量調整、入力/出力音量調整（2カラム設定UI）、入力感度（ボイスゲート）
- 設定画面マイクゲージ: VC未接続時も独立した getUserMedia+AnalyserNode で動作
- 発話検出（ローカル: 自前 inputLevel / リモート: LiveKit isSpeaking）、Ping 表示
- 入退室 SE（standby → join → leave）、ミュート/アンミュート SE
- マイクミュートは `mediaStreamTrack.enabled` 直接操作（処理済みトラック publish のため）
- VC 接続高速化の調査・設計ドキュメント: docs/vc-optimization.md

### Phase 3: 将来のネイティブ化（Tauri 2）
- Web 版の UI が固まった後に着手
- Tauri 2 で Web アプリをラップして Windows ネイティブアプリ化
- Electron より軽量（OS の WebView を使用、Chromium 同梱不要）
- インストーラーサイズ数 MB レベル

---

## config.json の設定

```json
{
    "default_server_config": {
        "m.homeserver": {
            "base_url": "https://matrix.org",
            "server_name": "matrix.org"
        },
        "m.identity_server": {
            "base_url": "https://vector.im"
        }
    },
    "brand": "Nexus",
    "integrations_ui_url": "https://scalar.vector.im/",
    "integrations_rest_url": "https://scalar.vector.im/api",
    "bug_report_endpoint_url": "",
    "show_labs_settings": false,
    "default_theme": "dark"
}
```

---

## プロジェクト構造（element-web 主要ディレクトリ）

```
nexus/                          # element-web フォーク
├── src/                        # メインソースコード
│   ├── vector/                 # エントリーポイント
│   ├── components/             # React コンポーネント（UI の核心部分）
│   │   ├── structures/         # 状態管理を含む構造コンポーネント
│   │   │   ├── RoomView.tsx    # チャットルーム表示
│   │   │   ├── SpacePanel.tsx  # Space（サーバー）パネル ★カスタマイズ重要
│   │   │   ├── LeftPanel.tsx   # 左パネル全体 ★カスタマイズ重要
│   │   │   └── RoomList.tsx    # ルーム一覧 ★カスタマイズ重要
│   │   └── views/              # 表示専用コンポーネント
│   │       ├── rooms/          # ルーム関連 UI
│   │       ├── messages/       # メッセージ表示
│   │       ├── voip/           # VC・ビデオ通話 UI
│   │       └── elements/       # 共通 UI 要素
│   ├── settings/               # アプリ設定
│   ├── stores/                 # 状態管理ストア
│   └── utils/                  # ユーティリティ
├── res/                        # リソースファイル
│   ├── css/                    # CSS ★テーマ変更の中心
│   │   ├── structures/         # 構造コンポーネントの CSS
│   │   └── views/              # ビューコンポーネントの CSS
│   └── themes/                 # テーマ定義
│       ├── dark/               # ダークテーマ ★ベースにする
│       └── light/              # ライトテーマ
├── config.sample.json          # 設定テンプレート
├── config.json                 # 実際の設定（要作成）
├── webapp/                     # ビルド出力先（GitHub Pages にデプロイ）
├── package.json
└── .github/
    └── workflows/
        └── deploy.yml          # GitHub Actions デプロイ設定（要作成）
```

---

## CSS 命名規則

- クラス名プレフィックス: `mx_`
- コンポーネント対応: `mx_ComponentName`（例: `mx_RoomView`, `mx_SpacePanel`）
- サブ要素: `mx_ComponentName_subElement`（例: `mx_RoomView_body`）
- テーマ変数: CSS カスタムプロパティ（`--cpd-color-*` 等）で定義

---

## 開発時の注意点

### VPS での開発について
- VPS（3コア/4GB RAM）ではコード編集のみ行い、ビルドは GitHub Actions に任せる
- `pnpm install` は VPS 上でも可能だが、ディスク残り 11GB に注意
- ローカルプレビューが必要な場合は `pnpm start` でも動くが、メモリ消費に注意

### ビルドの流れ
1. Claude Code でコード編集
2. `git add . && git commit -m "message" && git push`
3. GitHub Actions が自動でビルド & デプロイ
4. 数分後に GitHub Pages の URL で確認

### CSS ホットリロード
- ローカルで開発する場合、`.env` ファイルに `CSS_HOT_RELOAD=1` を設定すると CSS 変更が即座に反映される

---

## 最初にやるべきこと（Step by Step）

### Step 1: フォーク & クローン
```bash
# GitHub で element-hq/element-web をフォーク
# フォーク先のリポジトリ名を "nexus" に変更

git clone https://github.com/<github-username>/nexus.git
cd nexus
```

### Step 2: config.json を作成
```bash
cp config.sample.json config.json
# 上記「config.json の設定」セクションの内容に編集
```

### Step 3: GitHub Actions ワークフロー作成
```bash
mkdir -p .github/workflows
# 上記「GitHub Actions デプロイ設定」セクションの deploy.yml を作成
```

### Step 4: 初回デプロイ
```bash
git add .
git commit -m "Initial setup: config and CI/CD"
git push origin main
```

### Step 5: 動作確認
- GitHub リポジトリの Settings → Pages で Source を「GitHub Actions」に設定
- Actions タブでビルドが成功することを確認
- `https://<github-username>.github.io/nexus/` にアクセス
- matrix.org アカウントでログイン
- テキストメッセージの送受信を確認
- VC（音声通話）の動作を確認
- 画面共有の動作を確認

### Step 6: Discord 風カスタマイズ開始
- ここからが本番。Phase 2 のカスタマイズ方針に沿って UI を変更していく
- まずはカラースキームの変更（CSS テーマ）から始めるのがおすすめ
- 次にレイアウト変更（SpacePanel, LeftPanel, RoomList の改造）

---

## 将来の Tauri 2 ネイティブ化メモ

Web 版の UI カスタマイズが完了した後に着手：

```bash
# Tauri 2 プロジェクト初期化（nexus ディレクトリ内で）
npm install -g @tauri-apps/cli
tauri init

# Tauri の設定で、element-web のビルド出力（webapp/）を指すようにする
# tauri.conf.json の devUrl と frontendDist を設定

# Windows ネイティブアプリとしてビルド
tauri build
```

Tauri 2 は Web 技術をそのまま OS の WebView で表示するため、Element Web のビルド出力がそのまま使える。Electron と違い Chromium を同梱しないので、アプリサイズが非常に小さい。

---

## 参考リンク

- Element Web リポジトリ: https://github.com/element-hq/element-web
- Matrix JS SDK: https://github.com/matrix-org/matrix-js-sdk
- Element Call: https://github.com/element-hq/element-call
- Matrix Spec: https://spec.matrix.org/latest/
- Tauri 2 Docs: https://v2.tauri.app/
- GitHub Pages Docs: https://docs.github.com/en/pages

---

## 意思決定の経緯

このプロジェクトの方針は以下の検討を経て決定された：

1. **Matrix プロトコルを採用** → E2EE、セルフホスト可能、オープンスタンダード
2. **ゼロから作るのではなく既存クライアントをフォーク** → 開発効率重視
3. **Cinny ではなく Element Web を選択** → VC・画面共有が既に動作するため
4. **matrix.org を使用（自前サーバーなし）** → 無料運用、ユーザー管理不要
5. **GitHub Pages でホスティング** → 無料、既存の開発ワークフローと一致
6. **ビルドは GitHub Actions** → VPS のリソースを使わない
7. **将来は Tauri 2 でネイティブ化** → Electron より軽量、Web 版の資産をそのまま利用可能
