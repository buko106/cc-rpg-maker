import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { sampleConfig, rngOf } from "./config.testkit.js";
import { BITE_FRAMES, DONE_FRAMES, pickFish, pickGear, pointsOf, rank, rivalScore, rollSize, startCast, stepCast, WAIT_MAX, WAIT_MIN, BARE_BITE } from "./fish.js";
import type { CastInput } from "./fish.js";
import type { CastState } from "./model.js";

const cfg = sampleConfig();
const fishOf = (key: string) => cfg.fish.find((f) => f.key === key)!;
const idle: CastInput = { ok: false, okTriggered: false, cancel: false };
const press: CastInput = { ok: true, okTriggered: true, cancel: false };

describe("pickFish", () => {
  it("[inv-1] その場所で釣れる魚だけを返す", () => {
    fc.assert(
      fc.property(fc.constantFrom("pier", "rocks", "deep"), fc.double({ min: 0.1, max: 10, noNaN: true }), fc.integer(), (spot, rare, seed) => {
        const f = pickFish(cfg, spot, rare, rngOf(seed));
        expect(f?.spots).toContain(spot);
      }),
    );
  });

  it("釣れる魚が無い場所では undefined", () => {
    expect(pickFish(cfg, "moon", 1, rngOf(1))).toBeUndefined();
  });

  it("重みに比例して選ばれる（イワシ : アジ = 12 : 10）", () => {
    const rng = rngOf(7);
    const n = { iwashi: 0, aji: 0 };
    for (let i = 0; i < 20000; i++) n[pickFish(cfg, "pier", 1, rng)!.key as "iwashi" | "aji"]++;
    expect(n.iwashi / n.aji).toBeGreaterThan(1.1);
    expect(n.iwashi / n.aji).toBeLessThan(1.3);
  });

  it("エサの rare が大きいほど、手ごわい魚（深場のマグロ）が出やすい。難しさ 1 の魚は影響を受けない", () => {
    const share = (rare: number, key: string, spot: string): number => {
      const rng = rngOf(3);
      let hit = 0;
      for (let i = 0; i < 20000; i++) if (pickFish(cfg, spot, rare, rng)!.key === key) hit++;
      return hit / 20000;
    };
    expect(share(3, "maguro", "deep")).toBeGreaterThan(share(1, "maguro", "deep") * 2);
    expect(share(1, "iwashi", "pier")).toBeCloseTo(share(3, "iwashi", "pier"), 5);
  });
});

describe("大きさと点数", () => {
  it("[inv-2] 大きさは範囲の中で、小さい方に偏る", () => {
    const f = fishOf("tai");
    const rng = rngOf(5);
    const sizes = Array.from({ length: 5000 }, () => rollSize(f, rng));
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(40);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(90);
    expect(sizes.filter((s) => s < 65).length).toBeGreaterThan(sizes.length * 0.5);
  });

  it("[inv-3] 点数は、大きいほど高く、基本の 0.6 〜 1.4 倍", () => {
    const f = fishOf("suzuki");
    expect(pointsOf(f, 40)).toBe(36);
    expect(pointsOf(f, 80)).toBe(84);
    fc.assert(
      fc.property(fc.double({ min: 40, max: 80, noNaN: true }), fc.double({ min: 40, max: 80, noNaN: true }), (a, b) => {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        expect(pointsOf(f, lo)).toBeLessThanOrEqual(pointsOf(f, hi));
      }),
    );
  });
});

describe("pickGear", () => {
  it("持っている中で一番大きい竿・一番良いエサを使う。何も無ければ基本の当たり判定とエサなし", () => {
    expect(pickGear(cfg, {})).toMatchObject({ zone: 0.2, rod: null, bait: undefined });
    const g = pickGear(cfg, { item_rod1: 1, item_rod2: 1, item_worm: 3, item_lure: 1 });
    expect(g.zone).toBe(0.36);
    expect(g.rod).toBe("ぐんじょう竿");
    expect(g.bait?.name).toBe("ルアー");
    expect(pickGear(cfg, { item_worm: 1, item_lure: 0 }).bait?.name).toBe("ミミズ");
  });
});

/** 巻き上げの途中まで進めた状態を作る。 */
function reeling(key: string, zoneSize: number, seed = 1): CastState {
  const f = fishOf(key);
  return { ...startCast("deep", zoneSize, undefined, rngOf(seed)), phase: "reel", left: 0, fish: key, size: (f.size[0] + f.size[1]) / 2 };
}

