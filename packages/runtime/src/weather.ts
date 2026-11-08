import type { Particle } from "./frame-spec.js";
import type { VisualFx } from "./visual-fx.js";

/** 整数 2 つから 0〜1 の疑似乱数（乱数源を持たないので、同じ `t` なら同じ絵になる）。 */
function hash(i: number, salt: number): number {
  let h = Math.imul(i + 1, 0x9e3779b1) ^ Math.imul(salt + 1, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 0x100000000;
}

const wrap = (v: number, size: number): number => ((v % size) + size) % size;

/** 1 つ分の粒。`i` 番目の粒の初期位置・速さは `i` だけで決まり、`t` フレーム目の位置は `t` の関数。 */
type Shape = (i: number, t: number, w: number, h: number) => Particle;

const SHAPES: Record<NonNullable<VisualFx["weather"]>["kind"], { readonly perLevel: number; readonly shape: Shape }> = {
  rain: {
    perLevel: 14,
    shape: (i, t, w, h) => {
      const speed = 9 + hash(i, 1) * 5;
      return {
        x: Math.round(wrap(hash(i, 2) * w - t * 1.5, w)),
        y: Math.round(wrap(hash(i, 3) * h + t * speed, h)),
        w: 1,
        h: 7,
        color: { r: 170, g: 200, b: 255, a: 0.55 },
      };
    },
  },
  snow: {
    perLevel: 10,
    shape: (i, t, w, h) => {
      const speed = 0.7 + hash(i, 1) * 1.1;
      const sway = Math.sin(t * 0.04 + hash(i, 4) * 6.28) * 10;
      const size = hash(i, 5) < 0.3 ? 3 : 2;
      return { x: Math.round(wrap(hash(i, 2) * w + sway, w)), y: Math.round(wrap(hash(i, 3) * h + t * speed, h)), w: size, h: size, color: { r: 255, g: 255, b: 255, a: 0.85 } };
    },
  },
  petals: {
    perLevel: 6,
    shape: (i, t, w, h) => {
      const speed = 0.9 + hash(i, 1) * 0.9;
      const sway = Math.sin(t * 0.05 + hash(i, 4) * 6.28) * 14;
      return {
        x: Math.round(wrap(hash(i, 2) * w + t * 0.7 + sway, w)),
        y: Math.round(wrap(hash(i, 3) * h + t * speed, h)),
        w: 3,
        h: 2,
        color: { r: 255, g: 182 + Math.round(hash(i, 6) * 30), b: 200, a: 0.9 },
      };
    },
  },
  dust: {
    perLevel: 8,
    shape: (i, t, w, h) => ({
      x: Math.round(wrap(hash(i, 2) * w + t * (0.15 + hash(i, 1) * 0.3), w)),
      y: Math.round(wrap(hash(i, 3) * h + Math.sin(t * 0.02 + hash(i, 4) * 6.28) * 6, h)),
      w: 1,
      h: 1,
      color: { r: 230, g: 220, b: 200, a: 0.35 + hash(i, 5) * 0.3 },
    }),
  },
  fireflies: {
    perLevel: 3,
    shape: (i, t, w, h) => {
      const blink = 0.5 + 0.5 * Math.sin(t * 0.05 + hash(i, 4) * 6.28);
      return {
        x: Math.round(hash(i, 2) * w + Math.sin(t * 0.017 + hash(i, 5) * 6.28) * 18),
        y: Math.round(hash(i, 3) * h + Math.cos(t * 0.013 + hash(i, 6) * 6.28) * 14),
        w: 2,
        h: 2,
        color: { r: 255, g: 240, b: 120, a: 0.15 + blink * 0.8 },
      };
    },
  },
};

/** 今の天気の粒（画面座標）。時間だけの関数なので決定論的。天気が無ければ空。 */
export function weatherParticles(fx: VisualFx, size: { readonly width: number; readonly height: number }): Particle[] {
  const w = fx.weather;
  if (w === undefined) return [];
  const { perLevel, shape } = SHAPES[w.kind];
  return Array.from({ length: perLevel * w.intensity }, (_, i) => shape(i, w.t, size.width, size.height));
}
