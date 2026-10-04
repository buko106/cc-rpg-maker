import { battleKit, beginBattle, cmd, drive, driveUntil, idleFrames, press } from "@rpg/test-utils";
import type { EventCommand, Troop } from "@rpg/schema";
import { describe, expect, it } from "vitest";
import type { GameState } from "../index.js";
import { emptyInput, enemyBattlers, startInterpreter, step, stripTransient, troopConditionMet } from "../index.js";

type Page = Troop["pages"][number];
const page = (condition: Page["condition"], ...commands: EventCommand[]): Page => ({ condition, commands });

/** `tr_ev` に `members` と `pages` を持たせた戦闘のキット。 */
function kitWith(members: Troop["members"], ...pages: Page[]) {
  return battleKit({
    mutate: (p) => {
      p.database.troops["tr_ev" as never] = { id: "tr_ev", name: "イベント", members, pages } as never;
    },
  });
}
const at = (enemy: string, i: number, hidden?: boolean): Troop["members"][number] => ({ enemy: enemy as never, x: 60 + i * 80, y: 100, ...(hidden ? { hidden } : {}) });
const battle = (s: GameState) => s.battle!;
const troopEvents = (s: GameState) => s.interpreters.filter((i) => i.origin.kind === "troop");

describe("敵グループのバトルイベント", () => {
  it("最初のターンのページは、コマンドを選ぶ前に動く。メッセージの間は戦闘が進まず、決定はメッセージを送る", () => {
    const kit = kitWith([at("slime", 0)], page({ kind: "turn", turn: 1 }, cmd("ShowText", { text: "ぷるぷる……" })));
    let s = beginBattle(kit, "tr_ev");
    expect(battle(s).phase).toBe("input");
    expect(s.message).toMatchObject({ open: true, text: "ぷるぷる……" });
    expect(troopEvents(s)).toHaveLength(1);
    // 決定はメッセージを閉じるだけ（コマンドは選ばれない）
    s = drive(s, kit.ctx, [press("ok"), ...idleFrames(1)]).state;
    expect(s.message.open).toBe(false);
    expect(troopEvents(s)).toHaveLength(0);
    expect(battle(s).actions).toEqual([]);
    expect(battle(s).eventPagesRun).toEqual([0]);
    // そのあとは、ふつうにコマンドを選べる
    s = drive(s, kit.ctx, [press("ok")]).state;
    expect(battle(s).inputCursor.menu).toBe("target");
  });

  it("どのページも 1 回の戦闘で 1 回だけ。常にのページは戦闘の始めに動く。ターンの 0 は最初のターンと同じ", () => {
    const kit = kitWith(
      [at("golem", 0)],
      page({ kind: "always" }, cmd("ControlVariables", { ids: ["var_a"], op: "add", operand: { kind: "constant", value: 1 } })),
      page({ kind: "turn", turn: 0 }, cmd("ControlVariables", { ids: ["var_b"], op: "add", operand: { kind: "constant", value: 1 } })),
    );
    let s = beginBattle(kit, "tr_ev");
    s = driveUntil(s, kit.ctx, (x) => troopEvents(x).length === 0);
    // 2 ターン防御して進める
    for (let turn = 0; turn < 2; turn++) {
      s = drive(s, kit.ctx, [press("down"), press("down"), press("down"), press("ok"), press("down"), press("down"), press("down"), press("ok")]).state;
      s = driveUntil(s, kit.ctx, (x) => x.battle?.phase === "input" && x.battle.turn === turn + 2, 600);
    }
    expect(s.variables["var_a" as never]).toBe(1);
    expect(s.variables["var_b" as never]).toBe(1);
  });

  it("敵の HP の条件：その敵の HP が割合以下になった行動のあと（待ちが明けたところ）で動く。変身は HP の割合を保つ", () => {
    const kit = kitWith([at("golem", 0)], page({ kind: "enemyHp", member: 0, percent: 50 }, cmd("EnemyTransform", { member: 0, enemy: "slime" })));
    let s = beginBattle(kit, "tr_ev");
    const golem = battle(s).enemies["e:0"]!;
    // 140 / 300 のところで、戦闘の次の待ちが明けるのを待つ
    s = { ...s, battle: { ...battle(s), enemies: { ...battle(s).enemies, "e:0": { ...golem, hp: 140 } } } };
    s = step(s, emptyInput(), kit.ctx).state;
    const after = battle(s).enemies["e:0"]!;
    expect(after).toMatchObject({ enemyId: "slime", name: "スライム", hp: 14, params: { mhp: 30 } });
    expect(battle(s).eventPagesRun).toEqual([0]);
  });

  it("敵の HP の条件は、出ていない・倒れた・いない敵では満たさない", () => {
    const kit = kitWith([at("slime", 0), at("slime", 1, true)]);
    const s = beginBattle(kit, "tr_ev");
    const b = battle(s);
    const hp = (n: number, percent: number) => troopConditionMet({ kind: "enemyHp", member: n, percent }, s, b, kit.ctx);
    expect(hp(0, 100)).toBe(true);
    expect(hp(0, 50)).toBe(false);
    expect(hp(1, 100)).toBe(false);
    expect(hp(7, 100)).toBe(false);
    const dead = { ...b, enemies: { ...b.enemies, "e:0": { ...b.enemies["e:0"]!, hp: 0 } } };
    expect(troopConditionMet({ kind: "enemyHp", member: 0, percent: 100 }, s, dead, kit.ctx)).toBe(false);
  });

  it("隠れている敵は、出現するまで場にいない（狙えない・数えない・名前も出ない）。出現すると加わる", () => {
    const kit = kitWith([at("slime", 0), at("golem", 1, true)], page({ kind: "switch", id: "sw_call" as never }, cmd("EnemyAppear", { member: 1 })));
    let s = beginBattle(kit, "tr_ev");
    expect(enemyBattlers(battle(s)).map((e) => e.id)).toEqual(["e:0"]);
    expect(battle(s).enemies["e:1"]!.hidden).toBe(true);
    s = step({ ...s, switches: { ...s.switches, ["sw_call" as never]: true } }, emptyInput(), kit.ctx).state;
    expect(enemyBattlers(battle(s)).map((e) => e.id)).toEqual(["e:0", "e:1"]);
  });

  it("隠れている敵が残っていても、出ている敵を全部倒せば勝ち", () => {
    const kit = kitWith([at("slime", 0), at("golem", 1, true)]);
    let s = beginBattle(kit, "tr_ev");
    const b = battle(s);
    s = { ...s, battle: { ...b, enemies: { ...b.enemies, "e:0": { ...b.enemies["e:0"]!, hp: 1 } } } };
    s = drive(s, kit.ctx, [press("ok"), press("ok"), press("ok"), press("ok")]).state;
    s = driveUntil(s, kit.ctx, (x) => x.battle?.phase !== "resolve", 600);
    expect(battle(s).phase).toBe("victory");
  });

  it("報酬は場に出た敵の分（出てこなかった増援の分は無く、変身したら変身後の敵の分）", () => {
    const kit = kitWith([at("slime", 0), at("golem", 1, true)], page({ kind: "always" }, cmd("EnemyTransform", { member: 0, enemy: "spider" })));
    let s = beginBattle(kit, "tr_ev");
    s = driveUntil(s, kit.ctx, (x) => troopEvents(x).length === 0);
    const b = battle(s);
    s = { ...s, battle: { ...b, enemies: { ...b.enemies, "e:0": { ...b.enemies["e:0"]!, hp: 1 } } } };
    s = drive(s, kit.ctx, [press("ok"), press("ok"), press("ok"), press("ok")]).state;
    s = driveUntil(s, kit.ctx, (x) => x.battle?.phase !== "resolve", 600);
    // 毒蜘蛛（経験値 20・ゴールド 10）だけ。スライム（12・8）とゴーレム（100・50）の分は無い
    expect(battle(s).result).toMatchObject({ outcome: "victory", exp: 20, gold: 10 });
  });

  it("戦闘の中断：イベントが終わったところで戦闘から抜け、戦闘の処理は「逃げたとき」に進む", () => {
    const kit = kitWith([at("golem", 0)], page({ kind: "turn", turn: 1 }, cmd("ShowText", { text: "逃げた！" }), cmd("AbortBattle")));
    const program = [
      cmd("BattleProcessing", { troop: "tr_ev" }),
      cmd("ChoiceBranch", { index: 1 }),
      cmd("ControlSwitches", { ids: ["sw_escape"], value: true }, 1),
      cmd("EndBranch"),
    ];
    let s = startInterpreter(kit.state, { kind: "plugin", name: "t" }, program, "normal");
    s = driveUntil(s, kit.ctx, (x) => x.message.open);
    expect(s.scene.kind).toBe("battle");
    s = drive(s, kit.ctx, [press("ok"), ...idleFrames(3)]).state;
    expect(s.scene.kind).toBe("map");
    expect(s.battle).toBeUndefined();
    expect(troopEvents(s)).toHaveLength(0);
    expect(s.switches["sw_escape" as never]).toBe(true);
  });

  it("戦闘の外で使う戦闘のコマンドは、警告して何もしない", () => {
    const kit = kitWith([at("slime", 0)]);
    const s = startInterpreter(kit.state, { kind: "plugin", name: "t" }, [cmd("EnemyAppear", { member: 0 }), cmd("EnemyTransform", { member: 0, enemy: "golem" }), cmd("AbortBattle")], "normal");
    const r = step(s, emptyInput(), kit.ctx);
    expect(r.effects.filter((e) => e.kind === "log" && e.level === "warn")).toHaveLength(3);
  });

  it("セーブには、バトルイベントのインタプリタもそのメッセージも残らない", () => {
    const kit = kitWith([at("slime", 0)], page({ kind: "always" }, cmd("ShowText", { text: "やあ" })));
    const s = beginBattle(kit, "tr_ev");
    expect(s.message.open).toBe(true);
    const saved = stripTransient(s);
    expect(saved.interpreters.filter((i) => i.origin.kind === "troop")).toEqual([]);
    expect(saved.message.open).toBe(false);
  });
});