/** 最後まで進めて、結果の種類を返す。 */
function play(start: CastState, control: (c: CastState) => CastInput, seed: number, limit = 6000): { kind: string | undefined; frames: number } {
  const rng = rngOf(seed);
  let c = start;
  for (let i = 0; i < limit; i++) {
    const s = stepCast(c, control(c), cfg, rng);
    c = s.cast;
    if (s.outcome !== undefined) return { kind: s.outcome.kind, frames: i + 1 };
  }
  return { kind: undefined, frames: limit };
}

/** 当たり判定を、魚の位置に合わせるボット（押す = 右へ）。 */
const follower = (c: CastState): CastInput => ({ ok: c.zone + c.zoneVel * 14 < c.pos, okTriggered: false, cancel: false });

describe("stepCast：流れ", () => {
  it("待つ → あたり → 決定ボタンで巻き上げ → 釣れる、の順に進み、結果の表示は決まった時間で終わる", () => {
    const rng = rngOf(11);
    let c = startCast("pier", 0.36, undefined, rng);
    expect(c.left).toBeGreaterThanOrEqual(Math.round(WAIT_MIN * BARE_BITE));
    expect(c.left).toBeLessThanOrEqual(Math.round(WAIT_MAX * BARE_BITE));
    const phases = new Set<string>();
    let outcome: string | undefined;
    for (let i = 0; i < 4000 && !(c.phase === "done" && c.left === 0); i++) {
      const input = c.phase === "bite" ? press : c.phase === "reel" ? follower(c) : idle;
      const s = stepCast(c, input, cfg, rng);
      c = s.cast;
      phases.add(c.phase);
      outcome ??= s.outcome?.kind;
      if (s.end === true) break;
    }
    expect([...phases]).toEqual(["wait", "bite", "reel", "done"]);
    expect(outcome).toBe("caught");
  });

  it("早く押すと逃げられる（あたりが来る前の決定ボタン）", () => {
    const c = startCast("pier", 0.3, undefined, rngOf(1));
    const s = stepCast(c, press, cfg, rngOf(1));
    expect(s.outcome).toEqual({ kind: "early", fish: null });
    expect(s.cast.result?.kind).toBe("early");
  });

  it("あたりに気づかないと逃げられる（決定ボタンの受付は BITE_FRAMES）", () => {
    const rng = rngOf(2);
    let c: CastState = { ...startCast("pier", 0.3, undefined, rng), phase: "bite", left: BITE_FRAMES, fish: "aji", size: 15 };
    let outcome: string | undefined;
    for (let i = 0; i < BITE_FRAMES + 2 && outcome === undefined; i++) {
      const s = stepCast(c, idle, cfg, rng);
      c = s.cast;
      outcome = s.outcome?.kind;
    }
    expect(outcome).toBe("missed");
  });

  it("キャンセルでやめると、結果を見せずにすぐ終わる", () => {
    const rng = rngOf(3);
    const first = stepCast(startCast("pier", 0.3, undefined, rng), { ...idle, cancel: true }, cfg, rng);
    expect(first.outcome?.kind).toBe("quit");
    expect(stepCast(first.cast, idle, cfg, rng).end).toBe(true);
  });

  it("結果の表示は、しばらくしてから決定ボタンで飛ばせて、何もしなくても DONE_FRAMES で終わる", () => {
    const rng = rngOf(4);
    const done = { ...startCast("pier", 0.3, undefined, rng), phase: "done" as const, left: DONE_FRAMES, result: { kind: "lost" as const, fish: "aji", size: 10, points: 0, record: false, first: false } };
    expect(stepCast(done, press, cfg, rng).end).toBeUndefined(); // すぐには飛ばせない
    let c: CastState = done;
    let frames = 0;
    for (; frames < DONE_FRAMES + 5; frames++) {
      const s = stepCast(c, idle, cfg, rng);
      c = s.cast;
      if (s.end === true) break;
    }
    expect(frames + 1).toBe(DONE_FRAMES);
  });
});

