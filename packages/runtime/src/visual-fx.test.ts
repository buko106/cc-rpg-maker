import { describe, expect, it } from "vitest";
import { applyFxEffect, fxOverlay, NO_FX, tickFx } from "./visual-fx.js";

const white = { r: 255, g: 255, b: 255, a: 1 };

describe("VisualFx", () => {
  it("効果が無ければ overlay は静止", () => {
    expect(fxOverlay(NO_FX)).toEqual({ fade: 0, tint: { r: 0, g: 0, b: 0, a: 0 }, shake: { dx: 0, dy: 0 } });
  });

  it("シェイクは時間とともに減衰し、終わったら消える", () => {
    let fx = applyFxEffect(NO_FX, { kind: "screenShake", power: 8, durationTicks: 3 });
    expect(fx.shake).toEqual({ power: 8, total: 3, left: 3 });
    const amplitudes: number[] = [];
    for (let i = 0; i < 3; i++) {
      amplitudes.push(Math.abs(fxOverlay(fx).shake.dx));
      fx = tickFx(fx);
    }
    expect(amplitudes.every((a) => a <= 8)).toBe(true);
    expect(fx.shake).toBeUndefined();
    expect(fxOverlay(fx).shake).toEqual({ dx: 0, dy: 0 });
  });

  it("フラッシュは alpha が 1 → 0 へ減っていく", () => {
    let fx = applyFxEffect(NO_FX, { kind: "screenFlash", color: white, durationTicks: 4 });
    const alphas: number[] = [];
    while (fx.flash) {
      alphas.push(fxOverlay(fx).flash!.alpha);
      fx = tickFx(fx);
    }
    expect(alphas).toEqual([1, 0.75, 0.5, 0.25]);
  });

  it("長さ 0 以下の効果と無関係な Effect は無視する。tickFx は元を変更しない", () => {
    expect(applyFxEffect(NO_FX, { kind: "screenShake", power: 1, durationTicks: 0 })).toBe(NO_FX);
    expect(applyFxEffect(NO_FX, { kind: "stopBgm" })).toBe(NO_FX);
    const fx = applyFxEffect(NO_FX, { kind: "screenShake", power: 1, durationTicks: 5 });
    const before = JSON.stringify(fx);
    tickFx(fx);
    expect(JSON.stringify(fx)).toBe(before);
  });

  it("同じ効果を重ねて発行すると上書きされる", () => {
    const a = applyFxEffect(NO_FX, { kind: "screenShake", power: 2, durationTicks: 10 });
    const b = applyFxEffect(a, { kind: "screenShake", power: 9, durationTicks: 4 });
    expect(b.shake).toEqual({ power: 9, total: 4, left: 4 });
  });
});

describe("VisualFx: 色調と暗転", () => {
  const blue = { r: 0, g: 0, b: 200, a: 0.5 };
  it("色調は線形に変わり、終わってもそのまま保たれる。a = 0 に戻すと消える", () => {
    let fx = applyFxEffect(NO_FX, { kind: "screenTint", color: blue, durationTicks: 4 });
    const alphas: number[] = [];
    for (let i = 0; i < 4; i++) {
      alphas.push(fxOverlay(fx).tint.a);
      fx = tickFx(fx);
    }
    expect(alphas).toEqual([0, 0.125, 0.25, 0.375]);
    expect(fxOverlay(fx).tint).toEqual(blue);
    fx = tickFx(fx);
    expect(fxOverlay(fx).tint).toEqual(blue);
    // 元に戻す：現在の色から a = 0 へ
    fx = applyFxEffect(fx, { kind: "screenTint", color: { r: 0, g: 0, b: 0, a: 0 }, durationTicks: 2 });
    expect(fxOverlay(fx).tint).toEqual(blue);
    fx = tickFx(tickFx(tickFx(fx)));
    expect(fx.tint).toBeUndefined();
    expect(fxOverlay(fx).tint.a).toBe(0);
  });

  it("暗転は明転を指示するまで保たれ、明転が終わると消える", () => {
    let fx = applyFxEffect(NO_FX, { kind: "screenFade", to: 1, durationTicks: 2 });
    expect(fxOverlay(fx).fade).toBe(0);
    fx = tickFx(fx);
    expect(fxOverlay(fx).fade).toBe(0.5);
    fx = tickFx(tickFx(tickFx(fx)));
    expect(fxOverlay(fx).fade).toBe(1);
    fx = applyFxEffect(fx, { kind: "screenFade", to: 0, durationTicks: 2 });
    fx = tickFx(fx);
    expect(fxOverlay(fx).fade).toBe(0.5);
    fx = tickFx(tickFx(fx));
    expect(fx.fade).toBeUndefined();
  });

  it("白い暗転は overlay に fadeColor（白）を出す。黒は出さない。色の指定が無い明転は今の色のまま戻る", () => {
    let fx = applyFxEffect(NO_FX, { kind: "screenFade", to: 1, durationTicks: 0, color: "white" });
    expect(fxOverlay(fx)).toMatchObject({ fade: 1, fadeColor: { r: 255, g: 255, b: 255 } });
    fx = applyFxEffect(fx, { kind: "screenFade", to: 0, durationTicks: 2 });
    expect(fxOverlay(tickFx(fx))).toMatchObject({ fade: 0.5, fadeColor: { r: 255, g: 255, b: 255 } });
    expect(fxOverlay(applyFxEffect(NO_FX, { kind: "screenFade", to: 1, durationTicks: 0 }))).not.toHaveProperty("fadeColor");
    // 指定の無い暗転は黒
    expect(fxOverlay(applyFxEffect(fx, { kind: "screenFade", to: 1, durationTicks: 0 }))).not.toHaveProperty("fadeColor");
  });

  it("長さ 0 なら即座に切り替わる", () => {
    expect(fxOverlay(applyFxEffect(NO_FX, { kind: "screenFade", to: 1, durationTicks: 0 })).fade).toBe(1);
    expect(fxOverlay(applyFxEffect(NO_FX, { kind: "screenTint", color: blue, durationTicks: 0 })).tint).toEqual(blue);
  });
});
