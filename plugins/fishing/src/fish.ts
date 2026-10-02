import type { BaitEntry, Config, FishEntry } from "./config.js";
import type { CastResult, CastState } from "./model.js";

/** 乱数の窓口（core の `Random` のうち、ここで使う部分）。 */
export interface Rng {
  next(): number;
}

/** 入力（1 フレーム分）。 */
export interface CastInput {
  /** 決定ボタンが押されている（巻き上げのあいだ、押している間は当たり判定が右へ動く）。 */
  ok: boolean;
  /** 決定ボタンが、このフレームで押された。 */
  okTriggered: boolean;
  /** キャンセルが、このフレームで押された。 */
  cancel: boolean;
}

/** あたりが来るまでの時間（フレーム）。エサの `bite` をかける。 */
export const WAIT_MIN = 90;
export const WAIT_MAX = 260;
/** エサなしのときの、あたりが来るまでの時間の倍率と、手ごわい魚の出やすさ。 */
export const BARE_BITE = 1.4;
export const BARE_RARE = 0.7;
/** あたりが来てから、決定ボタンを押せる時間（フレーム）。 */
export const BITE_FRAMES = 40;
/** 結果を見せておく時間（フレーム）と、そのうち、決定ボタンで飛ばせるようになるまでの時間。 */
export const DONE_FRAMES = 110;
export const DONE_SKIP_AFTER = 24;
/** 巻き上げを始めるときに、巻き上げた量がどこから始まるか。 */
export const PROGRESS_START = 0.35;

const round1 = (n: number): number => Math.round(n * 10) / 10;
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/** 魚の出やすさ。手ごわい魚（難しさが大きい）ほど、エサの `rare` の影響を受ける。 */
export const effectiveWeight = (f: FishEntry, rare: number): number => f.weight * Math.pow(rare, (f.difficulty - 1) / 2);

/** その場所で釣れる魚から、重みつきで 1 匹選ぶ（その場所で釣れる魚が無ければ `undefined`）。 */
export function pickFish(cfg: Config, spot: string, rare: number, rng: Rng): FishEntry | undefined {
  const pool = cfg.fish.filter((f) => f.spots.includes(spot));
  const total = pool.reduce((n, f) => n + effectiveWeight(f, rare), 0);
  if (pool.length === 0 || total <= 0) return undefined;
  let r = rng.next() * total;
  for (const f of pool) {
    r -= effectiveWeight(f, rare);
    if (r < 0) return f;
  }
  return pool[pool.length - 1];
}

/** 大きさ（cm）。小さい方に偏る（大物ほど出にくい）。 */
export function rollSize(f: FishEntry, rng: Rng): number {
  const [lo, hi] = f.size;
  return round1(lo + (hi - lo) * Math.pow(rng.next(), 1.6));
}

/** 大会の点数：基本の点数に、大きさ（小さいほど 0.6 倍、大きいほど 1.4 倍）をかける。 */
export function pointsOf(f: FishEntry, size: number): number {
  const [lo, hi] = f.size;
  const ratio = hi > lo ? clamp((size - lo) / (hi - lo), 0, 1) : 0.5;
  return Math.round(f.points * (0.6 + 0.8 * ratio));
}

/** 持っている竿・エサから、今回使うものを決める（竿は当たり判定が最大のもの、エサは `rare` が最大のもの）。 */
export function pickGear(cfg: Config, items: Readonly<Record<string, number>>): { zone: number; rod: string | null; bait: BaitEntry | undefined } {
  const has = (item: string): boolean => (items[item] ?? 0) > 0;
  let zone = cfg.baseZone;
  let rod: string | null = null;
  for (const r of cfg.rods) {
    if (has(r.item) && r.zone > zone) {
      zone = r.zone;
      rod = r.name;
    }
  }
  let bait: BaitEntry | undefined;
  for (const b of cfg.baits) if (has(b.item) && (bait === undefined || b.rare > bait.rare)) bait = b;
  return { zone, rod, bait };
}

/** 竿を振る。 */
export function startCast(spot: string, zone: number, bait: BaitEntry | undefined, rng: Rng): CastState {
  const wait = Math.round((WAIT_MIN + rng.next() * (WAIT_MAX - WAIT_MIN)) * (bait?.bite ?? BARE_BITE));
  return {
    phase: "wait",
    left: wait,
    t: 0,
    spot,
    bait: bait?.name ?? null,
    zoneSize: zone,
    rare: bait?.rare ?? BARE_RARE,
    fish: null,
    size: 0,
    pos: 0.5,
    target: 0.5,
    zone: 0.5,
    zoneVel: 0,
    progress: PROGRESS_START,
    result: null,
  };
}

/** 魚の動き：1 フレームに動ける量（バーの長さに対する割合）と、動く先を選び直す間隔（フレーム）。 */
export const fishSpeed = (difficulty: number): number => 0.004 + 0.0022 * difficulty;
export const retargetEvery = (difficulty: number): number => Math.max(16, 62 - difficulty * 9);
/** 当たり判定の動き：押している間は右へ、離すと左へ加速する。 */
const ZONE_ACCEL = 0.0018;
const ZONE_MAX_SPEED = 0.016;
const ZONE_DAMP = 0.97;
/** 魚が当たり判定の中にいる間に巻き上がる量と、外にいる間に戻る量（1 フレームあたり）。 */
const GAIN = 0.0046;
const lossOf = (difficulty: number): number => 0.0028 + 0.0004 * difficulty;

