import fc from "fast-check";
import { deepFreeze, gameplayInputArb, inputSequenceArb, loadFixtureProject, reachableStateArb } from "@rpg/test-utils";
import { describe, expect, it } from "vitest";
import { emptyInput, inputFrame } from "../input.js";
import type { Button, InputFrame } from "../input.js";
import type { GameState } from "../state.js";
import { dispatch, initialState, step } from "./index.js";

const minimal = loadFixtureProject("minimal");
const { ctx } = minimal;

/** `frames` フレーム、`button` を押し続ける（最初のフレームだけ押下開始）。 */
function hold(state: GameState, button: Button, frames: number, c = ctx): GameState {
  let s = state;
  for (let i = 0; i < frames; i++) s = step(s, inputFrame([button], i === 0 ? [button] : []), c).state;
  return s;
}
const idle = (state: GameState, frames: number, c = ctx): GameState => {
  let s = state;
  for (let i = 0; i < frames; i++) s = step(s, emptyInput(), c).state;
  return s;
};
const press = (state: GameState, button: Button, c = ctx): GameState => step(state, inputFrame([button], [button]), c).state;

describe("initialState", () => {
  const s = initialState(ctx, "seed");

  it("puts the party leader at the start position on the start map", () => {
    expect(s.map.mapId).toBe("map_start");
    expect(s.map.name).toBe("map_start");
    expect(s.map.player).toMatchObject({ x: 2, y: 2, realX: 2, realY: 2, direction: "down", moving: false });
    expect(s.party.members).toEqual(["actor_hero"]);
    expect(s.scene).toEqual({ kind: "map" });
    expect(s.tick).toBe(0);
    expect(s.map.transfer).toBeUndefined();
  });

  it("derives actor stats from the class curve", () => {
    expect(s.actors["actor_hero" as never]).toEqual({ id: "actor_hero", name: "勇者", level: 1, exp: 0, hp: 100, mp: 20 });
  });

  it("evaluates event pages: the NPC starts on page 0", () => {
    expect(s.map.events["ev_npc" as never]).toMatchObject({ pageIndex: 0, trigger: "action", priority: "same", x: 5, y: 2 });
  });

  it("is deterministic per seed and stores the seed in the rng state", () => {
    expect(initialState(ctx, "seed")).toEqual(s);
    expect(initialState(ctx, "other").rng).not.toEqual(s.rng);
    expect(s.rng.seed).toBe("seed");
  });

  it("is JSON-serializable without loss", () => {
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });

  it("reserves a transfer (and requests the map once) when the start map is not loaded yet", () => {
    const lazy = loadFixtureProject("minimal");
    const map = lazy.maps["map_start" as never];
    delete (lazy.maps as Record<string, unknown>)["map_start"];
    const s0 = initialState(lazy.ctx, "lazy");
    expect(s0.map.transfer).toMatchObject({ to: "map_start", x: 2, y: 2, requested: false });

    const r1 = step(s0, emptyInput(), lazy.ctx);
    expect(r1.effects).toEqual([{ kind: "requestMapData", mapId: "map_start" }]);
    const r2 = step(r1.state, emptyInput(), lazy.ctx);
    expect(r2.effects).toEqual([]); // 二度目は要求しない

    (lazy.maps as Record<string, unknown>)["map_start"] = map;
    const r3 = step(r2.state, emptyInput(), lazy.ctx);
    expect(r3.state.map.transfer).toBeUndefined();
    expect(r3.state.map.player).toMatchObject({ x: 2, y: 2 });
    expect(r3.state.map.events["ev_npc" as never]).toMatchObject({ pageIndex: 0 });
  });
});

