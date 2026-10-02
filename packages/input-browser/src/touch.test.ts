import { describe, expect, it } from "vitest";
import { inputSourceContract } from "@rpg/test-utils";
import type { Button } from "@rpg/runtime";
import { createTouchInput, dpadButtons } from "./index.js";
import type { TouchControl } from "./index.js";

const R = 60;
const dpad: TouchControl = { kind: "dpad", radius: R };
const btn = (button: Button): TouchControl => ({ kind: "button", button });
const toggle = (button: Button): TouchControl => ({ kind: "toggle", button });
const set = (...b: Button[]): Set<Button> => new Set(b);

inputSourceContract("browser-touch", () => {
  const input = createTouchInput();
  return { source: input, press: (b) => input.pointerDown(1, btn(b as Button), { x: 0, y: 0 }), release: () => input.pointerUp(1) };
});

describe("dpadButtons", () => {
  it("上下左右の 4 方向", () => {
    expect(dpadButtons({ x: 0, y: -40 }, R)).toEqual(set("up"));
    expect(dpadButtons({ x: 0, y: 40 }, R)).toEqual(set("down"));
    expect(dpadButtons({ x: -40, y: 0 }, R)).toEqual(set("left"));
    expect(dpadButtons({ x: 40, y: 0 }, R)).toEqual(set("right"));
  });

  it("斜めは 2 方向。境目（22.5°）の手前は 1 方向", () => {
    expect(dpadButtons({ x: 30, y: -30 }, R)).toEqual(set("right", "up"));
    expect(dpadButtons({ x: -30, y: 30 }, R)).toEqual(set("left", "down"));
    expect(dpadButtons({ x: 40, y: 10 }, R)).toEqual(set("right")); // 約 14°
    expect(dpadButtons({ x: 40, y: 20 }, R)).toEqual(set("right", "down")); // 約 27°
  });

  it("中心付近（デッドゾーン）は無入力。半径の外へずらしても方向は保つ", () => {
    expect(dpadButtons({ x: 0, y: 0 }, R).size).toBe(0);
    expect(dpadButtons({ x: 10, y: 10 }, R).size).toBe(0);
    expect(dpadButtons({ x: 300, y: 0 }, R)).toEqual(set("right"));
    expect(dpadButtons({ x: 10, y: 0 }, R, 0.1)).toEqual(set("right"));
  });
});

