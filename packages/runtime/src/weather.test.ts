import { describe, expect, it } from "vitest";
import { applyFxEffect, clearWeather, NO_FX, tickFx } from "./visual-fx.js";
import { weatherParticles } from "./weather.js";

const size = { width: 320, height: 256 };

describe("天気", () => {
  it("setWeather で降り始め、tickFx ごとに t が進み、none で止む", () => {
    let fx = applyFxEffect(NO_FX, { kind: "setWeather", weather: "rain", intensity: 3 });
    expect(fx.weather).toEqual({ kind: "rain", intensity: 3, t: 0 });
    fx = tickFx(tickFx(fx));
    expect(fx.weather?.t).toBe(2);
    expect(applyFxEffect(fx, { kind: "setWeather", weather: "none", intensity: 1 }).weather).toBeUndefined();
    expect(clearWeather(fx).weather).toBeUndefined();
  });

  it("同じ指定の繰り返しでは t を戻さず、違う指定なら降り直す", () => {
    const fx = tickFx(applyFxEffect(NO_FX, { kind: "setWeather", weather: "snow", intensity: 4 }));
    expect(applyFxEffect(fx, { kind: "setWeather", weather: "snow", intensity: 4 })).toBe(fx);
    expect(applyFxEffect(fx, { kind: "setWeather", weather: "snow", intensity: 5 }).weather?.t).toBe(0);
  });

  it("粒の数は強さに比例し、同じ t なら同じ位置（決定論）。すべて画面内", () => {
    for (const kind of ["rain", "snow", "petals", "dust", "fireflies"] as const) {
      const a = weatherParticles({ weather: { kind, intensity: 5, t: 123 } }, size);
      const b = weatherParticles({ weather: { kind, intensity: 5, t: 123 } }, size);
      expect(a).toEqual(b);
      expect(a.length).toBe(weatherParticles({ weather: { kind, intensity: 10, t: 123 } }, size).length / 2);
      if (kind !== "fireflies") expect(a.every((p) => p.x >= 0 && p.x < size.width && p.y >= 0 && p.y < size.height)).toBe(true);
      expect(weatherParticles({ weather: { kind, intensity: 5, t: 124 } }, size)).not.toEqual(a);
    }
  });

  it("天気が無ければ粒は無い", () => {
    expect(weatherParticles(NO_FX, size)).toEqual([]);
  });
});
