import type { Effect, RGBA } from "@rpg/core";
import type { Overlay } from "./frame-spec.js";
import { NO_TINT } from "./projection/theme.js";

/**
 * 画面効果の一時状態（シェイク・フラッシュ）。`GameState` には入れない見た目だけの状態で、
 * `Effect` を受けて始まり、`step` ごとに 1 ずつ進む。セーブ・リプレイの対象外。
 */
export interface VisualFx {
  readonly shake?: { readonly power: number; readonly total: number; readonly left: number };
  readonly flash?: { readonly color: RGBA; readonly total: number; readonly left: number };
}

export const NO_FX: VisualFx = {};

export function applyFxEffect(fx: VisualFx, effect: Effect): VisualFx {
  if (effect.kind === "screenShake") {
    return effect.durationTicks > 0 ? { ...fx, shake: { power: effect.power, total: effect.durationTicks, left: effect.durationTicks } } : fx;
  }
  if (effect.kind === "screenFlash") {
    return effect.durationTicks > 0 ? { ...fx, flash: { color: effect.color, total: effect.durationTicks, left: effect.durationTicks } } : fx;
  }
  return fx;
}

/** 1 フレーム分進める。終わった効果は取り除く。 */
export function tickFx(fx: VisualFx): VisualFx {
  const next: { shake?: NonNullable<VisualFx["shake"]>; flash?: NonNullable<VisualFx["flash"]> } = {};
  if (fx.shake && fx.shake.left > 1) next.shake = { ...fx.shake, left: fx.shake.left - 1 };
  if (fx.flash && fx.flash.left > 1) next.flash = { ...fx.flash, left: fx.flash.left - 1 };
  return next;
}

/** `VisualFx` から `FrameSpec.overlay` を作る。時間だけの関数なので決定論的。 */
export function fxOverlay(fx: VisualFx): Overlay {
  const shake = fx.shake
    ? { dx: Math.round(Math.sin(fx.shake.left * 2.1) * fx.shake.power * (fx.shake.left / fx.shake.total)), dy: 0 }
    : { dx: 0, dy: 0 };
  return {
    fade: 0,
    tint: NO_TINT,
    ...(fx.flash ? { flash: { color: fx.flash.color, alpha: fx.flash.left / fx.flash.total } } : {}),
    shake,
  };
}
