import { loadFixtureProject, press } from "@rpg/test-utils";
import { describe, expect, it } from "vitest";
import { emptyInput } from "../input.js";
import type { InputFrame } from "../input.js";
import type { GameState } from "../state.js";
import { initialState, step } from "./index.js";
import { TURN_IN_PLACE_FRAMES } from "./inputPhase.js";

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
/** キーを押しっぱなしにしている途中のフレーム（押し始めではない）。 */
const held = (...b: ("up" | "down" | "left" | "right")[]): InputFrame => ({ pressed: new Set(b), triggered: new Set() });
/** 押しっぱなしを `n` フレーム続ける。 */
const hold = (s: GameState, l: Loaded, n: number, ...b: ("up" | "down" | "left" | "right")[]): GameState => {
  let cur = s;
  for (let i = 0; i < n; i++) cur = step(cur, held(...b), l.ctx).state;
  return cur;
};

describe("振り向き（system.turnInPlace）", () => {
  it("有効：違う向きに押した瞬間は、向きだけ変わって移動しない", () => {
    const l = setup(true);
    const s = step(start(l), press("right"), l.ctx).state;
    expect(s.map.player.direction).toBe("right");
    expect(at(s)).toEqual([2, 2]);
    expect(s.map.player.moving).toBe(false);
  });

  it("有効：押しっぱなしにしても、しばらくは歩き出さない。待ち時間が過ぎると歩く", () => {
    const l = setup(true);
    const turned = step(start(l), press("right"), l.ctx).state;
    // 普通のキー入力は数フレーム押されたままになる。その間は、向きを変えたまま動かない
    const waiting = hold(turned, l, TURN_IN_PLACE_FRAMES - 1, "right");
    expect(at(waiting)).toEqual([2, 2]);
    expect(waiting.map.player.moving).toBe(false);
    const s = hold(waiting, l, 2, "right");
    expect(s.map.player.moving).toBe(true);
    expect(s.map.player.x).toBe(3);
  });

  it("有効：軽く押して離せば、向きだけ変わる（次に押すまで動かない）", () => {
    const l = setup(true);
    let s = step(start(l), press("right"), l.ctx).state;
    s = hold(s, l, 3, "right");
    s = hold(s, l, 30); // 離した
    expect(at(s)).toEqual([2, 2]);
    expect(s.map.player.direction).toBe("right");
    expect(s.map.turnWait).toBeUndefined();
  });

  it("有効：向いた方向をもう一度押せば、待たずにすぐ歩く", () => {
    const l = setup(true);
    const turned = step(start(l), press("right"), l.ctx).state;
    const s = step(turned, press("right"), l.ctx).state;
    expect(s.map.player.moving).toBe(true);
    expect(s.map.player.x).toBe(3);
  });

  it("有効：もう向いている方向を押し続ければ、そのまま歩く", () => {
    const l = setup(true);
    const s = step(start(l), press("down"), l.ctx).state;
    expect(s.map.player.y).toBe(3);
  });

  it("有効：押しっぱなしの途中で別の方向を押すと、その方向に振り向く", () => {
    const l = setup(true);
    let s = step(start(l), press("right"), l.ctx).state;
    s = hold(s, l, TURN_IN_PLACE_FRAMES + 2, "right"); // 歩き出して…
    while (s.map.player.moving) s = step(s, emptyInput(), l.ctx).state;
    const x = s.map.player.x;
    s = step(s, { pressed: new Set(["right", "up"]), triggered: new Set(["up"]) }, l.ctx).state;
    expect(s.map.player.direction).toBe("up");
    expect(s.map.player.x).toBe(x);
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
    expect(s.map.turnWait).toBeUndefined();
  });

  it("false でも無効", () => {
    const l = setup(false);
    expect(step(start(l), press("right"), l.ctx).state.map.player.x).toBe(3);
  });
});
