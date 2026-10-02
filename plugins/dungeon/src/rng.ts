/**
 * フロアの生成に使う、シード付きの乱数（mulberry32）。`ctx.rng`（ゲーム全体の乱数）とは別に、シードの文字列だけで決まる列を作る。
 * 同じシードなら同じ列になるので、フロアの生成は純関数になる（`generateFloor`）。アルゴリズムを変えると、保存済みのフロアの再現が変わる。
 */
export interface Rand {
  /** `[0, 1)` */
  next(): number;
  /** `[lo, hi]` の整数。 */
  int(lo: number, hi: number): number;
  pick<T>(xs: readonly T[]): T;
  chance(p: number): boolean;
}

/** 文字列を 32bit の数にする（FNV-1a）。 */
export function hashSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function seeded(seed: string): Rand {
  let a = hashSeed(seed);
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (lo: number, hi: number): number => lo + Math.floor(next() * (hi - lo + 1));
  return {
    next,
    int,
    pick: (xs) => {
      if (xs.length === 0) throw new RangeError("pick: 空配列");
      return xs[int(0, xs.length - 1)] as (typeof xs)[number];
    },
    chance: (p) => next() < p,
  };
}
