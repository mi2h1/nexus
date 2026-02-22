# Nexus — CLAUDE.md

## Project Goal
- **目的**: Element Web をフォークし、Discord 風 UI のチャットアプリを作る
- **成果物**: GitHub Pages でホストする Web アプリ（将来 Tauri 2 でネイティブ化）
- **優先順位**: 動作する > 見た目が良い > 速度が速い

## Non-Negotiables
- 日本語で会話する（カジュアル敬語）
- 質問と命令を区別する（質問=調査のみ / 命令=実作業）
- 破壊的変更は事前に影響範囲と代替案を提示
- 既存のテスト・設定・仕様は勝手に変えない
- 秘密情報は出力しない
- 不確かな内容は断定しない
- Element Web 由来のコードを変更する際は、元のコードの意図を理解してから行う
- ビルドは GitHub Actions に任せる（VPS でビルドしない）
- `/handover` と言われたら HANDOVER.md を生成する

## Output Format
- 結論 → 根拠 → 手順 の順で返す
- コード修正は変更箇所と理由を明示する
- CSS 変更時は影響を受けるコンポーネントを列挙する

## Reference
- [HANDOVER.md](./HANDOVER.md) — セッション引き継ぎ
- [docs/conventions.md](./docs/conventions.md) — 開発規約
- [docs/progress.md](./docs/progress.md) — 進捗・タスク
- [docs/tech-stack.md](./docs/tech-stack.md) — 技術スタック詳細
- [docs/app-spec.md](./docs/app-spec.md) — アプリ仕様・UI設計
