import { emptyInput } from "@rpg/runtime";
import type { Button, InputSource } from "@rpg/runtime";
import { createButtonLatch } from "./button-latch.js";

/** コントロールの中心を原点とした座標（y は下向き）。 */
export interface Point {
  x: number;
  y: number;
}

/** 画面上のタッチコントロール。ボタンは押している間だけ、十字キーは指の位置で方向が決まる。 */
export type TouchControl = { kind: "button"; button: Button } | { kind: "dpad"; radius: number; deadZone?: number };

const DEFAULT_DEAD_ZONE = 0.3;
/** 22.5°（45° ごとの 8 方向の境目）の sin。斜めは、両方の成分がこの割合を超えたとき。 */
const DIAGONAL_SIN = Math.sin(Math.PI / 8);

/**
 * 十字キーの中心からの位置 → 押されている方向ボタン（8 方向。斜めは 2 つ）。
 * 中心付近（`radius * deadZone` 未満）は無入力。円の外まで指をずらしても、方向は保つ。
 */
export function dpadButtons(offset: Point, radius: number, deadZone: number = DEFAULT_DEAD_ZONE): Set<Button> {
  const dist = Math.hypot(offset.x, offset.y);
  const buttons = new Set<Button>();
  if (dist === 0 || dist < radius * deadZone) return buttons;
  const threshold = DIAGONAL_SIN * dist;
  if (offset.x > threshold) buttons.add("right");
  if (offset.x < -threshold) buttons.add("left");
  if (offset.y > threshold) buttons.add("down");
  if (offset.y < -threshold) buttons.add("up");
  return buttons;
}

/**
 * タッチ入力。ビュー（DOM）はポインタのイベントをここへ流すだけで、判定はすべてここで行う。
 * ポインタ（指）ごとに、押しているコントロールを覚える。複数の指が同じボタンを押していても、全員が離すまで押下のまま。
 */
export interface TouchInput extends InputSource {
  /** 指がコントロールに触れた。`at` はコントロールの中心からの位置（ボタンでは使わない）。 */
  pointerDown(id: number, control: TouchControl, at: Point): void;
  /** 触れている指が動いた。触れていない `id` は無視する。 */
  pointerMove(id: number, at: Point): void;
  /** 指が離れた（キャンセルも同じ）。 */
  pointerUp(id: number): void;
  /** 全部の指を離す（画面が隠れたときなど）。 */
  releaseAll(): void;
  /** 今押されているボタン（ビューの見た目用。`poll` と違い状態を消費しない）。 */
  held(): ReadonlySet<Button>;
}

export function createTouchInput(): TouchInput {
  const latch = createButtonLatch();
  const pointers = new Map<number, { control: TouchControl; buttons: Set<Button> }>();
  let current = new Set<Button>();
  let disposed = false;

  const buttonsOf = (control: TouchControl, at: Point): Set<Button> => (control.kind === "button" ? new Set([control.button]) : dpadButtons(at, control.radius, control.deadZone));

  /** 全ポインタの押下を合わせて、ラッチに差分を反映する。 */
  const sync = (): void => {
    const next = new Set<Button>();
    for (const p of pointers.values()) for (const b of p.buttons) next.add(b);
    for (const b of current) if (!next.has(b)) latch.up(b);
    for (const b of next) if (!current.has(b)) latch.down(b);
    current = next;
  };

  return {
    pointerDown(id, control, at) {
      if (disposed) return;
      pointers.set(id, { control, buttons: buttonsOf(control, at) });
      sync();
    },
    pointerMove(id, at) {
      const p = pointers.get(id);
      if (disposed || p === undefined) return;
      p.buttons = buttonsOf(p.control, at);
      sync();
    },
    pointerUp(id) {
      if (!pointers.delete(id)) return;
      sync();
    },
    releaseAll() {
      pointers.clear();
      sync();
    },
    held: () => current,
    poll() {
      return disposed ? emptyInput() : latch.take();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      pointers.clear();
      current = new Set();
      latch.reset();
    },
  };
}
