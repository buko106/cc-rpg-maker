/**
 * 決定論的な乱数。`Math.random` は core / runtime で使わない（docs/00-principles.md §1.2）。
 * 実装は xoshiro128**（シードは cyrb128 で 128bit に展開）。アルゴリズムを変えるとリプレイが壊れるので固定。
 */

/** 直列化可能な乱数状態。GameState に入れる。 */
export interface RandomState {
  readonly seed: string;
  /** xoshiro128** の内部状態（uint32 × 4）。すべて 0 は不正。 */
  readonly s: readonly [number, number, number, number];
}

export interface Random {
  /** `[0,1)` の乱数。 */
  next(): number;
  /** `[minInclusive, maxInclusive]` の整数。整数でない、または min > max なら RangeError。 */
  int(minInclusive: number, maxInclusive: number): number;
  /** 配列から一様に1つ選ぶ。空配列なら RangeError。 */
  pick<T>(xs: readonly T[]): T;
  /**
   * 独立ストリーム（戦闘用など）。元のシードとラベルだけで決まるので、親の消費数に影響されず、
   * 親にも影響しない。同じラベルは同じ列を返す。
   */
  fork(label: string): Random;
  readonly seed: string;
  serialize(): RandomState;
}

/** 時刻のポート。core 内では tick 数から導出するので、実時間は runtime が供給する。 */
export interface Clock {
  /** ms */
  now(): number;
}

const rotl = (x: number, k: number): number => ((x << k) | (x >>> (32 - k))) >>> 0;

function cyrb128(str: string): [number, number, number, number] {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

/**
 * xoshiro128** の 1 ステップ。`s` を破壊的に更新して uint32 を返す。
 * 参照実装（Blackman & Vigna）と同じ。テストで既知ベクトルと照合する。
 * @internal
 */
export function xoshiro128ss(s: [number, number, number, number]): number {
  const result = Math.imul(rotl(Math.imul(s[1], 5) >>> 0, 7), 9) >>> 0;
  const t = (s[1] << 9) >>> 0;
  s[2] = (s[2] ^ s[0]) >>> 0;
  s[3] = (s[3] ^ s[1]) >>> 0;
  s[1] = (s[1] ^ s[2]) >>> 0;
  s[0] = (s[0] ^ s[3]) >>> 0;
  s[2] = (s[2] ^ t) >>> 0;
  s[3] = rotl(s[3], 11);
  return result;
}

function make(seed: string, state: [number, number, number, number]): Random {
  const self: Random = {
    seed,
    next: () => xoshiro128ss(state) / 4294967296,
    int(min, max) {
      if (!Number.isInteger(min) || !Number.isInteger(max) || min > max) {
        throw new RangeError(`Random.int: 不正な範囲 [${min}, ${max}]`);
      }
      return min + Math.floor(self.next() * (max - min + 1));
    },
    pick<T>(xs: readonly T[]): T {
      if (xs.length === 0) throw new RangeError("Random.pick: 空配列");
      return xs[Math.floor(self.next() * xs.length)] as T;
    },
    fork: (label) => createRandom(`${seed}/${label}`),
    serialize: () => ({ seed, s: [state[0], state[1], state[2], state[3]] }),
  };
  return self;
}

/** シード文字列から乱数を作る。同じシードは常に同じ列を返す。 */
export function createRandom(seed: string): Random {
  const state = cyrb128(seed);
  if (state.every((x) => x === 0)) state[0] = 1;
  return make(seed, state);
}

/** `serialize()` の結果から続きを再開する。不正な状態は RangeError。 */
export function restoreRandom(state: RandomState): Random {
  const s = state.s;
  if (s.length !== 4 || !s.every((x) => Number.isInteger(x) && x >= 0 && x <= 0xffffffff) || s.every((x) => x === 0)) {
    throw new RangeError("restoreRandom: 不正な乱数状態");
  }
  return make(state.seed, [s[0], s[1], s[2], s[3]]);
}