describe("stepCast：巻き上げ", () => {
  it("[inv-4] どんな操作でも、位置・当たり判定・巻き上げた量は 0〜1 の中、当たり判定は端からはみ出さず、必ず決着がつく", () => {
    fc.assert(
      fc.property(fc.constantFrom("iwashi", "kasago", "suzuki", "tai", "maguro"), fc.double({ min: 0.1, max: 0.6, noNaN: true }), fc.array(fc.boolean(), { minLength: 1, maxLength: 80 }), fc.integer(), (key, zoneSize, pattern, seed) => {
        const rng = rngOf(seed);
        let c = reeling(key, zoneSize, seed);
        const half = zoneSize / 2;
        let outcome: string | undefined;
        for (let i = 0; i < 20000 && outcome === undefined; i++) {
          const ok = pattern[Math.floor(i / 7) % pattern.length]!;
          const s = stepCast(c, { ok, okTriggered: false, cancel: false }, cfg, rng);
          c = s.cast;
          for (const v of [c.pos, c.zone, c.progress, c.target]) expect(v >= 0 && v <= 1).toBe(true);
          expect(c.zone).toBeGreaterThanOrEqual(half - 1e-9);
          expect(c.zone).toBeLessThanOrEqual(1 - half + 1e-9);
          outcome = s.outcome?.kind;
        }
        expect(["caught", "lost"]).toContain(outcome);
      }),
      { numRuns: 60 },
    );
  });

  it("何もしないと（当たり判定が左端に張り付く）、ほとんどの魚に逃げられる", () => {
    for (const key of ["iwashi", "kasago", "suzuki", "tai", "maguro"]) {
      const lost = Array.from({ length: 20 }, (_, i) => play(reeling(key, 0.36, i), () => idle, i)).filter((r) => r.kind === "lost").length;
      expect(lost, key).toBeGreaterThanOrEqual(15);
    }
  });

  it("反応が少し遅れる（約 130ms）操作でも、竿の良さで釣れる魚が変わる：基本の竿は小物だけ、ふつうの竿は大半、良い竿はマグロも", () => {
    const delayed = (delay: number) => {
      let hist: CastState[] = [];
      return (c: CastState): CastInput => {
        hist = [...hist.slice(-delay), c];
        const seen = hist[0]!;
        return { ok: seen.zone + seen.zoneVel * (delay + 8) < seen.pos, okTriggered: false, cancel: false };
      };
    };
    const rate = (key: string, zone: number): number => Array.from({ length: 40 }, (_, i) => play(reeling(key, zone, i), delayed(8), 100 + i)).filter((r) => r.kind === "caught").length / 40;
    expect(rate("iwashi", 0.2)).toBeGreaterThan(0.9);
    expect(rate("suzuki", 0.2)).toBeLessThan(0.5);
    expect(rate("maguro", 0.2)).toBeLessThan(0.2);
    for (const key of ["iwashi", "kasago", "suzuki"]) expect(rate(key, 0.28), key).toBeGreaterThan(0.9);
    expect(rate("tai", 0.28)).toBeGreaterThan(0.6);
    expect(rate("maguro", 0.28)).toBeLessThan(0.9);
    for (const key of ["iwashi", "kasago", "suzuki", "tai", "maguro"]) expect(rate(key, 0.36), key).toBeGreaterThan(0.9);
  });

  it("[inv-5] 同じ状態・同じ乱数・同じ入力なら、同じ結果（決定論）", () => {
    const run = () => play(reeling("suzuki", 0.3, 9), follower, 77);
    expect(run()).toEqual(run());
  });
});

describe("大会の順位", () => {
  it("[inv-6] 点数の高い順に並び、同点ならプレイヤーが上。順位は 1 から", () => {
    expect(rank({ name: "あなた", score: 100 }, [{ name: "A", score: 100 }, { name: "B", score: 120 }])).toMatchObject({ rank: 2, standings: [{ name: "B" }, { name: "あなた" }, { name: "A" }] });
    expect(rank({ name: "あなた", score: 0 }, []).rank).toBe(1);
    fc.assert(
      fc.property(fc.nat(500), fc.array(fc.nat(500), { maxLength: 6 }), (me, others) => {
        const r = rank({ name: "me", score: me }, others.map((score, i) => ({ name: `r${i}`, score })));
        expect(r.rank).toBe(1 + others.filter((s) => s > me).length);
        expect(r.standings.map((s) => s.score)).toEqual([...r.standings.map((s) => s.score)].sort((a, b) => b - a));
      }),
    );
  });

  it("ライバルの点数は、めやすの 7 〜 13 割", () => {
    const rng = rngOf(8);
    for (let i = 0; i < 200; i++) {
      const s = rivalScore(100, rng);
      expect(s).toBeGreaterThanOrEqual(70);
      expect(s).toBeLessThanOrEqual(130);
    }
  });
});
