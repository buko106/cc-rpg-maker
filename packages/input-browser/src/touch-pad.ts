import type { TouchControl, TouchInput } from "./touch.js";
import type { Button } from "@rpg/runtime";

/** 操作パッドを出すか。`auto` は主入力が指（`pointer: coarse`）のときだけ。 */
export type TouchPadMode = "auto" | "on" | "off";

export function shouldShowTouchPad(mode: TouchPadMode | undefined, coarsePointer: () => boolean): boolean {
  if (mode === "on") return true;
  if (mode === "off") return false;
  return coarsePointer();
}

/** `matchMedia("(pointer: coarse)")`。matchMedia が無い環境では false。 */
export const isCoarsePointer = (): boolean => typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

export interface TouchPadView {
  element: HTMLElement;
  dispose(): void;
}

export interface TouchPadOptions {
  /**
   * 走る機能のあるゲーム（`system.dash`）か。真のときだけ、メニューボタンの左に「走る」ボタン（A・B と同じ大きさ）を足す。省略 = 出さない（従来どおりの操作パッド）。
   * 走るボタンは押している間だけ走る（長押し）。キーボードの Shift（ゲームパッドは X / RT）と同じ `shift` ボタン。
   */
  dash?: boolean;
}

const DPAD_SIZE = 140;
const BASE = "position:relative;pointer-events:auto;touch-action:none;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;";
const FACE = "display:flex;align-items:center;justify-content:center;border-radius:50%;background:rgba(255,255,255,0.22);border:2px solid rgba(255,255,255,0.5);color:#fff;font:bold 20px sans-serif;";

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string>): SVGElementTagNameMap[K] {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

/** メニューボタンの ☰（三本線）。文字だと絵文字化しうるので SVG。 */
function menuIcon(): SVGElement {
  const icon = svg("svg", { viewBox: "0 0 24 24", width: "22", height: "22", "aria-hidden": "true" });
  for (const y of [6, 12, 18]) icon.append(svg("line", { x1: "4", y1: y.toString(), x2: "20", y2: y.toString(), stroke: "currentColor", "stroke-width": "2.4", "stroke-linecap": "round" }));
  icon.style.pointerEvents = "none";
  return icon;
}

/** 走るボタンの ≫（二重の山形）。 */
function dashIcon(): SVGElement {
  const icon = svg("svg", { viewBox: "0 0 24 24", width: "30", height: "30", "aria-hidden": "true" });
  for (const x of [4, 11]) {
    icon.append(svg("polyline", { points: `${x},6 ${x + 8},12 ${x},18`, fill: "none", stroke: "currentColor", "stroke-width": "2.6", "stroke-linecap": "round", "stroke-linejoin": "round" }));
  }
  icon.style.pointerEvents = "none";
  return icon;
}

/** 走るボタンの背景（離しているとき / 押しているとき）。押している間は走っているのが分かるよう明るくする。 */
const DASH_UP = "rgba(255,255,255,0.22)";
const DASH_DOWN = "rgba(255,255,255,0.65)";

const BUTTONS: readonly { button: Button; label: string; aria: string; size: number }[] = [
  { button: "cancel", label: "B", aria: "キャンセル", size: 64 },
  { button: "ok", label: "A", aria: "決定", size: 64 },
];

/**
 * 画面下に操作パッド（十字キー・決定・キャンセル・メニュー。走れるゲームでは走るボタンも）を出す。指の位置をそのまま `TouchInput` に渡すだけで、判定はそちらが持つ。
 * 見た目は素朴な DOM。ボタンの押下状態は `data-pressed` に出す（テストと見た目用）。
 */
export function mountTouchPad(root: HTMLElement, input: TouchInput, options: TouchPadOptions = {}): TouchPadView {
  const pad = document.createElement("div");
  pad.dataset["touchPad"] = "";
  pad.style.cssText = "position:fixed;left:0;right:0;bottom:0;display:flex;justify-content:space-between;align-items:flex-end;padding:12px 16px calc(12px + env(safe-area-inset-bottom));pointer-events:none;z-index:10;";
  pad.addEventListener("contextmenu", (e) => e.preventDefault());
  // iOS Safari は touch-action だけではダブルタップ/ピンチの拡大を止めきれない。タッチ開始と gesture を握りつぶす。
  const stop = (e: Event): void => e.preventDefault();
  pad.addEventListener("touchstart", stop, { passive: false });
  pad.addEventListener("touchmove", stop, { passive: false });
  document.addEventListener("gesturestart", stop);

  const centerOf = (el: HTMLElement): { x: number; y: number } => {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  };
  const offsetOf = (el: HTMLElement, e: PointerEvent): { x: number; y: number } => {
    const c = centerOf(el);
    return { x: e.clientX - c.x, y: e.clientY - c.y };
  };

  /** 要素へのポインタ操作を `TouchInput` に流す。キャプチャするので、指が要素の外へ出ても離すまで追える。 */
  const attach = (el: HTMLElement, control: TouchControl): void => {
    el.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      input.pointerDown(e.pointerId, control, offsetOf(el, e));
      refresh();
    });
    el.addEventListener("pointermove", (e) => {
      input.pointerMove(e.pointerId, offsetOf(el, e));
      refresh();
    });
    const release = (e: PointerEvent): void => {
      input.pointerUp(e.pointerId);
      refresh();
    };
    el.addEventListener("pointerup", release);
    el.addEventListener("pointercancel", release);
    el.addEventListener("lostpointercapture", release);
  };

  const dpad = document.createElement("div");
  dpad.dataset["control"] = "dpad";
  dpad.setAttribute("role", "group");
  dpad.setAttribute("aria-label", "十字キー");
  dpad.style.cssText = `${BASE}${FACE}width:${DPAD_SIZE}px;height:${DPAD_SIZE}px;`;
  const arrows: readonly { button: Button; points: string; css: string }[] = [
    { button: "up", points: "12,5 20,19 4,19", css: "top:4px;left:50%;margin-left:-12px" },
    { button: "down", points: "12,19 20,5 4,5", css: "bottom:4px;left:50%;margin-left:-12px" },
    { button: "left", points: "5,12 19,4 19,20", css: "left:4px;top:50%;margin-top:-12px" },
    { button: "right", points: "19,12 5,4 5,20", css: "right:4px;top:50%;margin-top:-12px" },
  ];
  const arrowEls = new Map<Button, HTMLElement | SVGElement>();
  for (const a of arrows) {
    // 記号文字（▲◀▶）は iOS で絵文字に化けるので SVG で描く。
    const m = svg("svg", { viewBox: "0 0 24 24", width: "24", height: "24", "aria-hidden": "true" });
    m.append(svg("polygon", { points: a.points, fill: "currentColor" }));
    m.dataset["button"] = a.button;
    m.style.cssText = `position:absolute;${a.css};opacity:0.7;pointer-events:none;`;
    dpad.append(m);
    arrowEls.set(a.button, m);
  }
  attach(dpad, { kind: "dpad", radius: DPAD_SIZE / 2 });

  const right = document.createElement("div");
  right.style.cssText = "display:flex;flex-direction:column;align-items:flex-end;gap:12px;";
  const menu = document.createElement("div");
  const faces = document.createElement("div");
  faces.style.cssText = "display:flex;gap:16px;align-items:flex-end;";
  const buttonEls = new Map<Button, HTMLElement>();
  const makeButton = (button: Button, label: string | SVGElement, aria: string, size: number): HTMLElement => {
    const el = document.createElement("div");
    el.dataset["control"] = button;
    el.setAttribute("role", "button");
    el.setAttribute("aria-label", aria);
    if (typeof label === "string") el.textContent = label;
    else el.append(label);
    el.style.cssText = `${BASE}${FACE}width:${size}px;height:${size}px;`;
    attach(el, { kind: "button", button });
    buttonEls.set(button, el);
    return el;
  };
  for (const b of BUTTONS) faces.append(makeButton(b.button, b.label, b.aria, b.size));
  menu.append(makeButton("menu", menuIcon(), "メニュー", 44));
  let dashEl: HTMLElement | undefined;
  if (options.dash === true) {
    // メニューの左に、A・B と同じ大きさの走るボタン（ほかのボタンの位置は変わらない）
    menu.style.cssText = "display:flex;gap:12px;align-items:flex-end;";
    dashEl = makeButton("shift", dashIcon(), "走る（押している間だけ）", 64);
    dashEl.style.background = DASH_UP;
    menu.prepend(dashEl);
  }
  right.append(menu, faces);
  pad.append(dpad, right);

  /** 押下状態を見た目（`data-pressed`）に反映する。 */
  function refresh(): void {
    const held = input.held();
    for (const [button, el] of buttonEls) el.dataset["pressed"] = String(held.has(button));
    if (dashEl !== undefined) dashEl.style.background = held.has("shift") ? DASH_DOWN : DASH_UP;
    for (const [button, el] of arrowEls) el.style.opacity = held.has(button) ? "1" : "0.7";
    dpad.dataset["pressed"] = String(["up", "down", "left", "right"].some((b) => held.has(b as Button)));
  }
  refresh();

  root.append(pad);
  return {
    element: pad,
    dispose() {
      input.releaseAll();
      document.removeEventListener("gesturestart", stop);
      pad.remove();
    },
  };
}