/** 結果の表示に入る。自分でやめたとき（`quit`）は、見せずにすぐ終える。 */
const finish = (cast: CastState, result: CastResult): CastState => ({ ...cast, phase: "done", left: result.kind === "quit" ? 1 : DONE_FRAMES, result });
const noFish = (kind: CastResult["kind"]): CastResult => ({ kind, fish: null, size: 0, points: 0, record: false, first: false });

/** `step` の結果。`outcome` は、巻き上げが終わった（釣れた・逃げられた）フレームにだけ付く。`end` は、結果の表示が終わったとき。 */
export interface CastStep {
  cast: CastState;
  /** 結果が決まった。呼び出し側が、持ち物・図鑑・点数に反映する（`record` / `first` は呼び出し側が埋める）。 */
  outcome?: { kind: "caught" | "lost"; fish: FishEntry; size: number } | { kind: "missed" | "early" | "quit" | "nothing"; fish: FishEntry | null };
  end?: boolean;
}

/** 1 フレーム進める。純関数（乱数は `rng` だけ）。 */
export function stepCast(cast: CastState, input: CastInput, cfg: Config, rng: Rng): CastStep {
  const t = cast.t + 1;
  const fishOf = (key: string | null): FishEntry | null => (key === null ? null : (cfg.fish.find((f) => f.key === key) ?? null));

  if (cast.phase === "wait") {
    if (input.cancel) return { cast: finish({ ...cast, t }, noFish("quit")), outcome: { kind: "quit", fish: null } };
    if (input.okTriggered) return { cast: finish({ ...cast, t }, noFish("early")), outcome: { kind: "early", fish: null } };
    if (cast.left > 1) return { cast: { ...cast, t, left: cast.left - 1 } };
    const f = pickFish(cfg, cast.spot, cast.rare, rng);
    if (f === undefined) return { cast: finish({ ...cast, t }, noFish("nothing")), outcome: { kind: "nothing", fish: null } };
    return { cast: { ...cast, t, phase: "bite", left: BITE_FRAMES, fish: f.key, size: rollSize(f, rng) } };
  }

  if (cast.phase === "bite") {
    const f = fishOf(cast.fish);
    if (input.okTriggered) {
      return { cast: { ...cast, t, phase: "reel", left: 0, pos: 0.5, target: rng.next(), zone: 0.5, zoneVel: 0, progress: PROGRESS_START } };
    }
    if (cast.left > 1) return { cast: { ...cast, t, left: cast.left - 1 } };
    return { cast: finish({ ...cast, t }, noFish("missed")), outcome: { kind: "missed", fish: f } };
  }

  if (cast.phase === "reel") {
    const f = fishOf(cast.fish);
    if (f === null) return { cast: finish({ ...cast, t }, noFish("nothing")), outcome: { kind: "nothing", fish: null } };
    const d = f.difficulty;
    // 魚：動く先へ向かう。ときどき、動く先を選び直す
    let target = cast.target;
    if (t % retargetEvery(d) === 0) target = rng.next();
    const speed = fishSpeed(d);
    const pos = clamp(cast.pos + clamp(target - cast.pos, -speed, speed), 0, 1);
    // 当たり判定：押している間は右へ、離すと左へ。端では止まる
    const half = cast.zoneSize / 2;
    let zoneVel = clamp((cast.zoneVel + (input.ok ? ZONE_ACCEL : -ZONE_ACCEL)) * ZONE_DAMP, -ZONE_MAX_SPEED, ZONE_MAX_SPEED);
    let zone = cast.zone + zoneVel;
    if (zone < half || zone > 1 - half) {
      zone = clamp(zone, half, 1 - half);
      zoneVel = 0;
    }
    const inside = Math.abs(pos - zone) <= half;
    const progress = clamp(cast.progress + (inside ? GAIN : -lossOf(d)), 0, 1);
    const next: CastState = { ...cast, t, target, pos, zone, zoneVel, progress };
    if (progress >= 1) return { cast: finish(next, { kind: "caught", fish: f.key, size: cast.size, points: 0, record: false, first: false }), outcome: { kind: "caught", fish: f, size: cast.size } };
    if (progress <= 0) return { cast: finish(next, { kind: "lost", fish: f.key, size: cast.size, points: 0, record: false, first: false }), outcome: { kind: "lost", fish: f, size: cast.size } };
    return { cast: next };
  }

  // done：しばらく見せて、決定ボタンで（少したってから）飛ばせる
  const skip = input.okTriggered && DONE_FRAMES - cast.left >= DONE_SKIP_AFTER;
  if (skip || cast.left <= 1) return { cast: { ...cast, t, left: 0 }, end: true };
  return { cast: { ...cast, t, left: cast.left - 1 } };
}

/** 競う相手の点数：めやす（`skill`）の 7 〜 13 割。 */
export const rivalScore = (skill: number, rng: Rng): number => Math.round(skill * (0.7 + 0.6 * rng.next()));

export interface Standing {
  name: string;
  score: number;
  you: boolean;
}

/** 順位表（点数の高い順。同点のときは、プレイヤーが上）と、プレイヤーの順位（1 から）。 */
export function rank(player: { name: string; score: number }, rivals: readonly { name: string; score: number }[]): { standings: Standing[]; rank: number } {
  const all: Standing[] = [{ name: player.name, score: player.score, you: true }, ...rivals.map((r) => ({ name: r.name, score: r.score, you: false }))];
  const standings = all.map((s, i) => ({ s, i })).sort((a, b) => b.s.score - a.s.score || Number(b.s.you) - Number(a.s.you) || a.i - b.i).map(({ s }) => s);
  return { standings, rank: standings.findIndex((s) => s.you) + 1 };
}
