# 08. `@rpg/audio-*` / `@rpg/input-*` — AudioOut と InputSource アダプタ

## AudioOut

### 責務
- `runtime` の `AudioOut` ポート実装。BGM（ループ・フェード・ピッチ）と SE の再生。
- `audio-webaudio`：Web Audio API。`audio-null`：呼び出し記録のみ。

### 公開インターフェース
```ts
export function createWebAudioOut(ctx: AudioContext, assets: AssetSource): AudioOut;
export interface NullAudioOut extends AudioOut { calls: { method: string; args: unknown[] }[]; clear(): void }
export function createNullAudioOut(): NullAudioOut;
```

### 実装指針（webaudio）
- ブラウザの自動再生制限：`AudioContext.state === "suspended"` の間は要求をキューに入れ、初回ユーザー操作で `resume()` 後に再生。
- `playBgm` は同じ `asset` が再生中なら no-op（volume/pitch 差分のみ反映）。
- `AudioHandle` は `AudioBuffer`。デコードは `AssetSource` 側で済ませる。
- フェードは `GainNode.linearRampToValueAtTime`。

### 不変条件
1. `playBgm` 連打で多重再生しない。
2. `dispose` 後の呼び出しは no-op。
3. `suspended` 中でも例外を投げない。

### テスト要件
- 契約テスト `contracts/audioOut.contract.ts`：呼び出し順序で例外が出ないこと、null 実装が記録すること。
- webaudio：`standardized-audio-context-mock` または自前のモック `AudioContext` で `GainNode` のランプ呼び出しを検証。多重再生防止。

---

## InputSource

### 責務
- `runtime` の `InputSource` ポート実装。デバイス入力を `InputFrame`（抽象ボタン）へ変換。
- `input-browser`：キーボード・ゲームパッド・タッチ/ポインタ。`input-script`：事前定義した `InputFrame[]` を順に返す（リプレイ用）。

### 公開インターフェース
```ts
export interface KeyMap { [key: string]: Button }      // e.g. { "ArrowUp": "up", "KeyZ": "ok", "KeyX": "cancel" }
export const defaultKeyMap: KeyMap;
export function createBrowserInput(target: EventTarget, opts?: { keyMap?: KeyMap; gamepad?: boolean; touch?: { canvas: HTMLCanvasElement } }): InputSource;

export interface ScriptInput extends InputSource { push(...frames: InputFrame[]): void; remaining(): number }
export function createScriptInput(frames?: InputFrame[]): ScriptInput;
export function keys(...buttons: Button[]): InputFrame;            // ヘルパ：1フレーム押下
export function hold(button: Button, frames: number): InputFrame[]; // ヘルパ：n フレーム押し続け
```

### 実装指針（browser）
- `keydown`/`keyup` を購読し内部状態を更新。`poll()` は `pressed` をコピーし、`triggered` を返してクリアする。
- タッチ：仮想十字キー領域と OK/キャンセル領域を canvas 座標で判定。`pointer` も `InputFrame` に含める。
- ゲームパッド：`poll()` 時に `navigator.getGamepads()` を読む。
- `input-script`：フレームが尽きたら空の `InputFrame` を返し続ける。

### 不変条件
1. `triggered ⊆ pressed`。
2. `poll()` を2回連続で呼ぶと2回目の `triggered` は空。
3. `input-script` は同じフレーム列に対して同じ出力（決定論）。

### テスト要件
- 契約テスト `contracts/inputSource.contract.ts`：上記不変条件 1, 2。
- browser：jsdom で `KeyboardEvent` を dispatch し `poll()` を検証。キーマップ差し替え。
- script：`push` → `poll` の順序性、枯渇後の空フレーム。

## 完了条件
- null/script 実装と契約テストが先に完成し、06 のハーネスで使える。
- browser 実装が `apps/player` で動作する。

