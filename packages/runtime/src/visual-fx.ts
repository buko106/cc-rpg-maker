import type { Effect, RGBA } from "@rpg/core";
import type { AssetId } from "@rpg/schema";
import type { Overlay } from "./frame-spec.js";
import { NO_TINT } from "./projection/theme.js";

/**
 * 画面効果の一時状態（シェイク・フラッシュ）。`GameState` には入れない見た目だけの状態で、
 * `Effect` を受けて始まり、`step` ごとに 1 ずつ進む。セーブ・リプレイの対象外。
 */
export interface PictureView {
  readonly x: number;
  readonly y: number;
  readonly opacity: number;
  readonly scale: number;
}

/** ピクチャ（一枚絵）：`from` から `to` へ `total` フレームかけて変わり、終わってもそのまま保たれる（消去まで）。 */
export interface PictureFx {
  readonly asset: AssetId;
  readonly origin: "topLeft" | "center";
  readonly from: PictureView;
  readonly to: PictureView;
  readonly total: number;
  readonly left: number;
}

export interface VisualFx {
  /** 番号 → ピクチャ。 */
  readonly pictures?: Readonly<Record<number, PictureFx>>;
  readonly shake?: { readonly power: number; readonly total: number; readonly left: number };
  readonly flash?: { readonly color: RGBA; readonly total: number; readonly left: number };
  /** 色調：`from` から `color` へ `total` フレームかけて変わり、`left` が 0 になったらそのまま保たれる（`a` = 0 なら消える）。 */
  readonly tint?: { readonly from: RGBA; readonly color: RGBA; readonly total: number; readonly left: number };
  /** 暗転：`from` から `to`（0 = 明るい、1 = 真っ暗）へ変わり、暗転は明転を指示するまで保たれる。`color` は暗転の色。 */
  readonly fade?: { readonly from: number; readonly to: 0 | 1; readonly total: number; readonly left: number; readonly color: "black" | "white" };
}

export const NO_FX: VisualFx = {};

const WHITE: RGBA = { r: 255, g: 255, b: 255, a: 1 };

export function applyFxEffect(fx: VisualFx, effect: Effect): VisualFx {
  if (effect.kind === "screenShake") {
    return effect.durationTicks > 0 ? { ...fx, shake: { power: effect.power, total: effect.durationTicks, left: effect.durationTicks } } : fx;
  }
  if (effect.kind === "screenFlash") {
    return effect.durationTicks > 0 ? { ...fx, flash: { color: effect.color, total: effect.durationTicks, left: effect.durationTicks } } : fx;
  }
  if (effect.kind === "screenTint") return { ...fx, tint: { from: tintNow(fx), color: effect.color, total: effect.durationTicks, left: effect.durationTicks } };
  if (effect.kind === "screenFade") {
    // 色の指定が無い明転は、今の暗転の色のまま戻す（白く暗転した画面を黒から明転させない）。指定の無い暗転は黒
    const color = effect.color ?? (effect.to === 0 ? (fx.fade?.color ?? "black") : "black");
    return { ...fx, fade: { from: fadeNow(fx), to: effect.to, total: effect.durationTicks, left: effect.durationTicks, color } };
  }
  if (effect.kind === "showPicture") {
    const to: PictureView = { x: effect.x, y: effect.y, opacity: effect.opacity, scale: effect.scale };
    const picture: PictureFx = { asset: effect.asset, origin: effect.origin, from: { ...to, opacity: effect.durationTicks > 0 ? 0 : effect.opacity }, to, total: effect.durationTicks, left: effect.durationTicks };
    return { ...fx, pictures: { ...fx.pictures, [effect.id]: picture } };
  }
  if (effect.kind === "movePicture") {
    const pic = fx.pictures?.[effect.id];
    if (pic === undefined) return fx;
    const to: PictureView = { x: effect.x, y: effect.y, opacity: effect.opacity, scale: effect.scale };
    return { ...fx, pictures: { ...fx.pictures, [effect.id]: { ...pic, from: pictureNow(pic), to, total: effect.durationTicks, left: effect.durationTicks } } };
  }
  if (effect.kind === "erasePicture") {
    if (fx.pictures?.[effect.id] === undefined) return fx;
    const { [effect.id]: _gone, ...rest } = fx.pictures;
    return withPictures(fx, rest);
  }
  return fx;
}