describe("walking", () => {
  it("starts a step immediately: x advances at once and realX interpolates over 16 frames (speed 4)", () => {
    const s0 = initialState(ctx, "w");
    const s1 = step(s0, inputFrame(["right"], ["right"]), ctx).state;
    expect(s1.map.player).toMatchObject({ x: 3, realX: 2 + 1 / 16, moving: true, direction: "right" });
    const s16 = idle(s1, 15);
    expect(s16.map.player).toMatchObject({ x: 3, realX: 3, moving: false });
  });

  it("cannot start another step while moving", () => {
    let s = initialState(ctx, "w");
    s = step(s, inputFrame(["right"], ["right"]), ctx).state;
    s = step(s, inputFrame(["down"], ["down"]), ctx).state;
    expect(s.map.player).toMatchObject({ x: 3, y: 2, direction: "right" });
  });

  it("holding a direction walks one tile per 16 frames", () => {
    expect(hold(initialState(ctx, "w"), "down", 47).map.player).toMatchObject({ y: 5, moving: true });
    expect(hold(initialState(ctx, "w"), "down", 48).map.player).toMatchObject({ y: 5, realY: 5, moving: false });
    expect(hold(initialState(ctx, "w"), "down", 49).map.player).toMatchObject({ y: 6, moving: true });
  });

  it("stops at the wall and only turns", () => {
    const s = hold(initialState(ctx, "w"), "left", 200);
    expect(s.map.player).toMatchObject({ x: 1, direction: "left", moving: false });
  });

  it("is blocked by a same-priority event (the NPC at x=5)", () => {
    const s = hold(initialState(ctx, "w"), "right", 200);
    expect(s.map.player).toMatchObject({ x: 4, y: 2, direction: "right" });
  });

  it("uses down > left > right > up when several directions are held", () => {
    const s = step(initialState(ctx, "w"), inputFrame(["up", "right", "left"], []), ctx).state;
    expect(s.map.player).toMatchObject({ direction: "left", x: 1 });
  });

  it("moves the camera with the player, clamped to the map (screen 10x8 tiles = the whole map)", () => {
    const s = hold(initialState(ctx, "w"), "down", 60);
    expect(s.map.camera).toEqual({ x: 0, y: 0 });
  });
});

describe("talking to an event", () => {
  const nextToNpc = hold(initialState(ctx, "talk"), "right", 200); // (4,2) facing right

  it("shows the message on 'ok', blocks movement, and closes on the next 'ok'", () => {
    let s = press(nextToNpc, "ok");
    expect(s.interpreters).toHaveLength(1);
    expect(s.message).toMatchObject({ open: true, text: "こんにちは！", position: "bottom", background: "window" });
    expect(s.map.events["ev_npc" as never]).toMatchObject({ direction: "left" }); // 話しかけられた側がこちらを向く

    s = hold(s, "left", 10); // 移動できない
    expect(s.map.player).toMatchObject({ x: 4 });
    expect(s.message.open).toBe(true);

    s = press(s, "ok");
    expect(s.message.open).toBe(false);
    s = idle(s, 3);
    expect(s.interpreters).toHaveLength(0);
    expect(s.switches["sw_talked" as never]).toBe(true);
    expect(s.variables["var_talk_count" as never]).toBe(1);
  });

  it("switches to page 1 after the switch turns on, and counts every conversation", () => {
    let s = nextToNpc;
    for (let i = 0; i < 3; i++) {
      s = press(s, "ok");
      s = press(s, "ok");
      s = idle(s, 3);
    }
    expect(s.variables["var_talk_count" as never]).toBe(3);
    expect(s.map.events["ev_npc" as never]).toMatchObject({ pageIndex: 1 });
    s = press(s, "ok");
    expect(s.message.text).toBe("また会ったね。");
  });

  it("applies the page change in the same frame the event finishes, so an immediate 'ok' starts the new page", () => {
    let s = press(nextToNpc, "ok"); // 1 回目の会話を開く
    s = press(s, "ok"); // 閉じる。この step のうちにインタプリタが終わりスイッチが入る
    expect(s.switches["sw_talked" as never]).toBe(true);
    expect(s.map.events["ev_npc" as never]).toMatchObject({ pageIndex: 1 });
    s = press(s, "ok"); // 次のフレームですぐ話しかけても、古いページは起動しない
    expect(s.message.text).toBe("また会ったね。");
  });

  it("does nothing when 'ok' is pressed facing empty ground", () => {
    const s = press(initialState(ctx, "x"), "ok");
    expect(s.interpreters).toHaveLength(0);
    expect(s.message.open).toBe(false);
  });

  it("ignores 'ok' pressed while the previous event is still running", () => {
    const s0 = press(nextToNpc, "ok");
    const s1 = press(s0, "ok"); // closes the message; does not start a second interpreter
    expect(s1.interpreters.length).toBeLessThanOrEqual(1);
  });
});

