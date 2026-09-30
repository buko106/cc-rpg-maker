import { startBattle, step } from "../index.js";
import type { GameState } from "../index.js";
import { emptyInput } from "../index.js";
import { battleKit, beginBattle, drive, idleFrames, press } from "@rpg/test-utils";
import { describe, expect, it } from "vitest";
import { targetCandidates } from "./flow.js";

const kit = battleKit();
const { ctx } = kit;
const cursor = (s: GameState) => s.battle!.inputCursor;
const feed = (s: GameState, ...b: Parameters<typeof press>) => drive(s, ctx, b.map((x) => press(x))).state;

describe("battle command input", () => {
  it("attack asks for a target: left/right cycle through living enemies, cancel goes back to the command", () => {
    let s = beginBattle(kit, "tr_slimes");
    s = feed(s, "ok");
    expect(cursor(s)).toMatchObject({ menu: "target", index: 0, pick: { kind: "attack", from: 0 } });
    s = feed(s, "right");
    expect(cursor(s).index).toBe(1);
    s = feed(s, "right");
    expect(cursor(s).index).toBe(0);
    s = feed(s, "left");
    expect(cursor(s).index).toBe(1);
    s = feed(s, "cancel");
    expect(cursor(s)).toMatchObject({ menu: "command", index: 0, pick: null });
    expect(s.battle!.actions).toEqual([]);
  });

  it("the chosen target is recorded in the action", () => {
    let s = beginBattle(kit, "tr_slimes");
    s = feed(s, "ok", "right", "ok");
    expect(s.battle!.actions).toEqual([{ subject: "actor_hero", kind: "attack", targets: ["e:1"] }]);
    expect(cursor(s)).toMatchObject({ actorIndex: 1, menu: "command" });
  });

  it("the skill menu lists learned skills, blocks skills the member cannot afford and returns on cancel", () => {
    let s = beginBattle(kit, "tr_slime");
    s = feed(s, "ok", "ok", "down", "ok"); // 勇者：攻撃 → e:0。魔法使い：スキル
    expect(cursor(s)).toMatchObject({ actorIndex: 1, menu: "skill", index: 0 });
    s = feed(s, "down");
    expect(cursor(s).index).toBe(1); // ヒール
    s = feed(s, "down");
    expect(cursor(s).index).toBe(0); // 習得は fire, heal の 2 つ（メテオは Lv5）
    s = feed(s, "cancel");
    expect(cursor(s)).toMatchObject({ menu: "command", index: 1 });
    // MP が足りなければ選べない
    const poor = { ...s, battle: { ...s.battle!, allies: { ...s.battle!.allies, actor_mage: { ...s.battle!.allies["actor_mage"]!, mp: 1 } } } };
    const still = feed(feed(poor, "ok"), "ok");
    expect(cursor(still)).toMatchObject({ menu: "skill" });
    expect(still.battle!.actions).toHaveLength(1);
  });

  it("an all-target skill needs no target; a single ally skill asks for one among the living party", () => {
    let s = beginBattle(kit, "tr_slime");
    s = feed(s, "ok", "ok"); // 勇者の攻撃
    s = feed(s, "down", "ok", "down", "ok"); // 魔法使い：スキル → ヒール
    expect(cursor(s)).toMatchObject({ menu: "target", pick: { kind: "skill", skillId: "sk_heal", from: 1 } });
    expect(targetCandidates(s.battle!, "one-ally")).toEqual(["actor_hero", "actor_mage"]);
    s = feed(s, "cancel");
    expect(cursor(s)).toMatchObject({ menu: "skill", index: 1 });
  });

  it("the item menu lists usable items; using one targets an ally and is queued", () => {
    let s = beginBattle(kit, "tr_slime");
    s = feed(s, "down", "down", "ok");
    expect(cursor(s)).toMatchObject({ menu: "item", index: 0 });
    s = feed(s, "ok", "right", "ok");
    expect(s.battle!.actions).toEqual([{ subject: "actor_hero", kind: "item", itemId: "potion", targets: ["actor_mage"] }]);
  });

  it("does not open empty skill or item menus", () => {
    const empty = { ...beginBattle(kit, "tr_slime") };
    const noItems = { ...empty, party: { ...empty.party, items: {} } };
    expect(cursor(feed(feed(noItems, "down", "down"), "ok")).menu).toBe("command");
    const k = battleKit({ mutate: (p) => { p.database.classes["class_hero" as never]!.skills = []; } });
    const s = beginBattle(k, "tr_slime");
    expect(cursor(drive(s, k.ctx, [press("down"), press("ok")]).state).menu).toBe("command");
  });

  it("cancel at the command menu returns to the previous member and discards their action", () => {
    let s = beginBattle(kit, "tr_slime");
    s = feed(s, "ok", "ok");
    expect(cursor(s).actorIndex).toBe(1);
    s = feed(s, "cancel");
    expect(cursor(s)).toMatchObject({ actorIndex: 0, menu: "command", index: 0 });
    expect(s.battle!.actions).toEqual([]);
    // 最初のメンバーでのキャンセルは何も起きない
    expect(feed(s, "cancel").battle).toEqual(s.battle);
  });

  it("skips members who cannot act (fallen or restricted) when asking for commands", () => {
    let s = beginBattle(kit, "tr_slime");
    s = { ...s, battle: { ...s.battle!, allies: { ...s.battle!.allies, actor_mage: { ...s.battle!.allies["actor_mage"]!, hp: 0 } } } };
    s = feed(s, "ok", "ok"); // 勇者の攻撃で全員済み
    expect(s.battle!.phase).toBe("resolve");
    expect(s.battle!.queue.map((a) => a.subject).sort()).toEqual(["actor_hero", "e:0"]);
  });

  it("a restricted member gets a placeholder action that logs 'cannot act' when it comes up", () => {
    let s = beginBattle(kit, "tr_golem");
    s = { ...s, battle: { ...s.battle!, allies: { ...s.battle!.allies, actor_mage: { ...s.battle!.allies["actor_mage"]!, states: [{ id: "st_sleep" as never, turns: 2 }] } } } };
    s = feed(s, "ok", "ok");
    expect(s.battle!.queue.map((a) => a.subject)).toContain("actor_mage");
    let guard = 0;
    while (s.battle!.phase === "resolve" && guard++ < 300) s = drive(s, ctx, idleFrames(1)).state;
    expect(s.battle!.log).toContainEqual({ kind: "cannotAct", subject: "actor_mage", reason: "state" });
  });

  it("with everyone unable to act the turn goes straight to resolution", () => {
    const started = startBattle(kit.state, "tr_slime" as never, { canEscape: true, canLose: false }, ctx);
    const asleep = (id: string) => ({ ...started.battle!.allies[id]!, states: [{ id: "st_sleep" as never, turns: 1 }] });
    const t = { ...started, battle: { ...started.battle!, allies: { actor_hero: asleep("actor_hero"), actor_mage: asleep("actor_mage") } } };
    const next = step(t, emptyInput(), ctx).state;
    expect(next.battle!.phase).toBe("resolve");
    expect(next.battle!.queue.map((a) => a.subject).sort()).toEqual(["actor_hero", "actor_mage", "e:0"]);
  });
});