describe("createTouchInput", () => {
  it("ボタンを押している間は pressed、押し始めの poll だけ triggered", () => {
    const t = createTouchInput();
    t.pointerDown(1, btn("ok"), { x: 0, y: 0 });
    expect(t.held()).toEqual(set("ok"));
    const a = t.poll();
    expect([...a.pressed, ...a.triggered]).toEqual(["ok", "ok"]);
    const b = t.poll();
    expect([...b.pressed]).toEqual(["ok"]);
    expect(b.triggered.size).toBe(0);
    t.pointerUp(1);
    expect(t.poll().pressed.size).toBe(0);
    expect(t.held().size).toBe(0);
  });

  it("poll の間に押して離しても、そのフレームは pressed かつ triggered", () => {
    const t = createTouchInput();
    t.pointerDown(1, btn("cancel"), { x: 0, y: 0 });
    t.pointerUp(1);
    const f = t.poll();
    expect(f.pressed).toEqual(set("cancel"));
    expect(f.triggered).toEqual(set("cancel"));
    expect(t.poll().pressed.size).toBe(0);
  });

  it("十字キーは指を動かすと方向が変わり、変わった方向だけが新しい押下になる", () => {
    const t = createTouchInput();
    t.pointerDown(1, dpad, { x: 40, y: 0 });
    expect(t.poll().triggered).toEqual(set("right"));
    t.pointerMove(1, { x: 30, y: -30 });
    const f = t.poll();
    expect(f.pressed).toEqual(set("right", "up"));
    expect(f.triggered).toEqual(set("up"));
    t.pointerMove(1, { x: 0, y: 40 });
    expect(t.poll().pressed).toEqual(set("down"));
    t.pointerMove(1, { x: 0, y: 0 });
    expect(t.poll().pressed.size).toBe(0);
    t.pointerUp(1);
  });

  it("複数の指：十字キーと決定を同時に押せる。同じボタンは全員が離すまで押下のまま", () => {
    const t = createTouchInput();
    t.pointerDown(1, dpad, { x: 0, y: -40 });
    t.pointerDown(2, btn("ok"), { x: 0, y: 0 });
    t.pointerDown(3, btn("ok"), { x: 0, y: 0 });
    expect(t.poll().pressed).toEqual(set("up", "ok"));
    t.pointerUp(2);
    expect(t.poll().pressed).toEqual(set("up", "ok"));
    t.pointerUp(3);
    expect(t.poll().pressed).toEqual(set("up"));
  });

  it("触れていない指の move / up は無視する", () => {
    const t = createTouchInput();
    t.pointerMove(9, { x: 40, y: 0 });
    t.pointerUp(9);
    expect(t.poll().pressed.size).toBe(0);
  });

  it("releaseAll で全部離す", () => {
    const t = createTouchInput();
    t.pointerDown(1, btn("ok"), { x: 0, y: 0 });
    t.pointerDown(2, dpad, { x: 40, y: 0 });
    t.poll();
    t.releaseAll();
    expect(t.poll().pressed.size).toBe(0);
    expect(t.held().size).toBe(0);
  });

  it("トグル：タップするたびにオン/オフが入れ替わり、指を離しても続く", () => {
    const t = createTouchInput();
    t.pointerDown(1, toggle("shift"), { x: 0, y: 0 });
    expect(t.held()).toEqual(set("shift"));
    const on = t.poll();
    expect(on.pressed).toEqual(set("shift"));
    expect(on.triggered).toEqual(set("shift"));
    t.pointerUp(1); // 指を離しても押下のまま
    const kept = t.poll();
    expect(kept.pressed).toEqual(set("shift"));
    expect(kept.triggered.size).toBe(0);
    expect(t.held()).toEqual(set("shift"));

    t.pointerDown(2, toggle("shift"), { x: 0, y: 0 }); // もう一度タップするとオフ
    t.pointerUp(2);
    expect(t.held().size).toBe(0);
    expect(t.poll().pressed.size).toBe(0);
  });

  it("トグルは十字キー・ほかのボタンと同時に使える。同じボタンの通常ボタンとも合わさる", () => {
    const t = createTouchInput();
    t.pointerDown(1, toggle("shift"), { x: 0, y: 0 });
    t.pointerUp(1);
    t.pointerDown(2, dpad, { x: 40, y: 0 });
    t.pointerDown(3, btn("ok"), { x: 0, y: 0 });
    expect(t.poll().pressed).toEqual(set("shift", "right", "ok"));
    t.pointerUp(2);
    t.pointerUp(3);
    expect(t.poll().pressed).toEqual(set("shift"));
    t.pointerDown(4, btn("shift"), { x: 0, y: 0 }); // オンのまま、通常ボタンを離しても残る
    t.pointerUp(4);
    expect(t.held()).toEqual(set("shift"));
  });

  it("releaseAll・dispose でトグルもオフに戻る", () => {
    const t = createTouchInput();
    t.pointerDown(1, toggle("shift"), { x: 0, y: 0 });
    t.pointerUp(1);
    t.poll();
    t.releaseAll();
    expect(t.held().size).toBe(0);
    expect(t.poll().pressed.size).toBe(0);
    t.pointerDown(2, toggle("shift"), { x: 0, y: 0 });
    t.dispose();
    expect(t.held().size).toBe(0);
    expect(t.poll()).toEqual({ pressed: new Set(), triggered: new Set() });
  });

  it("dispose 後は何も受け付けず、空のフレームを返す", () => {
    const t = createTouchInput();
    t.pointerDown(1, btn("ok"), { x: 0, y: 0 });
    t.dispose();
    t.pointerDown(2, btn("cancel"), { x: 0, y: 0 });
    t.pointerMove(2, { x: 0, y: 0 });
    expect(t.poll()).toEqual({ pressed: new Set(), triggered: new Set() });
    expect(t.held().size).toBe(0);
    t.dispose();
  });
});
