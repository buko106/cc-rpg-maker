export type Button = "up" | "down" | "left" | "right" | "ok" | "cancel" | "menu" | "shift" | "pageup" | "pagedown";

/** 1フレーム分の入力。入力デバイスの違いは `input-*` アダプタが吸収する。 */
export interface InputFrame {
  /** このフレームで押されている */
  readonly pressed: ReadonlySet<Button>;
  /** このフレームで押下開始 */
  readonly triggered: ReadonlySet<Button>;
  readonly pointer?: { readonly x: number; readonly y: number; readonly down: boolean };
}

/** 何も押されていない入力。 */
export function emptyInput(): InputFrame {
  return { pressed: new Set(), triggered: new Set() };
}

/** テスト・リプレイ用の入力フレーム作成ヘルパ。`triggered` は `pressed` の部分集合でなければならない。 */
export function inputFrame(pressed: Iterable<Button> = [], triggered: Iterable<Button> = []): InputFrame {
  const p = new Set(pressed);
  const t = new Set(triggered);
  for (const b of t) p.add(b);
  return { pressed: p, triggered: t };
}
