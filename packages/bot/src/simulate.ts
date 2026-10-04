import { actorParamsOf, createRandom, equipSlotOf, equipsOf, expToReach, LEVEL_MAX, startBattle } from "@rpg/core";
import type { Ctx, GameState } from "@rpg/core";
import type { ActorId, ItemId, TroopId } from "@rpg/schema";
import { runBattle } from "./driver.js";
import type { BattlePolicy } from "./driver.js";
import { smartPolicy } from "./policies.js";

/** 試す前のパーティの整え方。 */
export interface PartySetup {
  /** パーティ全員をこのレベルにする（経験値もそのレベルの最低値）。省略時はいまのまま。 */
  level?: number;
  /** 持ち物をこの数にする（ここに無いアイテムはそのまま）。 */
  items?: Readonly<Record<string, number>>;
  /** アクターごとに付ける装備（アイテム ID。欄はアイテムから決まる）。持ち物は減らさない。付けられないものは例外。 */
  equips?: Readonly<Record<string, readonly string[]>>;
  /** HP/MP を全快にするか。既定 true。 */
  fullRecover?: boolean;
}

/** パーティを `setup` のとおりに整える（レベル・装備 → 全快 → 持ち物）。 */
export function prepareParty(state: GameState, ctx: Ctx, setup: PartySetup = {}): GameState {
  const actors = { ...state.actors };
  for (const id of state.party.members) {
    const actor = Object.hasOwn(actors, id) ? actors[id] : undefined;
    if (actor === undefined) continue;
    const level = setup.level === undefined ? actor.level : Math.min(Math.max(1, Math.trunc(setup.level)), LEVEL_MAX);
    actors[id] = { ...actor, level, exp: setup.level === undefined ? actor.exp : expToReach(level) };
  }
  for (const [actorId, ids] of Object.entries(setup.equips ?? {})) {
    const actor = Object.hasOwn(actors, actorId) ? actors[actorId as ActorId] : undefined;
    if (actor === undefined) throw new Error(`prepareParty: アクター ${actorId} がいない`);
    const equips = { ...equipsOf(state, ctx, actor.id) };
    for (const id of ids) {
      const slot = equipSlotOf(ctx.project.item(id as ItemId));
      if (slot === undefined) throw new Error(`prepareParty: ${id} は装備できない`);
      equips[slot] = id as ItemId;
    }
    actors[actor.id] = { ...actor, equips };
  }
  let s: GameState = { ...state, actors };
  if (setup.fullRecover ?? true) {
    const healed = { ...s.actors };
    for (const id of s.party.members) {
      const actor = Object.hasOwn(healed, id) ? healed[id] : undefined;
      if (actor === undefined) continue;
      const p = actorParamsOf(s, ctx, id);
      healed[id] = { ...actor, hp: p.mhp, mp: p.mmp };
    }
    s = { ...s, actors: healed };
  }
  if (setup.items !== undefined) {
    const items = { ...s.party.items };
    for (const [id, n] of Object.entries(setup.items)) {
      if (n > 0) items[id as ItemId] = Math.trunc(n);
      else delete items[id as ItemId];
    }
    s = { ...s, party: { ...s.party, items } };
  }
  return s;
}

export interface SimulationOptions {
  troop: string;
  /** 試す回数（乱数の種を変えて戦う）。 */
  runs: number;
  /** 戦い方。既定は `smartPolicy()`。 */
  policy?: BattlePolicy;
  /** 乱数の種の元。`<seed>:<回数>` が各回の種になる（同じ種なら同じ結果）。既定 `"bot"`。 */
  seed?: string;
  party?: PartySetup;
  /** 逃走を選べるか（作戦は逃走を選ばない）。既定 false。 */
  canEscape?: boolean;
}

