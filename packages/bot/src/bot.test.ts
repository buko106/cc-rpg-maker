import { battleKit, beginBattle, cmd } from "@rpg/test-utils";
import type { BattleState, GameState } from "@rpg/core";
import { actorParamsOf, expToReach, startBattle } from "@rpg/core";
import type { ActorId, Skill } from "@rpg/schema";
import { describe, expect, it } from "vitest";
import { attackPolicy, battleBotInput, formatLevelTable, guardPolicy, healsHp, levelSweep, lowestLevel, POLICIES, prepareParty, runBattle, simulateBattles, smartPolicy } from "./index.js";
import type { BattleTurn } from "./index.js";

const kit = battleKit({
  mutate: (p) => {
    p.database.troops["tr_talk" as never] = {
      id: "tr_talk",
      name: "おしゃべり",
      members: [{ enemy: "slime", x: 60, y: 100 }],
      pages: [{ condition: { kind: "turn", turn: 1 }, commands: [cmd("ShowText", { text: "かかってこい！" })] }],
    } as never;
  },
});
const { ctx } = kit;
const HERO = "actor_hero" as ActorId;
const MAGE = "actor_mage" as ActorId;

/** 戦闘中の魔法使いの番として、作戦に渡す情報を作る。 */
function mageTurn(patch: (b: BattleState) => BattleState, troop = "tr_slimes", level = 1): BattleTurn {
  const s = beginBattle(kit, troop, {}, prepareParty(kit.state, ctx, { level }));
  const battle = patch(s.battle!);
  const actor = battle.allies[MAGE]!;
  const skills = ["sk_fire", "sk_heal", ...(level >= 5 ? ["sk_meteor"] : [])].map((id) => ctx.project.skill(id as never)!);
  return { state: { ...s, battle }, battle, actor, skills, items: [ctx.project.item("potion" as never)!], ctx };
}
const hurt = (b: BattleState, id: string, hp: number): BattleState => ({ ...b, allies: { ...b.allies, [id]: { ...b.allies[id]!, hp } } });

describe("runBattle", () => {
  it("作戦どおりにメニューを操作して戦い、結果・ターン数・残りの味方を返す", () => {
    const run = runBattle(beginBattle(kit, "tr_slime"), ctx, attackPolicy);
    expect(run.outcome).toBe("victory");
    expect(run.turns).toBeGreaterThanOrEqual(1);
    expect(run.state.scene.kind).toBe("map");
    expect(run.party.map((b) => b.id)).toEqual([HERO, MAGE]);
  });

  it("防御だけでは負ける（負けてもよい戦闘ならマップに戻る）", () => {
    const run = runBattle(beginBattle(kit, "tr_brute", { canLose: true }), ctx, guardPolicy);
    expect(run.outcome).toBe("defeat");
    expect(run.state.scene.kind).toBe("map");
  });

  it("バトルイベントのメッセージは決定で送る。戦闘の前から出ていたメッセージには触らない", () => {
    const talk = beginBattle(kit, "tr_talk");
    expect(talk.message.open).toBe(true);
    expect(battleBotInput(talk, ctx, attackPolicy).triggered.has("ok")).toBe(true);
    expect(runBattle(talk, ctx, attackPolicy).outcome).toBe("victory");
    const stale: GameState = { ...beginBattle(kit, "tr_slime"), message: { ...kit.state.message, open: true, owner: "i999", text: "前のメッセージ" } };
    const input = battleBotInput(stale, ctx, guardPolicy);
    expect(input.triggered.has("down")).toBe(true); // 防御へカーソルを動かす（決定でメッセージを送らない）
  });

  it("終わらなければ例外", () => {
    expect(() => runBattle(beginBattle(kit, "tr_golem"), ctx, guardPolicy, 5)).toThrow(/終わらない/);
  });
});

describe("作戦", () => {
  it("回復のスキルを見分ける（HP 回復の効果、または味方向けで負の式）", () => {
    const skill = (patch: Partial<Skill>) => ({ scope: "one-ally", formula: "", effects: [], ...patch }) as Pick<Skill, "scope" | "formula" | "effects">;
    expect(healsHp(skill({ formula: "0 - a.mat * 2" }))).toBe(true);
    expect(healsHp(skill({ formula: "-50" }))).toBe(true);
    expect(healsHp(skill({ scope: "one-enemy", formula: "-50" }))).toBe(false);
    expect(healsHp(skill({ scope: "one-dead-ally", effects: [{ kind: "recoverHp", value: 10 }] }))).toBe(true);
    expect(healsHp(skill({ formula: "a.atk" }))).toBe(false);
  });

  it("smart：弱った味方を回復のスキルで治す。スキルが使えなければ回復アイテム", () => {
    const turn = mageTurn((b) => hurt(b, HERO, 20));
    expect(smartPolicy()(turn)).toEqual({ kind: "skill", skill: "sk_heal", target: HERO });
    const noMp = { ...turn, actor: { ...turn.actor, mp: 0 } };
    expect(smartPolicy()(noMp)).toEqual({ kind: "item", item: "potion", target: HERO });
    expect(smartPolicy({ useItems: false })(noMp)).toMatchObject({ kind: "attack" });
    expect(smartPolicy({ healBelow: 0.1 })(turn)).toMatchObject({ kind: "skill", skill: "sk_fire" });
  });

  it("smart：攻撃のスキルは消費 MP の大きいもの。敵が 2 体以上なら全体攻撃。回復に要る MP は残す", () => {
    expect(smartPolicy()(mageTurn((b) => b, "tr_slime", 5))).toMatchObject({ kind: "skill", skill: "sk_meteor" });
    expect(smartPolicy()(mageTurn((b) => b, "tr_slimes", 5))).toEqual({ kind: "skill", skill: "sk_meteor" });
    const low = mageTurn((b) => b, "tr_slime", 1);
    expect(smartPolicy()({ ...low, actor: { ...low.actor, mp: 4 } })).toMatchObject({ kind: "attack" });
    expect(smartPolicy()({ ...low, actor: { ...low.actor, mp: 5 } })).toMatchObject({ kind: "skill", skill: "sk_fire", target: "e:0" });
  });

  it("smart：倒れた味方がいて、蘇生のスキルがあれば蘇生する", () => {
    const turn = mageTurn((b) => hurt(b, HERO, 0));
    const revive = ctx.project.skill("sk_revive" as never)!;
    expect(smartPolicy()({ ...turn, skills: [...turn.skills, revive] })).toEqual({ kind: "skill", skill: "sk_revive", target: HERO });
  });

  it("名前で選べる作戦がある", () => {
    expect(Object.keys(POLICIES)).toEqual(["smart", "attack", "guard"]);
  });
});

