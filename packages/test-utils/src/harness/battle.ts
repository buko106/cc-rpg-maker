import { createCtx, createProjectView, emptyInput, initialState, inputFrame, startBattle, step } from "@rpg/core";
import type { Button, Ctx, Effect, GameState, InputFrame } from "@rpg/core";
import { ProjectSchema } from "@rpg/schema";
import type { Project } from "@rpg/schema";
import { loadFixtureProject } from "./project.js";

const params = (mhp: number, mmp: number, atk: number, def: number, mat: number, mdf: number, agi: number, luk: number) => ({
  mhp, mmp, atk, def, mat, mdf, agi, luk,
});
const flat = (p: ReturnType<typeof params>) => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, { base: v, growth: 0 }]));

/**
 * 戦闘のテスト用データ（`minimal` に足す）。数値は手計算しやすいように固定してある。
 * - 勇者（atk 30, def 10, agi 10, luk 10）と魔法使い（mat 30, mdf 10, agi 8, mmp 20。fire / heal を習得）。
 * - スライム（HP 30・弱い）、ゴーレム（HP 300・堅い）、毒蜘蛛（毒を付与）、眠りの敵（眠りを付与）。
 * - トループ：`tr_slime` `tr_slimes`（スライム 2 匹）`tr_golem` `tr_spider` `tr_sleeper` `tr_mixed`。
 * - アイテム：`potion`（HP 50 回復）`elixir`（一人蘇生）。状態：`st_poison`（毎ターン最大 HP の 10% ダメージ、3 ターン）`st_sleep`（行動不能、2 ターン）。
 */
export function battleProject(mutate?: (p: Project) => void): Project {
  const base = structuredClone(loadFixtureProject("minimal").project) as Project & { database: Record<string, unknown> };
  const db = base.database as unknown as Project["database"];
  const mkSkill = (id: string, name: string, mpCost: number, scope: string, formula: string, effects: unknown[] = []) => [id, { id, name, mpCost, scope, formula, effects }] as const;
  const mkEnemy = (id: string, name: string, p: ReturnType<typeof params>, actions: unknown[], exp: number, gold: number, drops: unknown[] = []) =>
    [id, { id, name, params: p, actions, drops, exp, gold }] as const;

  Object.assign(db.actors, {
    actor_hero: { id: "actor_hero", name: "勇者", classId: "class_hero", initialLevel: 1, equips: {} },
    actor_mage: { id: "actor_mage", name: "魔法使い", classId: "class_mage", initialLevel: 1, equips: {} },
  });
  Object.assign(db.classes, {
    class_hero: { id: "class_hero", name: "戦士", skills: [{ level: 1, skill: "sk_power" }], params: flat(params(100, 20, 30, 10, 10, 10, 10, 10)) },
    class_mage: {
      id: "class_mage",
      name: "魔法使い",
      skills: [{ level: 1, skill: "sk_fire" }, { level: 1, skill: "sk_heal" }, { level: 5, skill: "sk_meteor" }],
      params: flat(params(60, 20, 10, 10, 30, 10, 8, 10)),
    },
  });
  Object.assign(
    db.skills,
    Object.fromEntries([
      mkSkill("sk_power", "強撃", 0, "one-enemy", "a.atk * 6 - b.def * 2"),
      mkSkill("sk_fire", "ファイア", 3, "one-enemy", "a.mat * 4 - b.mdf * 2"),
      mkSkill("sk_meteor", "メテオ", 5, "all-enemies", "a.mat * 3"),
      mkSkill("sk_heal", "ヒール", 2, "one-ally", "0 - a.mat * 2"),
      mkSkill("sk_bite", "かみつき", 0, "one-enemy", "a.atk * 2 - b.def"),
      mkSkill("sk_poison", "毒のきば", 0, "one-enemy", "", [{ kind: "addState", state: "st_poison", chance: 1 }]),
      mkSkill("sk_lullaby", "子守唄", 0, "all-enemies", "", [{ kind: "addState", state: "st_sleep", chance: 1 }]),
      mkSkill("sk_focus", "集中", 0, "self", "", [{ kind: "buff", param: "atk", level: 1 }]),
      mkSkill("sk_cleanse", "浄化", 1, "one-ally", "", [{ kind: "removeState", state: "st_poison" }]),
      mkSkill("sk_revive", "蘇生", 4, "one-dead-ally", "", [{ kind: "recoverHp", value: 20 }]),
      mkSkill("sk_nothing", "ためる", 0, "none", ""),
    ]),
  );
  Object.assign(db.items, {
    potion: { id: "potion", name: "ポーション", kind: "consumable", price: 10, effects: [{ kind: "recoverHp", value: 50 }] },
    elixir: { id: "elixir", name: "エリクサー", kind: "consumable", price: 100, effects: [{ kind: "recoverHp", value: 30 }] },
    sword: { id: "sword", name: "鉄の剣", kind: "weapon", price: 50, effects: [], params: { atk: 10 } },
  });
  Object.assign(db.states, {
    st_poison: { id: "st_poison", name: "毒", restriction: "none", turns: 3, paramRates: {}, hpRegen: -0.1 },
    st_sleep: { id: "st_sleep", name: "眠り", restriction: "cannotAct", turns: 2, paramRates: {}, hpRegen: 0 },
    st_weak: { id: "st_weak", name: "衰弱", restriction: "none", turns: 0, paramRates: { atk: 0.5 }, hpRegen: 0 },
  });
  Object.assign(
    db.enemies,
    Object.fromEntries([
      mkEnemy("slime", "スライム", params(30, 0, 12, 4, 0, 0, 6, 4), [{ skill: "sk_bite", rating: 5 }], 12, 8, [{ item: "potion", rate: 1 }]),
      mkEnemy("golem", "ゴーレム", params(300, 0, 20, 20, 0, 0, 5, 5), [{ skill: "sk_bite", rating: 5 }], 100, 50),
      mkEnemy("spider", "毒蜘蛛", params(60, 0, 10, 5, 0, 0, 20, 5), [{ skill: "sk_poison", rating: 5 }], 20, 10),
      mkEnemy("sleeper", "眠り猫", params(40, 0, 8, 5, 0, 0, 30, 5), [{ skill: "sk_lullaby", rating: 5 }], 15, 5),
      mkEnemy("brute", "大鬼", params(200, 0, 200, 0, 0, 0, 40, 0), [{ skill: "sk_bite", rating: 5 }], 50, 30),
    ]),
  );
  const members = (...enemies: string[]) => enemies.map((enemy, i) => ({ enemy, x: 60 + i * 80, y: 100 }));
  const troop = (id: string, name: string, ...enemies: string[]) => [id, { id, name, members: members(...enemies), pages: [] }] as const;
  Object.assign(
    db.troops,
    Object.fromEntries([
      troop("tr_slime", "スライム", "slime"),
      troop("tr_slimes", "スライム×2", "slime", "slime"),
      troop("tr_golem", "ゴーレム", "golem"),
      troop("tr_spider", "毒蜘蛛", "spider"),
      troop("tr_sleeper", "眠り猫", "sleeper"),
      troop("tr_brute", "大鬼", "brute"),
      troop("tr_mixed", "混成", "slime", "spider"),
    ]),
  );
  mutate?.(base);
  const parsed = ProjectSchema.safeParse(base);
  if (!parsed.success) throw new Error(`battleProject: 不正なプロジェクト: ${JSON.stringify(parsed.error.issues[0])}`);
  return parsed.data;
}

