import { describe, expect, it } from "vitest";
import { inputSourceContract } from "@rpg/test-utils";
import type { Button, InputSource } from "@rpg/runtime";
import { createBrowserInput, createTouchInput, mergeInputSources } from "./index.js";

const key = (type: "keydown" | "keyup", code: string): Event => Object.assign(new Event(type, { cancelable: true }), { code });

inputSourceContract("browser-merged", () => {
  const target = new EventTarget();
  const touch = createTouchInput();
  const source = mergeInputSources(createBrowserInput(target), touch);
  return { source, press: (b) => touch.pointerDown(1, { kind: "button", button: b as Button }, { x: 0, y: 0 }), release: () => touch.pointerUp(1) };
});

describe("mergeInputSources", () => {
  it("キーボードとタッチの押下を合わせる", () => {
    const target = new EventTarget();
    const touch = createTouchInput();
    const merged = mergeInputSources(createBrowserInput(target), touch);
    target.dispatchEvent(key("keydown", "ArrowLeft"));
    touch.pointerDown(1, { kind: "button", button: "ok" }, { x: 0, y: 0 });
    const a = merged.poll();
    expect(a.pressed).toEqual(new Set(["left", "ok"]));
    expect(a.triggered).toEqual(new Set(["left", "ok"]));
    const b = merged.poll();
    expect(b.pressed).toEqual(new Set(["left", "ok"]));
    expect(b.triggered.size).toBe(0);
  });

  it("入力源が無ければ空。dispose は全部に一度だけ伝わる", () => {
    expect(mergeInputSources().poll()).toEqual({ pressed: new Set(), triggered: new Set() });
    let disposed = 0;
    const counting: InputSource = { poll: () => ({ pressed: new Set(), triggered: new Set() }), dispose: () => void disposed++ };
    const merged = mergeInputSources(counting, counting);
    merged.dispose();
    merged.dispose();
    expect(disposed).toBe(2);
  });
});