describe("試行とまとめ", () => {
  it("パーティを整える：レベルと経験値、全快、持ち物", () => {
    const s = prepareParty({ ...kit.state, actors: { ...kit.state.actors, [HERO]: { ...kit.state.actors[HERO as never]!, hp: 1 } } }, ctx, { level: 5, items: { potion: 3, elixir: 0 } });
    expect(s.actors[HERO as never]).toMatchObject({ level: 5, exp: expToReach(5), hp: actorParamsOf(s, ctx, HERO as never).mhp });
    expect(s.party.items).toEqual({ potion: 3 });
    const keep = prepareParty({ ...kit.state, actors: { ...kit.state.actors, [HERO]: { ...kit.state.actors[HERO as never]!, hp: 1 } } }, ctx, { fullRecover: false });
    expect(keep.actors[HERO as never]!.hp).toBe(1);
    expect(prepareParty(kit.state, ctx, { level: 500 }).actors[HERO as never]!.level).toBe(99);
  });

  it("パーティを整える：装備（欄はアイテムから。持ち物は減らさない）。付けられないものは例外", () => {
    const s = prepareParty(kit.state, ctx, { equips: { [HERO]: ["sword"] } });
    expect(s.actors[HERO as never]!.equips).toEqual({ weapon: "sword" });
    expect(actorParamsOf(s, ctx, HERO as never).atk).toBe(40);
    expect(s.actors[HERO as never]!.hp).toBe(100);
    expect(s.party.items).toEqual(kit.state.party.items);
    expect(() => prepareParty(kit.state, ctx, { equips: { [HERO]: ["potion"] } })).toThrow(/装備できない/);
    expect(() => prepareParty(kit.state, ctx, { equips: { nobody: ["sword"] } })).toThrow(/nobody/);
  });

  it("同じ種なら同じまとめになる。勝率・ターン数・HP の残りを数える", () => {
    const a = simulateBattles(kit.state, ctx, { troop: "tr_slimes", runs: 6, seed: "s" });
    expect(simulateBattles(kit.state, ctx, { troop: "tr_slimes", runs: 6, seed: "s" })).toEqual(a);
    expect(a).toMatchObject({ troop: "tr_slimes", runs: 6, wins: 6, defeats: 0, winRate: 1 });
    expect(a.avgTurns).toBeGreaterThan(0);
    expect(a.avgHpLeft).toBeGreaterThan(0);
    expect(a.avgHpLeft).toBeLessThanOrEqual(1);
    const lose = simulateBattles(kit.state, ctx, { troop: "tr_brute", runs: 3, policy: guardPolicy });
    expect(lose).toMatchObject({ wins: 0, defeats: 3, winRate: 0, avgTurns: null, avgHpLeft: null, minHpLeft: null });
    expect(simulateBattles(kit.state, ctx, { troop: "tr_slime", runs: 0 }).winRate).toBe(0);
    expect(() => simulateBattles(kit.state, ctx, { troop: "tr_none", runs: 1 })).toThrow(/tr_none/);
  });

  it("レベルを変えて試し、勝てる最初のレベルを見つけ、表にする", () => {
    const rows = levelSweep(kit.state, ctx, [1, 30], { troop: "tr_golem", runs: 3, policy: attackPolicy });
    expect(rows.map((r) => r.level)).toEqual([1, 30]);
    expect(rows[1]!.report.winRate).toBe(1);
    expect(lowestLevel(rows, 1)).toBe(rows[0]!.report.winRate === 1 ? 1 : 30);
    expect(lowestLevel(rows, 2)).toBeUndefined();
    const table = formatLevelTable(rows).split("\n");
    expect(table[0]).toBe("Lv\t勝率\t平均ターン\t最長ターン\t残りHP(平均)\t残りHP(最小)");
    expect(table[2]).toMatch(/^30\t100%\t/);
  });

  it("逃走を選べる戦闘でも、作戦は逃げない", () => {
    const started = startBattle(kit.state, "tr_slime" as never, { canEscape: true, canLose: true }, ctx);
    expect(runBattle(started, ctx, smartPolicy()).outcome).toBe("victory");
    expect(simulateBattles(kit.state, ctx, { troop: "tr_slime", runs: 1, canEscape: true }).wins).toBe(1);
  });
});
