import type { MapData, TroopId } from "@rpg/schema";
import { battleProject, loadFixtureProject, press } from "@rpg/test-utils";
import { describe, expect, it } from "vitest";
import { createCtx } from "../ctx.js";
import { emptyInput } from "../input.js";
import { rollEncounter } from "../map/index.js";
import { createProjectView } from "../project-view.js";
import type { GameState } from "../state.js";
import { initialState, step } from "./index.js";

type Table = NonNullable<MapData["encounters"]>;

/** battleProject（スライム・毒蜘蛛などのトループ）に、ランダムエンカウントを持つ minimal のマップ（内側 x 1..8・y 1..6、開始 (2, 2)）を載せる。 */
function setup(encounters: Table | undefined, encounterStep?: number) {
  const project = battleProject();
  const { maps } = loadFixtureProject("minimal");
  const map = structuredClone(maps["map_start" as never]!) as MapData;
  const patched: MapData = { ...map, ...(encounters === undefined ? {} : { encounters }), ...(encounterStep === undefined ? {} : { encounterStep }) };
  const ctx = createCtx(createProjectView(project, { ...maps, ["map_start" as never]: patched }));
  return { ctx, map: patched, state: initialState(ctx, "seed-e") };
}
const table = (...troops: [string, number][]): Table => troops.map(([troop, weight]) => ({ troop: troop as TroopId, weight }));

/** 1 歩（移動の補間が終わるまで）進める。途中で戦闘になったらそこで止める。 */
function walk(state: GameState, ctx: ReturnType<typeof setup>["ctx"], dir: "left" | "right" | "up" | "down"): GameState {
  let s = step(state, press(dir), ctx).state;
  for (let i = 0; i < 40 && s.scene.kind === "map" && s.map.player.moving; i++) s = step(s, emptyInput(), ctx).state;
  return s;
}
/** 右・左と往復して `n` 歩あるく。 */
function walkN(state: GameState, ctx: ReturnType<typeof setup>["ctx"], n: number): GameState {
  let s = state;
  for (let i = 0; i < n && s.scene.kind === "map"; i++) s = walk(s, ctx, i % 2 === 0 ? "right" : "left");
  return s;
}

describe("rollEncounter（遭遇の判定）", () => {
  const { map } = setup(table(["tr_slime", 3], ["tr_spider", 1]), 20);

  it("敵グループが無いマップでは遭遇しない", () => {
    expect(rollEncounter({ ...map, encounters: [] }, 100, "s", 1)).toBeUndefined();
    const { encounters: _e, ...none } = map;
    expect(rollEncounter(none, 100, "s", 1)).toBeUndefined();
  });

  it("戦闘のあと、平均歩数の半分までは遭遇しない", () => {
    for (let tick = 0; tick < 200; tick++) expect(rollEncounter(map, 10, "s", tick)).toBeUndefined();
  });

  it("同じシード・同じ tick なら同じ結果で、平均歩数ほどで遭遇する（重みの比でトループを選ぶ）", () => {
    expect(rollEncounter(map, 15, "s", 7)).toBe(rollEncounter(map, 15, "s", 7));
    const walks: number[] = [];
    const counts: Record<string, number> = {};
    let tick = 0;
    for (let trial = 0; trial < 1500; trial++) {
      let steps = 0;
      for (;;) {
        steps++;
        const hit = rollEncounter(map, steps, "avg-seed", tick++);
        if (hit === undefined) continue;
        counts[hit] = (counts[hit] ?? 0) + 1;
        walks.push(steps);
        break;
      }
    }
    const mean = walks.reduce((a, b) => a + b, 0) / walks.length;
    expect(mean).toBeGreaterThan(18);
    expect(mean).toBeLessThan(22);
    expect(Math.min(...walks)).toBeGreaterThan(10);
    const slimeShare = (counts["tr_slime"] ?? 0) / walks.length;
    expect(slimeShare).toBeGreaterThan(0.7);
    expect(slimeShare).toBeLessThan(0.8);
  });

  it("平均歩数 1 なら毎歩遭遇する", () => {
    const every = { ...map, encounterStep: 1 };
    for (let tick = 0; tick < 50; tick++) expect(rollEncounter(every, 1, "s", tick)).toBeDefined();
  });
});