/** `pictures` を差し替える（空なら項目ごと取り除く）。 */
function withPictures(fx: VisualFx, pictures: Readonly<Record<number, PictureFx>>): VisualFx {
  const { pictures: _old, ...rest } = fx;
  return Object.keys(pictures).length === 0 ? rest : { ...rest, pictures };
}

/** ピクチャをすべて消す（タイトルに戻ったとき）。 */
export function clearPictures(fx: VisualFx): VisualFx {
  return fx.pictures === undefined ? fx : withPictures(fx, {});
}

/** 今のピクチャの位置・不透明度・倍率（線形補間）。 */
export function pictureNow(p: PictureFx): PictureView {
  const k = progress(p);
  return { x: mix(p.from.x, p.to.x, k), y: mix(p.from.y, p.to.y, k), opacity: mix(p.from.opacity, p.to.opacity, k), scale: mix(p.from.scale, p.to.scale, k) };
}

/** 進み具合（0 → 1）。`total` が 0 なら最初から終わっている。 */
const progress = (t: { readonly total: number; readonly left: number }): number => (t.total <= 0 ? 1 : 1 - t.left / t.total);

const mix = (a: number, b: number, t: number): number => a + (b - a) * t;

/** 今の色調（線形補間）。 */
export function tintNow(fx: VisualFx): RGBA {
  const t = fx.tint;
  if (t === undefined) return NO_TINT;
  const k = progress(t);
  return { r: mix(t.from.r, t.color.r, k), g: mix(t.from.g, t.color.g, k), b: mix(t.from.b, t.color.b, k), a: mix(t.from.a, t.color.a, k) };
}

/** 今の暗さ（0〜1）。 */
export function fadeNow(fx: VisualFx): number {
  const f = fx.fade;
  return f === undefined ? 0 : mix(f.from, f.to, progress(f));
}

/** 1 フレーム分進める。終わった効果は取り除く。 */
export function tickFx(fx: VisualFx): VisualFx {
  const next: { -readonly [K in keyof VisualFx]: VisualFx[K] } = {};
  if (fx.shake && fx.shake.left > 1) next.shake = { ...fx.shake, left: fx.shake.left - 1 };
  if (fx.flash && fx.flash.left > 1) next.flash = { ...fx.flash, left: fx.flash.left - 1 };
  // 色調と暗転は、終わっても状態が保たれる（元に戻ったら取り除く）
  if (fx.tint) {
    const left = Math.max(0, fx.tint.left - 1);
    if (left > 0 || fx.tint.color.a > 0) next.tint = { ...fx.tint, left };
  }
  if (fx.pictures) {
    next.pictures = Object.fromEntries(Object.entries(fx.pictures).map(([id, p]) => [id, p.left > 0 ? { ...p, left: p.left - 1 } : p]));
  }
  if (fx.fade) {
    const left = Math.max(0, fx.fade.left - 1);
    if (left > 0 || fx.fade.to === 1) next.fade = { ...fx.fade, left };
  }
  return next;
}

/** `VisualFx` から `FrameSpec.overlay` を作る。時間だけの関数なので決定論的。 */
export function fxOverlay(fx: VisualFx): Overlay {
  const shake = fx.shake
    ? { dx: Math.round(Math.sin(fx.shake.left * 2.1) * fx.shake.power * (fx.shake.left / fx.shake.total)), dy: 0 }
    : { dx: 0, dy: 0 };
  return {
    fade: fadeNow(fx),
    ...(fx.fade?.color === "white" ? { fadeColor: WHITE } : {}),
    tint: tintNow(fx),
    ...(fx.flash ? { flash: { color: fx.flash.color, alpha: fx.flash.left / fx.flash.total } } : {}),
    shake,
  };
}
