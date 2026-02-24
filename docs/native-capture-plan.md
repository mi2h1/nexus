# ネイティブ画面キャプチャ — 段階的実装計画

> 作成: 2026-02-28
> ステータス: 未着手（前回の一括実装を revert 済み）

## 背景

### 現状の問題（`getDisplayMedia` ベース）
- **共有バー表示**: 「tauri.localhost はウィンドウを共有しています」が消せない
- **音声不安定**: WebView2 の WASAPI ハンドリングで `NotReadableError` が頻発
- **ブラウザピッカー**: タブ一覧など不要な選択肢が出る
- **権限ダイアログ**: 毎回 OS の許可プロンプトが表示される

### 目標
Rust 側で DXGI (映像) + WASAPI (音声) を直接制御し、Tauri 版で `getDisplayMedia` を完全置換する。
ブラウザ版は従来の `getDisplayMedia` のまま。

---

## 前回の反省点

### やってしまったこと
1. **一括実装**: Rust キャプチャ + WASAPI + ピッカーUI + 音声パイプライン変更を1コミットで投入
2. **ブラウザ版への影響**: `NexusVoiceConnection.ts` の `onTrackSubscribed` 等を変更した結果、ブラウザ版の音声再生にもバグが波及
3. **WASAPI の複雑さ過小評価**: プロセス除外ループバック (Win10 2004+) の COM API が想定以上に難しく、12コミット分の修正が必要になった
4. **デバッグ困難**: 問題が Rust 側か JS 側か切り分けできず、「VCに一人で入っても声が返ってくる」原因を特定できなかった

### 教訓
- **ブラウザ版の `onTrackSubscribed` は絶対に壊さない** — 変更は Tauri 専用パスを追加する形にする
- **Rust の音声キャプチャは単体で動作確認してから統合する**
- **各ステップでブラウザ版の動作確認を挟む**
- **WASAPI プロセス除外ループバックは最初から fallback 前提で設計する**

---

## 実装ステップ

### Step 1: ピッカー + 映像キャプチャ（音声なし）— 一括実装OK

**ゴール**: Tauri 版で Discord 風ピッカーから画面を選んで映像を配信できる。ブラウザ版は一切変更なし。

**安全な理由**: 既存コードへの変更は `startScreenShare()` に Tauri 分岐を追加するだけ。受信側（`onTrackSubscribed`）は触らない。LiveKit に publish された映像トラックはブラウザの `getDisplayMedia` と同じ `RemoteTrackPublication` として受信されるため、受信側の変更は不要。

#### 新規ファイル（既存コード影響ゼロ）
| ファイル | 内容 |
|---------|------|
| `src-tauri/src/capture.rs` | Rust キャプチャ: `enumerate_capture_targets`, `start_capture`, `stop_capture` |
| `src/utils/NexusNativeCapture.ts` | `NativeVideoCaptureStream` のみ（JPEG → Canvas → captureStream） |
| `src/components/views/voip/NexusScreenSharePicker.tsx` | Discord 風ピッカー UI |
| `res/css/views/voip/_NexusScreenSharePicker.pcss` | ピッカースタイル |

#### 変更ファイル
| ファイル | 変更内容 | リスク |
|---------|---------|--------|
| `src-tauri/Cargo.toml` | `windows-capture`, `turbojpeg` 追加（`wasapi` はまだ入れない） | なし（Rust のみ） |
| `src-tauri/src/lib.rs` | `capture` モジュール登録 + `invoke_handler` | なし（Rust のみ） |
| `res/css/_components.pcss` | ピッカー CSS import 追加 | なし |
| `src/models/NexusVoiceConnection.ts` | `startScreenShare()` に Tauri 分岐追加 | **低**（下記ルール厳守） |
| `src/components/views/voip/NexusScreenSharePanel.tsx` | Tauri 時にピッカーを開く分岐 | **低** |

#### NexusVoiceConnection.ts の変更ルール（厳守）
```typescript
async startScreenShare(): Promise<void> {
    if (isTauri()) {
        await this.startNativeScreenShare();  // 新規メソッド追加
    } else {
        // ★ 既存コードは一文字も変えない ★
    }
}

// stopScreenShare() も同様: Tauri 時に invoke("stop_capture") を追加するだけ
```

- `onTrackSubscribed` は **絶対に変更しない**
- `onTrackMuted` / `onTrackUnmuted` も **変更しない**
- 新規メソッド `startNativeScreenShare()` を追加するだけ

#### 確認チェックリスト
- [ ] ブラウザ版 (`pnpm start`) で VC 接続・画面共有が従来通り動作する
- [ ] ブラウザ版で画面共有の音声が正常に聞こえる
- [ ] Tauri 版でピッカーが開き、ウィンドウ/モニター一覧が表示される
- [ ] Tauri 版で選択 → 映像が配信される（音声なし）
- [ ] 別端末/ブラウザで Tauri 版の画面共有映像が見える
- [ ] 画面共有停止が正常に動作する（リソースリークなし）

---

### Step 2: WASAPI 音声キャプチャ（通常ループバック）

**ゴール**: 画面共有に音声を追加。まず通常ループバック（全システム音声キャプチャ）で動作確認。