export interface BattleKit {
  project: Project;
  ctx: Ctx;
  /** マップ上・勇者と魔法使いの 2 人パーティ・ポーション 2 個の状態。 */
  state: GameState;
}

/** `battleProject` から Ctx と初期状態を作る。 */
export function battleKit(opts: { mutate?: (p: Project) => void; seed?: string; party?: readonly string[] } = {}): BattleKit {
  const project = battleProject(opts.mutate);
  const { maps } = loadFixtureProject("minimal");
  const ctx = createCtx(createProjectView(project, maps));
  const base = initialState(ctx, opts.seed ?? "battle-seed");
  const members = (opts.party ?? ["actor_hero", "actor_mage"]) as GameState["party"]["members"];
  const actors = { ...base.actors };
  return { project, ctx, state: { ...base, actors, party: { ...base.party, members, items: { potion: 2 } as GameState["party"]["items"] } } };
}

/** 戦闘を始める（`startBattle`）。入力フェーズに入るまで 1 フレーム進める。 */
export function beginBattle(kit: BattleKit, troop: string, opts: { canEscape?: boolean; canLose?: boolean } = {}, from: GameState = kit.state): GameState {
  const started = startBattle(from, troop as never, { canEscape: opts.canEscape ?? true, canLose: opts.canLose ?? false }, kit.ctx);
  return step(started, emptyInput(), kit.ctx).state;
}

export const press = (...buttons: Button[]): InputFrame => inputFrame(buttons, buttons);

export interface DriveResult {
  state: GameState;
  effects: Effect[];
}

/** 入力を 1 フレームずつ `step` する（`core.step` と同じ経路）。 */
export function drive(state: GameState, ctx: Ctx, inputs: readonly InputFrame[]): DriveResult {
  let s = state;
  const effects: Effect[] = [];
  for (const input of inputs) {
    const r = step(s, input, ctx);
    s = r.state;
    effects.push(...r.effects);
  }
  return { state: s, effects };
}

/** `n` フレーム何もせず進める。 */
export const idleFrames = (n: number): InputFrame[] => Array.from({ length: n }, () => emptyInput());

/** `done` が真になるまで（最大 `max` フレーム）、空入力で進める。真になった時点の状態を返す。 */
export function driveUntil(state: GameState, ctx: Ctx, done: (s: GameState) => boolean, max = 1200): GameState {
  let s = state;
  for (let i = 0; i < max && !done(s); i++) s = step(s, emptyInput(), ctx).state;
  return s;
}
