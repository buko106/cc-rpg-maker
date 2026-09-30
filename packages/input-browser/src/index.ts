/**
 * @rpg/input-browser — ブラウザ InputSource アダプタ。キーボードとゲームパッドを抽象ボタンに変換する。
 *
 * 設計: docs/08-audio-input.md
 * タッチ（仮想十字キー・ボタン）は `createTouchInput`（判定ロジックだけ。見た目の DOM は利用側のアプリが作る）。
 * 未実装（後続）：ポインタ座標（`InputFrame.pointer`）。
 */
import { emptyInput } from "@rpg/runtime";
import type { Button, InputFrame, InputSource } from "@rpg/runtime";
import { createButtonLatch } from "./button-latch.js";

export { createTouchInput, dpadButtons } from "./touch.js";
export type { Point, TouchControl, TouchInput } from "./touch.js";
export { mergeInputSources } from "./merge.js";

/** `KeyboardEvent.code` → ボタン */
export interface KeyMap {
  [code: string]: Button;
}

export const defaultKeyMap: KeyMap = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  KeyW: "up",
  KeyS: "down",
  KeyA: "left",
  KeyD: "right",
  KeyZ: "ok",
  Enter: "ok",
  Space: "ok",
  KeyX: "cancel",
  Escape: "cancel",
  KeyM: "menu",
  ShiftLeft: "shift",
  ShiftRight: "shift",
  PageUp: "pageup",
  PageDown: "pagedown",
};

/** 標準配置のゲームパッドのボタン番号 → ボタン */
const GAMEPAD_BUTTONS: Readonly<Record<number, Button>> = {
  0: "ok",
  1: "cancel",
  3: "menu",
  4: "pageup",
  5: "pagedown",
  12: "up",
  13: "down",
  14: "left",
  15: "right",
};
const STICK_THRESHOLD = 0.5;

/** `navigator.getGamepads()` 相当。テストで差し替えられるようにしてある。 */
export type GamepadReader = () => readonly (Gamepad | null)[];

export interface BrowserInputOptions {
  keyMap?: KeyMap;
  /** ゲームパッドも読む（既定 false）。 */
  gamepad?: boolean;
  /** 既定は `navigator.getGamepads()`。 */
  readGamepads?: GamepadReader;
}

function gamepadButtons(pads: readonly (Gamepad | null)[]): Set<Button> {
  const pressed = new Set<Button>();
  for (const pad of pads) {
    if (pad === null) continue;
    pad.buttons.forEach((b, i) => {
      const button = GAMEPAD_BUTTONS[i];
      if (b.pressed && button !== undefined) pressed.add(button);
    });
    const [ax = 0, ay = 0] = pad.axes;
    if (ax < -STICK_THRESHOLD) pressed.add("left");
    if (ax > STICK_THRESHOLD) pressed.add("right");
    if (ay < -STICK_THRESHOLD) pressed.add("up");
    if (ay > STICK_THRESHOLD) pressed.add("down");
  }
  return pressed;
}

/**
 * `target`（通常は `window`）の `keydown` / `keyup` を購読する。
 * `poll()` は「今押されているボタン」と「前回の `poll` 以降に押され始めたボタン」を返す。
 * 押してすぐ離した場合も、そのフレームだけは `pressed` に含める（不変条件 `triggered ⊆ pressed`）。
 */
export function createBrowserInput(target: EventTarget, options: BrowserInputOptions = {}): InputSource {
  const keyMap = options.keyMap ?? defaultKeyMap;
  const readGamepads: GamepadReader | undefined = options.gamepad
    ? (options.readGamepads ?? (() => (typeof navigator === "undefined" ? [] : navigator.getGamepads())))
    : undefined;

  const latch = createButtonLatch();
  let padPressed = new Set<Button>();
  let disposed = false;

  const buttonOf = (e: Event): Button | undefined => {
    const code = (e as { code?: unknown }).code;
    return typeof code === "string" && Object.hasOwn(keyMap, code) ? keyMap[code] : undefined;
  };

  const onKeyDown = (e: Event): void => {
    const button = buttonOf(e);
    if (button === undefined) return;
    e.preventDefault();
    latch.down(button);
  };
  const onKeyUp = (e: Event): void => {
    const button = buttonOf(e);
    if (button === undefined) return;
    e.preventDefault();
    latch.up(button);
  };
  // フォーカスを失うと keyup が届かないので、押しっぱなしを防ぐ
  const onBlur = (): void => {
    latch.releaseAll();
  };

  target.addEventListener("keydown", onKeyDown);
  target.addEventListener("keyup", onKeyUp);
  target.addEventListener("blur", onBlur);

  return {
    poll(): InputFrame {
      if (disposed) return emptyInput();
      const pad = readGamepads ? gamepadButtons(readGamepads()) : new Set<Button>();
      const keys = latch.take();
      const triggered = keys.triggered;
      for (const b of pad) if (!padPressed.has(b)) triggered.add(b);
      padPressed = pad;
      return { pressed: new Set([...keys.pressed, ...pad, ...triggered]), triggered };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      target.removeEventListener("keydown", onKeyDown);
      target.removeEventListener("keyup", onKeyUp);
      target.removeEventListener("blur", onBlur);
      latch.reset();
    },
  };
}
