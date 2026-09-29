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
