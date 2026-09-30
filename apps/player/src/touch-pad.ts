import type { TouchControl, TouchInput } from "@rpg/input-browser";
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

const DPAD_SIZE = 140;
const BASE = "position:relative;pointer-events:auto;touch-action:none;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;";
const FACE = "display:flex;align-items:center;justify-content:center;border-radius:50%;background:rgba(255,255,255,0.22);border:2px solid rgba(255,255,255,0.5);color:#fff;font:bold 20px sans-serif;";

const BUTTONS: readonly { button: Button; label: string; aria: string; size: number }[] = [
  { button: "cancel", label: "B", aria: "キャンセル", size: 64 },
  { button: "ok", label: "A", aria: "決定", size: 64 },
];

/**
 * 画面下に操作パッド（十字キー・決定・キャンセル・メニュー）を出す。指の位置をそのまま `TouchInput` に渡すだけで、判定はそちらが持つ。
 * 見た目は素朴な DOM。ボタンの押下状態は `data-pressed` に出す（テストと見た目用）。
 */
export function mountTouchPad(root: HTMLElement, input: TouchInput): TouchPadView {
  const pad = document.createElement("div");
  pad.dataset["touchPad"] = "";
  pad.style.cssText = "position:fixed;left:0;right:0;bottom:0;display:flex;justify-content:space-between;align-items:flex-end;padding:12px 16px calc(12px + env(safe-area-inset-bottom));pointer-events:none;z-index:10;";
  pad.addEventListener("contextmenu", (e) => e.preventDefault());

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
  const arrows: readonly { button: Button; mark: string; css: string }[] = [
    { button: "up", mark: "▲", css: "top:6px;left:50%;transform:translateX(-50%)" },
    { button: "down", mark: "▼", css: "bottom:6px;left:50%;transform:translateX(-50%)" },
    { button: "left", mark: "◀", css: "left:8px;top:50%;transform:translateY(-50%)" },
    { button: "right", mark: "▶", css: "right:8px;top:50%;transform:translateY(-50%)" },
  ];
  const arrowEls = new Map<Button, HTMLElement>();
  for (const a of arrows) {
    const m = document.createElement("span");
    m.textContent = a.mark;
    m.dataset["button"] = a.button;
    m.style.cssText = `position:absolute;${a.css};font-size:18px;opacity:0.7;pointer-events:none;`;
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
  const makeButton = (button: Button, label: string, aria: string, size: number): HTMLElement => {
    const el = document.createElement("div");
    el.dataset["control"] = button;
    el.setAttribute("role", "button");
    el.setAttribute("aria-label", aria);
    el.textContent = label;
    el.style.cssText = `${BASE}${FACE}width:${size}px;height:${size}px;`;
    attach(el, { kind: "button", button });
    buttonEls.set(button, el);
    return el;
  };
  for (const b of BUTTONS) faces.append(makeButton(b.button, b.label, b.aria, b.size));
  menu.append(makeButton("menu", "☰", "メニュー", 44));
  right.append(menu, faces);
  pad.append(dpad, right);

  /** 押下状態を見た目（`data-pressed`）に反映する。 */
  function refresh(): void {
    const held = input.held();
    for (const [button, el] of buttonEls) el.dataset["pressed"] = String(held.has(button));
    for (const [button, el] of arrowEls) el.style.opacity = held.has(button) ? "1" : "0.7";
    dpad.dataset["pressed"] = String(["up", "down", "left", "right"].some((b) => held.has(b as Button)));
  }
  refresh();

  root.append(pad);
  return {
    element: pad,
    dispose() {
      input.releaseAll();
      pad.remove();
    },
  };
}
