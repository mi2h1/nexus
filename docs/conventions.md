# 開発規約 — conventions.md

> 最終更新: 2026-02-26 (v0.1.7)

## コミットメッセージ

日本語で記述する。以下のフォーマットに従う。

```
type: 変更概要

詳細（必要な場合）

Co-Authored-By: Claude <noreply@anthropic.com>
```

**type 一覧:**
| type | 用途 |
|------|------|
| feat | 新機能追加 |
| fix | バグ修正 |
| refactor | リファクタリング（機能変更なし） |
| style | CSS・見た目の変更 |
| docs | ドキュメントのみの変更 |
| test | テストの追加・修正 |
| chore | ビルド・設定・依存関係等 |

## 命名規則

| 対象 | 規則 | 例 |
|------|------|------|
| TS/JS 関数・変数 | camelCase | `getUserName` |
| React コンポーネント | PascalCase | `ServerSidebar` |
| CSS クラス（新規） | `nx_` + PascalCase | `nx_ServerSidebar` |
| CSS クラス（既存） | `mx_` プレフィックス維持 | `mx_RoomView` |
| ファイル名（コンポーネント） | PascalCase.tsx | `ServerSidebar.tsx` |
| ファイル名（ユーティリティ） | camelCase.ts | `themeUtils.ts` |
| 定数 | UPPER_SNAKE_CASE | `DISCORD_BLURPLE` |
| コード内の名前 | 英語 | — |
| コメント | 日本語 | — |

**Nexus 固有ルール:**
- 新規コンポーネントのCSSクラスは `nx_` プレフィックスを使い、Element 由来の `mx_` と区別する
- Element 由来のコンポーネントを修正する場合は `mx_` プレフィックスを維持する

## 開発プラクティス

### ファイル編集方針
- 既存ファイルの編集を優先し、新規ファイルは必要最小限にする
- Element Web のコードを変更する前に、元のコードの意図を確認する
- CSS 変更時は CSS カスタムプロパティ（変数）の利用を優先する

### ブランチ運用
- `main`: デプロイ対象ブランチ（GitHub Actions で自動デプロイ）
- 機能ブランチ: `feat/機能名`、`fix/修正内容` の形式

### セキュリティ
- config.json にシークレットを含めない
- 外部リソースの読み込みは Element Web 既存のものに限定する