**前提**: Step 1 が完了し、映像のみの画面共有が安定している状態。

**ファイル変更**:
- `src-tauri/Cargo.toml` — `wasapi` 追加
- `src-tauri/src/capture.rs` — WASAPI 通常ループバック実装（`wasapi` クレート API のみ）
- `src/utils/NexusNativeCapture.ts` — `NativeAudioCaptureStream` 追加
- `src/models/NexusVoiceConnection.ts` — `startNativeScreenShare()` に音声パスを追加

**注意**:
- `onTrackSubscribed` の受信側は **変更しない**（受信側は既に ScreenShareAudio を正しく処理できている）
- 8ch → stereo ダウンミックスは最初から入れる（7.1ch デバイスが一般的）
- プロセス除外はまだ入れない（通常ループバックで音声が届くことをまず確認）
- **既知の制約**: 通常ループバックでは VC の声も混ざる（Step 3 で対応）

**確認チェックリスト**:
- [ ] ブラウザ版が壊れていないこと（リグレッション確認）
- [ ] Tauri 版で画面共有 → 映像+音声が配信される
- [ ] 別端末で音声が聞こえる

---

### Step 3: WASAPI プロセス除外ループバック（オプション）

**ゴール**: 自プロセスの音声を除外して、VC の声がループバックしないようにする。

**前提**: Step 2 が完了し、通常ループバックで映像+音声が動いている状態。

**ファイル変更**:
- `src-tauri/src/capture.rs` — プロセス除外ループバック追加
- `src-tauri/Cargo.toml` — `windows`, `windows-core` 追加

**Windows COM API の注意点**（前回の経験）:
- `ActivateAudioInterfaceAsync` + `PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE`
- 仮想デバイスは `GetMixFormat` 非対応 → 実デバイスからフォーマット取得必須
- `AUTOCONVERTPCM` 非対応 → デバイスネイティブフォーマット（8ch 等）をそのまま使う
- `#[windows::core::implement]` マクロが `windows_core` クレートを直接参照 → 明示的に依存追加
- デバイスフォーマットは `wasapi` クレートで実デバイスから取得し、ポインタをワイルドカードキャスト

**fallback 設計**:
```rust
fn run_wasapi_loopback(app, stop_flag) -> Result<()> {
    match run_process_excluded_loopback(&app, &stop_flag) {
        Ok(()) => Ok(()),
        Err(e) => {
            log!("Process-excluded unavailable: {}. Falling back.", e);
            run_regular_loopback(app, stop_flag)
        }
    }
}
```

**確認チェックリスト**:
- [ ] git bash で `[WASAPI] Process-excluded loopback capture started` が出る（fallback なし）
- [ ] VC で自分の声が返ってこない
- [ ] ブラウザ版が壊れていない

---

## チェックリスト（各ステップ共通）

- [ ] ブラウザ版 (`pnpm start`) で VC 接続・画面共有が従来通り動作する
- [ ] Tauri 版 (`pnpm tauri:dev`) で VC 接続が正常に動作する
- [ ] `onTrackSubscribed` の既存ロジックに変更がない
- [ ] 画面共有開始/停止で SE が正常に鳴る
- [ ] 画面共有停止後にリソースリークがない（canvas, AudioContext, audio 要素）

---

## アーキテクチャ概要図

```
ユーザー: 画面共有ボタンクリック
    │
    ├─ [ブラウザ版] getDisplayMedia() → 従来フロー（変更なし）
    │
    └─ [Tauri 版]
        │
        ▼
    [Step 1] invoke("enumerate_capture_targets")
        │  Rust: windows-capture で Window/Monitor 列挙
        ▼
    [Step 2] カスタムピッカー UI (React)
        │  Discord 風: ウィンドウ/画面タブ + サムネイル
        ▼
    [Step 1] invoke("start_capture", { targetId, fps, captureAudio })
        │  Rust: WGC キャプチャ開始
        │  [Step 4] + WASAPI ループバック開始
        ▼
    Rust → JS フレーム転送 (Tauri Events)
        │  [Step 1] 映像: JPEG圧縮 → "capture-frame"
        │  [Step 4] 音声: PCM f32 → "capture-audio"
        ▼
    JS 側でトラック生成
        │  [Step 3] 映像: JPEG → ImageBitmap → Canvas → captureStream()
        │  [Step 5] 音声: f32 → ScriptProcessorNode → MediaStream
        ▼
    LiveKit publish（既存フロー）
        ▼
    invoke("stop_capture") で停止
```

## Cargo.toml 依存（Windows のみ）

```toml
# Step 1: 映像キャプチャ
windows-capture = "1.5"    # WGC 画面キャプチャ + ウィンドウ/モニター列挙
turbojpeg = "1"             # 高速 JPEG エンコード

# Step 4: 音声キャプチャ
wasapi = "0.22"             # WASAPI ループバック

# Step 6: プロセス除外ループバック（オプション）
windows = { version = "0.58", features = [
    "Win32_Media_Audio",
    "Win32_Foundation",
    "Win32_System_Threading",
    "Win32_System_Com",
    "Win32_Security",
    "implement",
] }
windows-core = "0.58"
```