## 実装メモ（M2 で確定した点）
- **実装済み**：`audio-null`、`input-script`、`input-browser`（キーボード・ゲームパッド）。`audio-webaudio` は M4。**ポインタ座標（`InputFrame.pointer`）は未実装**（後続）。タッチの操作パッド（仮想十字キー・ボタン）は実装済み（下記）。
- `NullAudioOut.calls` の要素は `{ method, args }`。`dispose` 自体は記録され、それ以降の呼び出しは記録されない。
- `input-script`：`createScriptInput(frames?)` は `push` / `remaining` を持ち、`dispose` で残りを捨てる。`keys(...buttons)` は押下開始を含む 1 フレーム、`hold(button, n)` は最初のフレームだけ押下開始。
- `input-browser`：`KeyMap` のキーは `KeyboardEvent.code`（`ArrowUp`、`KeyZ` など）。既定は 方向 = 矢印/WASD、決定 = Z/Enter/Space、キャンセル = X/Esc、メニュー = M、shift = Shift、pageup/down = PageUp/PageDown。割り当てたキーは `preventDefault` する（スクロール防止）。キーリピートは新しい押下として数えない。`poll` の間に押して離したボタンも、そのフレームは `pressed` かつ `triggered` に入る（不変条件 1 を保つ）。`blur` で押しっぱなしを解除する。ゲームパッドは `{ gamepad: true }` で有効（標準配置：A = 決定、B = キャンセル、X / RT = 走る（shift）、Y = メニュー、LB/RB = pageup/down、十字キーとスティック）。
- **タッチ（操作パッド）**：判定と見た目を分けている。`input-browser` は DOM を持たない判定ロジックだけ：`createTouchInput()` は `pointerDown(id, control, at)` / `pointerMove` / `pointerUp` / `releaseAll` を受け取り、`InputSource` として `poll` できる（`held()` は見た目用）。`control` は `{ kind: "button", button }` か `{ kind: "dpad", radius, deadZone? }`。十字キーは `dpadButtons(offset, radius)` で中心からの位置を 8 方向（斜めは 2 ボタン、境目は 22.5°、中心付近はデッドゾーン）に変換する。指ごとに押しているコントロールを覚え、同じボタンは全員が離すまで押下のまま。キーボードと共有の `ButtonLatch`（押している・押し始め）で `triggered ⊆ pressed` を保つ。`mergeInputSources(...sources)` でキーボード・ゲームパッド・タッチを 1 つの `InputSource`（`pressed` / `triggered` は和集合）にまとめる。DOM の操作パッド（十字キー・A = 決定・B = キャンセル・☰ = メニュー）は `packages/input-browser/src/touch-pad.ts`（`mountTouchPad`。player とエディタのテストプレイが共有する）。ポインタイベントを `TouchInput` へ流すだけで、`setPointerCapture` により指が外へ出ても離すまで追う。`bootPlayer` の `touchPad: "auto" | "on" | "off"`（既定 `auto` = `pointer: coarse` の端末だけ。`?touch=on|off` で上書き）。矢印と ☰ は SVG（記号文字は iOS で絵文字化する）。ダブルタップ/ピンチの拡大は `touchstart`/`touchmove`/`gesturestart` の `preventDefault` で防ぐ。E2E は `e2e/touchpad.spec.ts`。テストプレイ（エディタ）にも、`pointer: coarse` の端末では同じパッドを出す（`browser-env.ts` が結線。ダイアログの中に載せ、スマホでは全画面表示）。
- **走る（`shift` ボタン）**：走る機能（`system.dash`。01・02）は、抽象ボタン `shift` で受ける（core はデバイスを知らない）。キーボードは Shift（左右とも）を押しながら方向キー。ゲームパッドは X ボタンか右トリガー（RT）。スマホは操作パッドの**走るボタン**（下）。走れないゲーム（`system.dash` が無い）では、`shift` を押しても何も起きない。
- **走るボタンの設計（スマホ）**：操作パッド（`mountTouchPad(root, input, { dash })`）は、**`dash: true`（`system.dash` のあるゲーム）のときだけ**、メニュー（☰）の左に走るボタン（≫）を 1 つ足す。**押している間だけ走る（長押し）**：キーボードの Shift と同じ押しっぱなしの `shift` ボタンで、`TouchInput` に専用の種類は無く、A・B と同じ `{ kind: "button", button: "shift" }`。大きさも A・B と同じ 64px（右の列は「走る・☰」の上の段と、「B・A」の下の段の 2 段になる）。ほかのボタンの位置・大きさは変わらず、`dash` が無ければ DOM も従来のまま（走る機能のないゲームの操作パッドは、これまでと同じ）。押している間は背景が明るくなる（`data-pressed` は `true`）。十字キーとは別の指で押すので、複数の指の同時押しに対応している。`bootPlayer` が `project.system.dash` を見て渡す。E2E は `e2e/dash.spec.ts`（走れるゲーム。A・B と同じ大きさ・走るボタンを押している間だけ速い）と `e2e/touchpad.spec.ts`（走れないゲームは従来の 4 つのコントロールだけ）。
- **契約テスト**：`inputSourceContract(name, make)` の `make` は `{ source, press(button), release(button) }`（デバイス入力を再現する操作口）を返す。`audioOutContract` は不変条件 2, 3 を検証する（不変条件 1 = BGM の多重再生防止は再生ノードが要るので webaudio のテストで）。

## 実装メモ（M4 で確定した点）
- **`audio-webaudio` を実装**：`createWebAudioOut(ctx, assets, { logger? }): WebAudioOut`（`AudioOut` + `resume()`）と `createDecodeAudio(ctx)`（`AssetSource` の `decodeAudio` に渡す。`decodeAudioData` はバッファを消費するので、キャッシュ側を壊さないようコピーを渡す）。
  - BGM は 1 曲だけ。**同じ音源の `playBgm` は再生し直さず**、音量とピッチだけを反映する（`loop` はソースの作成時のまま）。曲を変えると古い曲をフェードアウトして新しい曲をフェードインする。読み込み中に次の要求（別の曲・`stopBgm`）が来たら古い要求は捨てる（最新が勝つ）。
  - `AudioContext` が `running` でない間は、最後の BGM 要求だけを覚え、`resume()` か `statechange` で `running` になったら鳴らす。効果音は捨てる。どの状態でも例外は投げない（読み込み・再生の失敗は `logger.warn`）。`dispose` 後はすべて no-op。
  - マスター音量は 0〜1 に丸める（NaN は 0）。効果音は 1 発ごとに専用のソース（重なって鳴る）。
- **プレイヤー**（`apps/player/src/audio.ts`）：`AudioContext` を作れれば Web Audio、無ければ `audio-null`（その場合は音声アセットを事前読み込みしない）。最初のキー/ポインタ/タッチで `resume()` し、再開できたらリスナーを外す。
- **テスト**：モックの `AudioContext`（ノード・パラメータの呼び出しを記録）で、多重再生の防止、フェード、最新の要求が勝つこと、`suspended` 中の待機と再開、SE、音量、`dispose` を検証。契約テスト（`audioOutContract`）は `running` と `suspended` の両方で通す。ブラウザ上の実際の音は自動テストできない（E2E では `playBgm` / `stopBgm` の Effect が発行されることまで）。
