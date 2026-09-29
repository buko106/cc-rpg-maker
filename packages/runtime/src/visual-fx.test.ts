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
