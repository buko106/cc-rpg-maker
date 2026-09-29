import { describe, expect, it } from "vitest";
import { inputSourceContract } from "@rpg/test-utils";
import { createBrowserInput, defaultKeyMap } from "./index.js";

const key = (type: "keydown" | "keyup", code: string): Event & { prevented: boolean } => {
  const e = Object.assign(new Event(type, { cancelable: true }), { code, prevented: false });
  return e;
};

/** `KeyboardEvent` の代わりに `code` を持つ Event を使う（Node に KeyboardEvent は無い）。 */
function driver(options?: Parameters<typeof createBrowserInput>[1]) {
  const target = new EventTarget();
  const source = createBrowserInput(target, options);
  const codeOf = (b: string): string => Object.entries(defaultKeyMap).find(([, v]) => v === b)![0];
  return {
    target,
    source,
    down: (code: string) => target.dispatchEvent(key("keydown", code)),
    up: (code: string) => target.dispatchEvent(key("keyup", code)),
    press: (b: string) => target.dispatchEvent(key("keydown", codeOf(b))),
    release: (b: string) => target.dispatchEvent(key("keyup", codeOf(b))),
  };
}

inputSourceContract("browser", () => {
  const d = driver();
  return { source: d.source, press: (b) => d.press(b), release: (b) => d.release(b) };
});

describe("createBrowserInput（キーボード）", () => {
  it("押している間は pressed、押した最初の poll だけ triggered", () => {
    const d = driver();
    d.down("ArrowRight");
    const a = d.source.poll();
    expect([...a.pressed]).toEqual(["right"]);
    expect([...a.triggered]).toEqual(["right"]);
    const b = d.source.poll();
    expect([...b.pressed]).toEqual(["right"]);
    expect(b.triggered.size).toBe(0);
    d.up("ArrowRight");
    expect(d.source.poll().pressed.size).toBe(0);
  });

  it("キーリピート（keydown の連続）は新しい押下として数えない", () => {
    const d = driver();
    d.down("KeyZ");
    d.source.poll();
    d.down("KeyZ");
    d.down("KeyZ");
    expect(d.source.poll().triggered.size).toBe(0);
  });

  it("poll の間に押して離しても、そのフレームでは pressed かつ triggered", () => {
    const d = driver();
    d.down("KeyZ");
    d.up("KeyZ");
    const f = d.source.poll();
    expect([...f.pressed]).toEqual(["ok"]);
    expect([...f.triggered]).toEqual(["ok"]);
    expect(d.source.poll().pressed.size).toBe(0);
  });

  it("複数のキーが同じボタンに割り当たっていてもよい（同時押し）", () => {
    const d = driver();
    d.down("ArrowUp");
    d.down("KeyW");
    d.down("KeyX");
    expect(new Set(d.source.poll().pressed)).toEqual(new Set(["up", "cancel"]));
  });

  it("キーマップを差し替えられる。割り当て外のキーは無視し、preventDefault もしない", () => {
    const d = driver({ keyMap: { KeyJ: "ok" } });
    const ignored = key("keydown", "ArrowUp");
    d.target.dispatchEvent(ignored);
    expect(ignored.defaultPrevented).toBe(false);
    const mapped = key("keydown", "KeyJ");
    d.target.dispatchEvent(mapped);
    expect(mapped.defaultPrevented).toBe(true);
    const f = d.source.poll();
    expect([...f.pressed]).toEqual(["ok"]);
  });

  it("キーマップに無い名前（constructor など）は無視する", () => {
    const d = driver();
    d.down("constructor");
    d.down("__proto__");
    expect(d.source.poll().pressed.size).toBe(0);
  });

  it("フォーカスを失う（blur）と押しっぱなしが解除される", () => {
    const d = driver();
    d.down("ArrowLeft");
    d.source.poll();
    d.target.dispatchEvent(new Event("blur"));
    expect(d.source.poll().pressed.size).toBe(0);
  });

  it("dispose 後はイベントを購読せず、空のフレームを返す", () => {
    const d = driver();
    d.source.dispose();
    d.down("ArrowUp");
    expect(d.source.poll()).toEqual({ pressed: new Set(), triggered: new Set() });
    d.source.dispose();
  });
});

describe("createBrowserInput（ゲームパッド）", () => {
  const pad = (pressedButtons: number[], axes: number[] = [0, 0]) =>
    [{ buttons: Array.from({ length: 16 }, (_, i) => ({ pressed: pressedButtons.includes(i) })), axes }] as unknown as Gamepad[];

  it("ボタン・十字キー・スティックを読み、押し始めだけ triggered にする", () => {
    let current = pad([]);
    const source = createBrowserInput(new EventTarget(), { gamepad: true, readGamepads: () => current });
    expect(source.poll().pressed.size).toBe(0);

    current = pad([0, 12], [0.9, 0]);
    const a = source.poll();
    expect(new Set(a.pressed)).toEqual(new Set(["ok", "up", "right"]));
    expect(new Set(a.triggered)).toEqual(new Set(["ok", "up", "right"]));
    const b = source.poll();
    expect(b.pressed.size).toBe(3);
    expect(b.triggered.size).toBe(0);

    current = pad([], [-0.9, 0.9]);
    expect(new Set(source.poll().pressed)).toEqual(new Set(["left", "down"]));
  });

  it("gamepad を有効にしなければ読まない。接続されていない（null）パッドは無視する", () => {
    let reads = 0;
    const off = createBrowserInput(new EventTarget(), { readGamepads: () => (reads++, pad([0])) });
    expect(off.poll().pressed.size).toBe(0);
    expect(reads).toBe(0);
    const on = createBrowserInput(new EventTarget(), { gamepad: true, readGamepads: () => [null] });
    expect(on.poll().pressed.size).toBe(0);
  });
});
