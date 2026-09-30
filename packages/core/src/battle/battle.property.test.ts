import type { GameState, InputFrame } from "../index.js";
import { inputFrame, step } from "../index.js";
import { battleKit, beginBattle, deepFreeze } from "@rpg/test-utils";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { effectiveParam } from "./battlers.js";
import { battleOutcome } from "./flow.js";
import { allBattlers } from "./helpers.js";

const BUTTONS = ["up", "down", "left", "right", "ok", "cancel"] as const;
const frame = (b: (typeof BUTTONS)[number] | "none"): InputFrame => (b === "none" ? inputFrame([], []) : inputFrame([b], [b]));

/** 入力の並び：ボタン 1 つ + 何もしないフレーム（解決中の待ちを進める）を混ぜる。 */
const inputs = fc.array(fc.oneof({ weight: 5, arbitrary: fc.constantFrom(...BUTTONS) }, { weight: 3, arbitrary: fc.constant("none" as const) }), { minLength: 1, maxLength: 400 });

const troops = ["tr_slime", "tr_slimes", "tr_golem", "tr_spider", "tr_sleeper", "tr_mixed", "tr_brute"] as const;

const kit = battleKit({
  // 全スキルを使いたくなるように、魔法使いの MP を多めに
  mutate: (p) => {
    p.database.classes["class_mage" as never]!.params.mmp = { base: 60, growth: 0 };
    p.database.classes["class_mage" as never]!.skills.push({ level: 1, skill: "sk_poison" as never }, { level: 1, skill: "sk_revive" as never }, { level: 1, skill: "sk_cleanse" as never });
  },
});
const { ctx } = kit;

function checkInvariants(s: GameState): void {
  const b = s.battle;
  if (b === undefined) return;
  for (const battler of allBattlers(b)) {
    expect(battler.hp, `${battler.id}.hp`).toBeGreaterThanOrEqual(0);
    expect(battler.hp, `${battler.id}.hp`).toBeLessThanOrEqual(effectiveParam(ctx, battler, "mhp"));
    expect(battler.mp, `${battler.id}.mp`).toBeGreaterThanOrEqual(0);
    expect(battler.mp, `${battler.id}.mp`).toBeLessThanOrEqual(effectiveParam(ctx, battler, "mmp"));
    if (battler.hp === 0) expect(battler.states, `${battler.id} fallen`).toEqual([]);
    for (const level of Object.values(battler.buffs)) expect(Math.abs(level)).toBeLessThanOrEqual(2);
  }
  for (const a of Object.values(s.actors)) expect(a.hp).toBeGreaterThanOrEqual(0);
  expect(b.log.length).toBeLessThanOrEqual(32);
  if (b.phase === "victory") expect(battleOutcome(b)).toBe("victory");
  if (b.phase === "defeat") expect(battleOutcome(b)).toBe("defeat");
}

describe("battle properties", () => {
  it("hp/mp stay within [0, max] and the state is never mutated, for any input sequence (invariant 1)", () => {
    fc.assert(
      fc.property(fc.constantFrom(...troops), fc.constantFrom(true, false), inputs, (troop, canLose, seq) => {
        let s = beginBattle(kit, troop, { canLose });
        for (const b of seq) {
          if (s.scene.kind !== "battle") break;
          s = step(deepFreeze(s), frame(b), ctx).state;
          checkInvariants(s);
        }
      }),
      { numRuns: 120 },
    );
  });

  it("a resolving battle always makes progress every frame, and an empty queue moves on to the next turn or an end phase (invariant 3: never stuck)", () => {
    // 敵が眠りを撒き続けるような内容だと「入力の無い自動ターン」が延々と続きうるので、終わることは要求しない。
    // 要求するのは、どのフレームでも待ち・キュー・ターン・フェーズのどれかが進むこと（同じ状態に居座らない）。
    const signature = (s: GameState): string => `${s.battle!.phase}/${s.battle!.turn}/${s.battle!.queue.length}/${s.battle!.wait}/${s.battle!.log.length}`;
    fc.assert(
      fc.property(fc.constantFrom(...troops), fc.array(fc.constantFrom(...BUTTONS), { maxLength: 30 }), (troop, presses) => {
        let s = beginBattle(kit, troop, { canLose: true });
        for (const b of presses) s = step(s, frame(b), ctx).state;
        for (let n = 0; n < 600 && s.scene.kind === "battle" && s.battle!.phase === "resolve"; n++) {
          const before = signature(s);
          s = step(s, frame("none"), ctx).state;
          if (s.scene.kind === "battle") expect(signature(s), `frame ${n}`).not.toBe(before);
        }
        if (s.scene.kind === "battle" && s.battle!.phase === "resolve" && s.battle!.queue.length === 0) expect(s.battle!.wait).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: 100 },
    );
  });

  it("the same seed and input sequence give an identical final state", () => {
    fc.assert(
      fc.property(fc.constantFrom(...troops), inputs, (troop, seq) => {
        const run = () => {
          let s = beginBattle(kit, troop, { canLose: true });
          for (const b of seq) if (s.scene.kind === "battle") s = step(s, frame(b), ctx).state;
          return s;
        };
        expect(run()).toEqual(run());
      }),
      { numRuns: 40 },
    );
  });

  it("the outcome is a defeat whenever the whole party is down, even if every enemy is down too (invariant 5)", () => {
    const s = beginBattle(kit, "tr_slime");
    const b = s.battle!;
    const down = <T extends { hp: number }>(x: T): T => ({ ...x, hp: 0 });
    const allDown = { ...b, allies: Object.fromEntries(Object.entries(b.allies).map(([k, v]) => [k, down(v)])), enemies: { "e:0": down(b.enemies["e:0"]!) } };
    expect(battleOutcome(allDown)).toBe("defeat");
    expect(battleOutcome({ ...allDown, allies: b.allies })).toBe("victory");
    expect(battleOutcome({ ...allDown, enemies: b.enemies })).toBe("defeat");
    expect(battleOutcome(b)).toBe("ongoing");
  });
});