/** 何回か戦った結果のまとめ。HP の残りは、パーティの最大 HP の合計に対する、残り HP の合計の割合（0〜1）。 */
export interface BattleReport {
  troop: string;
  runs: number;
  wins: number;
  defeats: number;
  /** 勝ちの割合（0〜1）。 */
  winRate: number;
  /** 勝った戦闘の平均ターン数（勝ちが無ければ `null`）。 */
  avgTurns: number | null;
  maxTurns: number;
  /** 勝った戦闘の、HP の残りの平均と最小（勝ちが無ければ `null`）。 */
  avgHpLeft: number | null;
  minHpLeft: number | null;
}

/**
 * `troop` と `runs` 回戦い、勝率・ターン数・HP の残りをまとめる。戦闘は `core.step` と同じ経路で進む（バトルイベントも動く）。
 * 負けてもゲームオーバーにはしない（`canLose`）。各回は `state` から始め直すので、経験値やドロップは持ち越さない。
 */
export function simulateBattles(state: GameState, ctx: Ctx, options: SimulationOptions): BattleReport {
  const troop = options.troop as TroopId;
  if (ctx.project.troop(troop) === undefined) throw new Error(`simulateBattles: 敵グループ ${options.troop} が無い`);
  const policy = options.policy ?? smartPolicy();
  const base = prepareParty(state, ctx, options.party);
  let wins = 0;
  let defeats = 0;
  let maxTurns = 0;
  const turns: number[] = [];
  const hpLeft: number[] = [];
  for (let i = 0; i < options.runs; i++) {
    const seeded: GameState = { ...base, rng: createRandom(`${options.seed ?? "bot"}:${i}`).serialize() };
    const run = runBattle(startBattle(seeded, troop, { canEscape: options.canEscape ?? false, canLose: true }, ctx), ctx, policy);
    maxTurns = Math.max(maxTurns, run.turns);
    if (run.outcome === "defeat") defeats++;
    if (run.outcome !== "victory") continue;
    wins++;
    turns.push(run.turns);
    const mhp = run.party.reduce((n, b) => n + b.params.mhp, 0);
    hpLeft.push(run.party.reduce((n, b) => n + Math.max(0, b.hp), 0) / Math.max(1, mhp));
  }
  const avg = (xs: readonly number[]): number | null => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);
  return {
    troop: options.troop,
    runs: options.runs,
    wins,
    defeats,
    winRate: options.runs === 0 ? 0 : wins / options.runs,
    avgTurns: avg(turns),
    maxTurns,
    avgHpLeft: avg(hpLeft),
    minHpLeft: hpLeft.length === 0 ? null : Math.min(...hpLeft),
  };
}

export interface LevelRow {
  level: number;
  report: BattleReport;
}

/** パーティのレベルを `levels` のそれぞれにして `simulateBattles` する（「何レベルなら勝てるか」を見る）。 */
export function levelSweep(state: GameState, ctx: Ctx, levels: readonly number[], options: SimulationOptions): LevelRow[] {
  return levels.map((level) => ({ level, report: simulateBattles(state, ctx, { ...options, party: { ...options.party, level } }) }));
}

/** 勝率が `minWinRate` 以上になる最初のレベル（無ければ `undefined`）。 */
export const lowestLevel = (rows: readonly LevelRow[], minWinRate: number): number | undefined => rows.find((r) => r.report.winRate >= minWinRate)?.level;

const percent = (x: number | null): string => (x === null ? "-" : `${Math.round(x * 100)}%`);

/** `levelSweep` の結果を、端末に出す表にする。 */
export function formatLevelTable(rows: readonly LevelRow[]): string {
  const header = ["Lv", "勝率", "平均ターン", "最長ターン", "残りHP(平均)", "残りHP(最小)"];
  const body = rows.map(({ level, report: r }) => [
    String(level),
    percent(r.winRate),
    r.avgTurns === null ? "-" : r.avgTurns.toFixed(1),
    String(r.maxTurns),
    percent(r.avgHpLeft),
    percent(r.minHpLeft),
  ]);
  return [header, ...body].map((cols) => cols.join("\t")).join("\n");
}
