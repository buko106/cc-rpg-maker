import { battleKit, cmd, drive, idleFrames, press, runCommands } from "@rpg/test-utils";
import type { GameState } from "../index.js";
import { emptyInput, step, toSnapshot, fromSnapshot, startInterpreter } from "../index.js";
import { describe, expect, it } from "vitest";

const kit = battleKit({
  mutate: (p) => {
    p.system.bgm.battle = { asset: "aaaaaaaaaaaaaaaa" as never, volume: 1, pitch: 1, loop: true };
    p.assets.entries["aaaaaaaaaaaaaaaa" as never] = { name: "battle.ogg", kind: "audio", mime: "audio/ogg", size: 1 };
  },
});
const { ctx } = kit;

/** 戦闘の後に、結果ごとのスイッチを立てる（勝利 = sw_win、逃走 = sw_escape、敗北 = sw_lose）。 */
const program = (troop: string, opts: Record<string, unknown> = {}) => [
  cmd("BattleProcessing", { troop, ...opts }),
  cmd("ChoiceBranch", { index: 0 }),
  cmd("ControlSwitches", { ids: ["sw_win"], value: true }, 1),
  cmd("ChoiceBranch", { index: 1 }),
  cmd("ControlSwitches", { ids: ["sw_escape"], value: true }, 1),
  cmd("ChoiceBranch", { index: 2 }),
  cmd("ControlSwitches", { ids: ["sw_lose"], value: true }, 1),
  cmd("EndBranch"),
  cmd("ControlSwitches", { ids: ["sw_after"], value: true }),
];

const start = (commands = program("tr_slime")): GameState => startInterpreter(kit.state, { kind: "plugin", name: "t" }, commands, "normal");

type Command = (b: NonNullable<GameState["battle"]>) => ReturnType<typeof press>;
/** コマンドメニューのカーソルを `index` 番目まで動かして決定する。対象選択などは常に決定。 */
const choose = (index: number): Command => (b) => (b.inputCursor.menu === "command" && b.inputCursor.index !== index ? press("down") : press("ok"));
const attack = choose(0);
const guard = choose(3);
const escape = choose(4);

/**
 * 全員が同じコマンドを選ぶ自動プレイ。結果表示は決定で送る。`until` が真になるか、インタプリタが終わるまで回す。
 */
function autoplay(s: GameState, k: { ctx: typeof ctx }, command: Command, until: (s: GameState) => boolean = (x) => x.interpreters.length === 0): GameState {
  let state = s;
  for (let i = 0; i < 4000 && !until(state); i++) {
    const b = state.battle;
    let input = emptyInput();
    if (b?.phase === "input") input = command(b);
    else if (b !== undefined && b.phase !== "resolve" && b.wait <= 0) input = press("ok");
    state = step(state, input, k.ctx).state;
  }
  return state;
}

describe("BattleProcessing", () => {
  it("starts the battle, plays the battle BGM and waits for it", () => {
    const r = step(step(start(), emptyInput(), ctx).state, emptyInput(), ctx);
    expect(r.state.scene.kind).toBe("battle");
    expect(r.state.interpreters[0]!.wait).toEqual({ kind: "battle" });
    expect(r.state.interpreters[0]!.pc).toBe(0);
    const first = step(start(), emptyInput(), ctx);
    expect(first.effects).toContainEqual({ kind: "playBgm", audio: { asset: "aaaaaaaaaaaaaaaa", volume: 1, pitch: 1, loop: true }, fadeMs: 300 });
  });

  it("takes the victory branch and continues after the block", () => {
    const end = autoplay(start(), kit, attack);
    expect(end.scene.kind).toBe("map");
    expect(end.battle).toBeUndefined();
    expect(end.switches).toEqual({ sw_win: true, sw_after: true });
    expect(end.party.gold).toBe(8);
    expect(end.interpreters).toEqual([]);
  });

  it("takes the escape branch when the party runs away", () => {
    let found = false;
    for (let n = 0; n < 40 && !found; n++) {
      const k = battleKit({ seed: `run-${n}` });
      const end = autoplay(startInterpreter(k.state, { kind: "plugin", name: "t" }, program("tr_slime"), "normal"), k, escape);
      if (end.switches["sw_escape" as never] === true) {
        found = true;
        expect(end.switches).toEqual({ sw_escape: true, sw_after: true });
        expect(end.party.gold).toBe(0);
      }
    }
    expect(found).toBe(true);
  });

  it("takes the defeat branch when the battle can be lost", () => {
    const s = startInterpreter(kit.state, { kind: "plugin", name: "t" }, program("tr_brute", { canLose: true }), "normal");
    const end = autoplay(s, kit, guard);
    expect(end.scene.kind).toBe("map");
    expect(end.switches).toEqual({ sw_lose: true, sw_after: true });
    expect(Object.values(end.actors).every((a) => a.hp >= 1)).toBe(true);
  });

  it("game over when the battle cannot be lost: the interpreter never continues", () => {
    const s = startInterpreter(kit.state, { kind: "plugin", name: "t" }, program("tr_brute", { canLose: false }), "normal");
    const end = autoplay(s, kit, guard, (x) => x.scene.kind === "gameover");
    expect(end.scene.kind).toBe("gameover");
    expect(end.switches["sw_after" as never]).toBeUndefined();
    expect(drive(end, ctx, idleFrames(60)).state.scene.kind).toBe("gameover");
  });

  it("skips (with a warning) when the troop does not exist", () => {
    const r = runCommands([cmd("BattleProcessing", { troop: "tr_missing" }), cmd("ControlSwitches", { ids: ["sw_after"], value: true })], { ctx });
    expect(r.finished).toBe(true);
    expect(r.state.scene.kind).toBe("map");
    expect(r.state.switches).toEqual({ sw_after: true });
    expect(r.effects.some((e) => e.kind === "log" && e.level === "warn" && e.message.includes("tr_missing"))).toBe(true);
  });

  it("a battle restored from a save (battle state is never saved) takes the escape branch", () => {
    let s = step(start(), emptyInput(), ctx).state;
    s = step(s, emptyInput(), ctx).state;
    expect(s.scene.kind).toBe("battle");
    const snap = toSnapshot(s, { projectId: "p", projectHash: "h", savedAt: "2026-01-01T00:00:00Z" });
    expect(snap.state.scene).toEqual({ kind: "map" });
    expect("battle" in snap.state).toBe(false);
    const restored = fromSnapshot(snap, ctx);
    if (!restored.ok) throw new Error("restore failed");
    let state = restored.value;
    for (let i = 0; i < 20 && state.interpreters.length > 0; i++) state = step(state, emptyInput(), ctx).state;
    expect(state.switches).toEqual({ sw_escape: true, sw_after: true });
  });

  it("does not start a battle from a non-map scene", () => {
    const s = { ...start(), scene: { kind: "menu", screen: "main", cursor: 0 } } as GameState;
    const r = step(s, emptyInput(), ctx);
    expect(r.state.scene.kind).toBe("menu");
  });
});