describe("transfer between maps (fixtures/transfer-demo)", () => {
  const demo = loadFixtureProject("transfer-demo");

  function toDoor(c = demo.ctx): GameState {
    // (1,1) → 右へ歩き、(8,1) の扉（接触・通常プライオリティ）に突き当たる
    return hold(initialState(c, "door"), "right", 16 * 8, c);
  }

  it("bumping into the door starts its interpreter", () => {
    const s = toDoor();
    expect(s.map.player).toMatchObject({ x: 7, y: 1 });
    expect(s.interpreters).toHaveLength(1);
    expect(s.message.text).toBe("扉を開ける…");
  });

  it("runs Wait / variables / branch / TransferPlayer and ends up on map_b", () => {
    let s = toDoor();
    s = press(s, "ok", demo.ctx); // 「扉を開ける…」を閉じる
    s = idle(s, 40, demo.ctx);
    expect(s.variables["var_visits" as never]).toBe(1);
    expect(s.message).toMatchObject({ open: true, text: "初めて入る。" }); // 1 回目なので Else 側
    s = press(s, "ok", demo.ctx);
    s = idle(s, 5, demo.ctx);
    expect(s.map.mapId).toBe("map_b");
    expect(s.map.player).toMatchObject({ x: 2, y: 3, direction: "down", moving: false });
    expect(s.map.transfer).toBeUndefined();
    expect(s.switches["sw_entered" as never]).toBe(true);
    expect(s.interpreters).toHaveLength(0);
    expect(Object.keys(s.map.events)).toEqual(["ev_sign"]);
  });

  it("waits for the target map to be loaded, requesting it exactly once", () => {
    const lazy = loadFixtureProject("transfer-demo");
    const mapB = lazy.maps["map_b" as never];
    delete (lazy.maps as Record<string, unknown>)["map_b"];

    let s = toDoor(lazy.ctx);
    const effects: unknown[] = [];
    const advance = (frames: number, button?: Button): void => {
      for (let i = 0; i < frames; i++) {
        const r = step(s, button ? inputFrame([button], [button]) : emptyInput(), lazy.ctx);
        s = r.state;
        effects.push(...r.effects);
      }
    };
    advance(1, "ok");
    advance(40);
    advance(1, "ok");
    advance(30);
    expect(s.map.mapId).toBe("map_a");
    expect(s.map.transfer).toMatchObject({ to: "map_b", requested: true });
    expect(effects.filter((e) => (e as { kind: string }).kind === "requestMapData")).toEqual([{ kind: "requestMapData", mapId: "map_b" }]);
    expect(s.interpreters[0]?.wait).toEqual({ kind: "transfer" });

    (lazy.maps as Record<string, unknown>)["map_b"] = mapB;
    advance(3);
    expect(s.map.mapId).toBe("map_b");
    expect(s.interpreters).toHaveLength(0);
  });

  it("takes the second branch on the second visit", () => {
    const withCount = loadFixtureProject("transfer-demo");
    let s = initialState(withCount.ctx, "again");
    s = { ...s, variables: { ["var_visits" as never]: 1 } };
    s = hold(s, "right", 16 * 8, withCount.ctx);
    s = press(s, "ok", withCount.ctx);
    s = idle(s, 40, withCount.ctx);
    expect(s.message.text).toBe("二度目だ。");
  });
});