describe("歩数エンカウント", () => {
  it("encounters の無いマップでは、いくら歩いても戦闘にならない", () => {
    const { ctx, state } = setup(undefined);
    expect(walkN(state, ctx, 200).scene.kind).toBe("map");
  });

  it("歩くと戦闘になる（逃げられる・負けるとゲームオーバー）。マップ上の位置は 1 歩進んだところ", () => {
    const { ctx, state } = setup(table(["tr_slime", 1]), 1);
    const s = walk(state, ctx, "right");
    expect(s.scene.kind).toBe("battle");
    expect(s.battle?.troopId).toBe("tr_slime");
    expect(s.battle?.canEscape).toBe(true);
    expect(s.battle?.canLose).toBe(false);
    expect([s.map.player.x, s.map.player.y]).toEqual([3, 2]);
    expect(s.map.encounterSteps).toBe(0);
  });

  it("壁に突き当たっただけ（1 歩も進まない）では歩数が増えず、遭遇もしない", () => {
    const { ctx, state } = setup(table(["tr_slime", 1]), 1);
    const start = { ...state, map: { ...state.map, player: { ...state.map.player, x: 1, y: 1, realX: 1, realY: 1 } } };
    let s = start;
    for (let i = 0; i < 60; i++) s = step(s, press(i % 2 === 0 ? "left" : "up"), ctx).state; // 左と上は壁
    expect(s.scene.kind).toBe("map");
    expect([s.map.player.x, s.map.player.y]).toEqual([1, 1]);
    expect(s.map.encounterSteps).toBe(0);
  });

  it("戦闘のあと（勝っても逃げても）は、平均の半分ほどの歩数は遭遇しない", () => {
    const { ctx, state } = setup(table(["tr_slime", 1]), 12); // 安全歩数 6
    let s = state;
    let steps = 0;
    while (s.scene.kind === "map" && steps < 200) {
      s = walk(s, ctx, steps % 2 === 0 ? "right" : "left");
      steps++;
    }
    expect(s.scene.kind).toBe("battle");
    expect(steps).toBeGreaterThan(6);
    // 戦闘を終えてマップに戻る（逃走と同じ扱い）
    const left = step({ ...s, battle: { ...s.battle!, phase: "aborted", wait: 0, result: { outcome: "aborted", exp: 0, gold: 0, drops: [] } } }, press("ok"), ctx).state;
    expect(left.scene.kind).toBe("map");
    expect(left.map.encounterSteps).toBe(0);
    const after = walkN(left, ctx, 6);
    expect(after.scene.kind).toBe("map");
    expect(after.map.encounterSteps).toBe(6);
  });

  it("マップの乱数（rng）を消費しないので、エンカウントの有無でイベントの乱数列は変わらない", () => {
    const { ctx, state } = setup(table(["tr_slime", 1]), 1000);
    const walked = walkN(state, ctx, 5);
    expect(walked.scene.kind).toBe("map");
    expect(walked.rng).toEqual(state.rng);
  });

  it("同じシードなら、同じ歩き方で同じ場所（歩数）で同じトループと遭遇する", () => {
    const meet = (): [number, string | undefined] => {
      const { ctx, state } = setup(table(["tr_slime", 1], ["tr_spider", 1], ["tr_golem", 1]), 15);
      let s = state;
      let steps = 0;
      while (s.scene.kind === "map" && steps < 300) {
        s = walk(s, ctx, steps % 2 === 0 ? "right" : "left");
        steps++;
      }
      return [steps, s.battle?.troopId];
    };
    expect(meet()).toEqual(meet());
    expect(meet()[1]).toBeDefined();
  });
});
