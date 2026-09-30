import type { GameState } from "../index.js";
import { battleKit, beginBattle, drive, driveUntil, idleFrames, press } from "@rpg/test-utils";
import { describe, expect, it } from "vitest";
import { battleCommands, battleOutcome, END_WAIT, leaveBattle } from "./flow.js";
import { isAlive } from "./battlers.js";

const kit = battleKit();
const { ctx } = kit;

const battle = (s: GameState) => s.battle!;

/** コマンド入力の定番：「攻撃 → 最初の敵」を勇者と魔法使いで。 */
const attackAll = [press("ok"), press("ok"), press("ok"), press("ok")];

describe("battle flow", () => {
  it("starts on the battle scene, logs the encounter and asks the first member for a command", () => {
    const s = beginBattle(kit, "tr_slime");
    expect(s.scene.kind).toBe("battle");
    expect(battle(s).phase).toBe("input");
    expect(battle(s).turn).toBe(1);
    expect(battle(s).log.map((e) => e.kind)).toEqual(["appear", "turn"]);
    expect(battle(s).inputCursor).toEqual({ actorIndex: 0, menu: "command", index: 0, pick: null });
    expect(battle(s).party).toEqual(["actor_hero", "actor_mage"]);
    expect(Object.keys(battle(s).enemies)).toEqual(["e:0"]);
  });

  it("names duplicate enemies A, B… and leaves unique ones alone", () => {
    expect(Object.values(battle(beginBattle(kit, "tr_slimes")).enemies).map((e) => e.name)).toEqual(["スライムA", "スライムB"]);
    expect(Object.values(battle(beginBattle(kit, "tr_mixed")).enemies).map((e) => e.name)).toEqual(["スライム", "毒蜘蛛"]);
  });

  it("does nothing for an unknown troop", () => {
    expect(beginBattle(kit, "no_such_troop").scene.kind).toBe("map");
  });

  it("lists escape as a command only when the battle allows it", () => {
    expect(battleCommands(true)).toEqual(["attack", "skill", "item", "guard", "escape"]);
    expect(battleCommands(false)).toEqual(["attack", "skill", "item", "guard"]);
  });

  it("moves the command cursor with up/down (wrapping) and back with cancel", () => {
    let s = beginBattle(kit, "tr_slime");
    s = drive(s, ctx, [press("down")]).state;
    expect(battle(s).inputCursor.index).toBe(1);
    s = drive(s, ctx, [press("up"), press("up")]).state;
    expect(battle(s).inputCursor.index).toBe(4);
    s = drive(s, ctx, [press("down")]).state;
    expect(battle(s).inputCursor.index).toBe(0);
  });

  it("hides escape from the cursor range when the party cannot escape", () => {
    let s = beginBattle(kit, "tr_slime", { canEscape: false });
    s = drive(s, ctx, [press("up")]).state;
    expect(battle(s).inputCursor.index).toBe(3);
  });

  it("collects one action per member, then resolves in speed order and kills a slime", () => {
    let s = beginBattle(kit, "tr_slime");
    s = drive(s, ctx, attackAll.slice(0, 2)).state; // 勇者：攻撃 → e:0
    expect(battle(s).actions).toHaveLength(1);
    expect(battle(s).inputCursor.actorIndex).toBe(1);
    s = drive(s, ctx, attackAll.slice(2)).state; // 魔法使い：攻撃 → e:0
    expect(battle(s).phase).toBe("resolve");
    expect(battle(s).queue.map((a) => a.subject).sort()).toEqual(["actor_hero", "actor_mage", "e:0"]);
    // 勇者の攻撃（30*4-4*2 ≈ 112）で 30 HP のスライムは倒れ、勝利
    s = driveUntil(s, ctx, (x) => x.battle!.phase !== "resolve");
    expect(battle(s).phase).toBe("victory");
    expect(battleOutcome(battle(s))).toBe("victory");
  });

  it("gives rewards on victory and returns to the map with the result routed to the waiting interpreter", () => {
    let s = beginBattle(kit, "tr_slime");
    s = { ...s, interpreters: [{ id: "i0", origin: { kind: "plugin", name: "t" }, mode: "normal", commands: [], pc: 0, wait: { kind: "battle" }, branch: {}, callStack: [], locals: {} }] };
    s = driveUntil(drive(s, ctx, attackAll).state, ctx, (x) => x.battle!.phase !== "resolve");
    expect(battle(s).phase).toBe("victory");
    expect(battle(s).result).toMatchObject({ outcome: "victory", exp: 12, gold: 8, drops: ["potion"] });
    expect(s.party.gold).toBe(8);
    expect(s.party.items).toEqual({ potion: 3 });
    expect(s.actors["actor_hero" as never]!.exp).toBe(12);
    // 結果表示の最低時間の間は決定を受け付けない
    const early = drive(s, ctx, [press("ok")]).state;
    expect(early.scene.kind).toBe("battle");
    s = driveUntil(s, ctx, (x) => x.battle!.wait <= 0);
    const left = leaveBattle(s, ctx).state;
    expect(left.scene.kind).toBe("map");
    expect(left.battle).toBeUndefined();
    expect(left.interpreters[0]!.locals).toEqual({ battleResult: "victory" });
  });

  it("levels up alive members when enough exp is gained", () => {
    let s = beginBattle(kit, "tr_golem");
    // 経験値 100：20*(L-1)^2 + 10*(L-1) → Lv3 (100) に届く
    s = { ...s, battle: { ...battle(s), enemies: { "e:0": { ...battle(s).enemies["e:0"]!, hp: 1 } } } };
    s = driveUntil(drive(s, ctx, attackAll).state, ctx, (x) => x.battle!.phase !== "resolve");
    expect(battle(s).phase).toBe("victory");
    expect(s.actors["actor_hero" as never]!.level).toBe(3);
    expect(battle(s).log.filter((e) => e.kind === "levelUp").length).toBe(4);
  });

  it("escape succeeds by chance and ends the battle without rewards", () => {
    // 逃走成功率 = 0.5 * 味方平均敏捷 / 敵平均敏捷。スライム(6) に対し 勇者 10・魔法使い 8 → 0.75。成功するまで試す
    let found = false;
    for (let n = 0; n < 40 && !found; n++) {
      const k = battleKit({ seed: `escape-${n}` });
      let s = beginBattle(k, "tr_slime");
      s = drive(s, k.ctx, [press("up"), press("ok"), press("up"), press("ok"), ...idleFrames(120)]).state;
      if (s.battle!.phase === "escape") {
        found = true;
        expect(s.battle!.result).toMatchObject({ outcome: "escape", exp: 0, gold: 0 });
        expect(s.party.gold).toBe(0);
        expect(s.battle!.queue).toEqual([]);
        s = drive(s, k.ctx, [...idleFrames(END_WAIT), press("ok")]).state;
        expect(s.scene.kind).toBe("map");
      }
    }
    expect(found).toBe(true);
  });

  it("cannot escape when the battle forbids it (the command is absent) and guard halves damage", () => {
    const k = battleKit();
    let s = beginBattle(k, "tr_brute", { canEscape: false, canLose: true });
    // 両方「防御」(index 3)
    s = drive(s, k.ctx, [press("down"), press("down"), press("down"), press("ok"), press("down"), press("down"), press("down"), press("ok")]).state;
    expect(battle(s).phase).toBe("resolve");
    s = drive(s, k.ctx, idleFrames(200)).state;
    const dmg = battle(s).log.filter((e) => e.kind === "damage");
    expect(dmg.length).toBeGreaterThan(0);
    // 大鬼の攻撃 200*2-10 = 390 → 防御で半分（±10% の揺らぎ込みで 175〜215）。防御していなければ 351〜429
    const amount = (dmg[0] as { amount: number }).amount;
    expect(amount).toBeGreaterThanOrEqual(175);
    expect(amount).toBeLessThanOrEqual(215);
  });

  it("goes to game over on defeat when the battle cannot be lost, and back to the title on confirm", () => {
    let s = beginBattle(kit, "tr_brute", { canLose: false });
    s = drive(s, ctx, [press("down"), press("down"), press("down"), press("ok"), press("down"), press("down"), press("down"), press("ok")]).state;
    // 防御では耐えきれない：大鬼は 1 ターンに 1 人ずつ倒すので何ターンか回す
    for (let i = 0; i < 6 && s.battle?.phase !== "defeat"; i++) {
      s = drive(s, ctx, idleFrames(200)).state;
      if (s.battle?.phase === "input") s = drive(s, ctx, [press("down"), press("down"), press("down"), press("ok"), press("down"), press("down"), press("down"), press("ok")]).state;
    }
    expect(battle(s).phase).toBe("defeat");
    expect(battleOutcome(battle(s))).toBe("defeat");
    s = drive(s, ctx, [...idleFrames(END_WAIT), press("ok")]).state;
    expect(s.scene.kind).toBe("gameover");
    expect(s.battle).toBeUndefined();
    const title = drive(s, ctx, [press("ok")]).state;
    expect(title.scene.kind).toBe("title");
  });

  it("returns to the map on defeat when the battle can be lost, reviving fallen members with 1 HP", () => {
    let s = beginBattle(kit, "tr_brute", { canLose: true });
    for (let i = 0; i < 8 && s.battle?.phase !== "defeat"; i++) {
      if (s.battle?.phase === "input") s = drive(s, ctx, [press("down"), press("down"), press("down"), press("ok"), press("down"), press("down"), press("down"), press("ok")]).state;
      s = drive(s, ctx, idleFrames(200)).state;
    }
    expect(battle(s).phase).toBe("defeat");
    s = drive(s, ctx, [...idleFrames(END_WAIT), press("ok")]).state;
    expect(s.scene.kind).toBe("map");
    expect(Object.values(s.actors).every((a) => a.hp >= 1)).toBe(true);
  });

  it("a confirm during resolution skips the pause between actions", () => {
    let s = beginBattle(kit, "tr_golem");
    s = driveUntil(drive(s, ctx, attackAll).state, ctx, (x) => x.battle!.wait === 0 && x.battle!.queue.length < 3);
    s = drive(s, ctx, idleFrames(2)).state;
    const remaining = battle(s).queue.length;
    expect(battle(s).wait).toBeGreaterThan(0);
    // 待っている間は次の行動が始まらないが、決定を押すと飛ばして次が始まる
    expect(battle(drive(s, ctx, idleFrames(2)).state).queue).toHaveLength(remaining);
    expect(battle(drive(s, ctx, [press("ok")]).state).queue).toHaveLength(remaining - 1);
  });

  it("keeps the map's random stream untouched while a battle is fought (independent battle RNG)", () => {
    const before = kit.state.rng;
    let s = beginBattle(kit, "tr_golem");
    s = drive(s, ctx, [...attackAll, ...idleFrames(300)]).state;
    expect(s.rng).toEqual(before);
    expect(battle(s).rng).not.toEqual(battle(beginBattle(kit, "tr_golem")).rng);
  });

  it("uses different random streams for battles started at different ticks", () => {
    const a = beginBattle(kit, "tr_slime");
    const b = beginBattle(kit, "tr_slime", {}, { ...kit.state, tick: 500 });
    expect(a.battle!.rng).not.toEqual(b.battle!.rng);
  });

  it("stops the world: map interpreters and movement do not advance during a battle", () => {
    let s = beginBattle(kit, "tr_golem");
    const player = s.map.player;
    s = drive(s, ctx, idleFrames(30)).state;
    expect(s.map.player).toEqual(player);
    expect(s.playtimeTicks).toBeGreaterThan(kit.state.playtimeTicks);
  });

  it("ticks down states at the end of the turn and removes them", () => {
    let s = beginBattle(kit, "tr_golem");
    s = { ...s, battle: { ...battle(s), allies: { ...battle(s).allies, actor_hero: { ...battle(s).allies["actor_hero"]!, states: [{ id: "st_poison" as never, turns: 2 }] } } } };
    s = drive(s, ctx, [...attackAll, ...idleFrames(400)]).state;
    // 1 ターン目の終わりで毒ダメージ 10（最大 HP 100 の 10%）、残り 1 ターン
    const heroLogs = battle(s).log.filter((e) => e.kind === "damage" && e.target === "actor_hero");
    expect(heroLogs.some((e) => (e as { amount: number }).amount === 10)).toBe(true);
    expect(battle(s).allies["actor_hero"]!.states).toEqual([{ id: "st_poison", turns: 1 }]);
    expect(isAlive(battle(s).allies["actor_hero"]!)).toBe(true);
  });
});
