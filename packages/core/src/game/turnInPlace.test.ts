import { loadFixtureProject, press } from "@rpg/test-utils";
import { describe, expect, it } from "vitest";
import { emptyInput } from "../input.js";
import type { GameState } from "../state.js";
import { initialState, step } from "./index.js";

type Loaded = ReturnType<typeof loadFixtureProject>;

/** minimal（プレイヤーは (2, 2)、下向き）。`turnInPlace` を設定する。 */
function setup(turnInPlace: boolean | undefined): Loaded {
  const loaded = loadFixtureProject("minimal");
  const system = loaded.project.system as { turnInPlace?: boolean };
  if (turnInPlace === undefined) delete system.turnInPlace;
  else system.turnInPlace = turnInPlace;
  return loaded;
}
const start = (l: Loaded): GameState => step(initialState(l.ctx, "s"), emptyInput(), l.ctx).state;
const at = (s: GameState): [number, number] => [s.map.player.x, s.map.player.y];

describe("振り向き（system.turnInPlace）", () => {
  it("有効：違う向きに押した瞬間は、向きだけ変わって移動しない", () => {
    const l = setup(true);
    const s = step(start(l), press("right"), l.ctx).state;
    expect(s.map.player.direction).toBe("right");
    expect(at(s)).toEqual([2, 2]);
    expect(s.map.player.moving).toBe(false);
  });

  it("有効：向いている方向に押せば歩く", () => {
    const l = setup(true);
    const turned = step(start(l), press("right"), l.ctx).state;
    const s = step(turned, press("right"), l.ctx).state;
    expect(s.map.player.moving).toBe(true);
    expect(s.map.player.x).toBe(3);
  });

  it("有効：押し続けると、次のフレームから歩き出す（押した瞬間ではないので向きは変えない）", () => {
    const l = setup(true);
    const held = { pressed: new Set(["right" as const]), triggered: new Set<never>() };
    const turned = step(start(l), press("right"), l.ctx).state;
    expect(at(turned)).toEqual([2, 2]);
    const s = step(turned, held, l.ctx).state;
    expect(s.map.player.x).toBe(3);
  });

  it("有効：向きを変えただけでは手数（turns）を数えない", () => {
    const l = setup(true);
    const s = step(start(l), press("up"), l.ctx).state;
    expect(s.map.player.direction).toBe("up");
    expect(s.map.turns).toBeUndefined();
  });

  it("無効（省略）：従来どおり、押した方向へそのまま歩く", () => {
    const l = setup(undefined);
    const s = step(start(l), press("right"), l.ctx).state;
    expect(s.map.player.x).toBe(3);
    expect(s.map.player.direction).toBe("right");
  });

  it("false でも無効", () => {
    const l = setup(false);
    expect(step(start(l), press("right"), l.ctx).state.map.player.x).toBe(3);
  });
});