describe("step: invariants", () => {
  it("[inv-1] is pure: the same (state, input, ctx) gives the same result", () => {
    fc.assert(
      fc.property(reachableStateArb(ctx, 60), gameplayInputArb, (state, input) => {
        expect(step(state, input, ctx)).toEqual(step(state, input, ctx));
      }),
      { numRuns: 60 },
    );
  });

  it("[inv-2] does not mutate its input state (deep-frozen state does not throw)", () => {
    fc.assert(
      fc.property(reachableStateArb(ctx, 60), inputSequenceArb(20), (state, inputs) => {
        let s = deepFreeze(structuredClone(state));
        const before = JSON.stringify(s);
        for (const input of inputs) s = deepFreeze(step(s, input, ctx).state);
        expect(before).toBe(JSON.stringify(deepFreeze(structuredClone(state))));
      }),
      { numRuns: 40 },
    );
  });

  it("[inv-3] tick increases by exactly 1 per step", () => {
    fc.assert(
      fc.property(reachableStateArb(ctx, 40), inputSequenceArb(15), (state, inputs) => {
        let s = state;
        for (const input of inputs) {
          const next = step(s, input, ctx).state;
          expect(next.tick).toBe(s.tick + 1);
          expect(next.playtimeTicks).toBe(s.playtimeTicks + 1);
          s = next;
        }
      }),
      { numRuns: 40 },
    );
  });

  it("step equals dispatch(input) then dispatch(tick) for the M1 commands", () => {
    fc.assert(
      fc.property(reachableStateArb(ctx, 40), gameplayInputArb, (state, input) => {
        const a = dispatch(state, { type: "input", input }, ctx);
        const b = dispatch(a.state, { type: "tick" }, ctx);
        const composed = { state: b.state, effects: [...a.effects, ...b.effects] };
        expect(composed).toEqual(step(state, input, ctx));
      }),
      { numRuns: 60 },
    );
  });

  it("the player never leaves the map or enters a blocked tile (random walks)", () => {
    const map = minimal.maps["map_start" as never]!;
    fc.assert(
      fc.property(reachableStateArb(ctx, 200), (state) => {
        const { x, y } = state.map.player;
        expect(x >= 0 && y >= 0 && x < map.width && y < map.height).toBe(true);
        const wall = map.layers[1]!.tiles[y * map.width + x];
        expect(wall).toBe(0);
        expect(state.map.events["ev_npc" as never]).toMatchObject({ x: 5, y: 2 });
        expect(!(x === 5 && y === 2)).toBe(true);
      }),
      { numRuns: 60 },
    );
  });
});

describe("dispatch", () => {
  it("startGame resets to the initial state of the given project (keeping the seed by default)", () => {
    const s = hold(initialState(ctx, "keep"), "down", 30);
    const r = dispatch(s, { type: "startGame", project: ctx.project }, ctx);
    expect(r.state).toEqual(initialState(ctx, "keep"));
    expect(dispatch(s, { type: "startGame", project: ctx.project, seed: "new" }, ctx).state).toEqual(initialState(ctx, "new"));
  });

  it("interpreter start / terminate", () => {
    const s0 = initialState(ctx, "i");
    const commands = [{ code: "Wait", params: { frames: 100 }, indent: 0 }];
    const started = dispatch(s0, { type: "interpreter", op: "start", origin: { kind: "plugin", name: "t" }, commands, mode: "normal" }, ctx);
    expect(started.state.interpreters).toHaveLength(1);
    const id = started.state.interpreters[0]!.id;
    expect(dispatch(started.state, { type: "interpreter", op: "terminate", id }, ctx).state.interpreters).toHaveLength(0);
  });

  it("an 'input' action never advances time", () => {
    const s = initialState(ctx, "t");
    const r = dispatch(s, { type: "input", input: inputFrame(["right"], ["right"]) }, ctx);
    expect(r.state.tick).toBe(0);
  });
});

export type { InputFrame };
