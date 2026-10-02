import type { Direction, EventPage, MapEvent, MoveRoute } from "@rpg/schema";
import { cmd, loadFixtureProject, press } from "@rpg/test-utils";
import { describe, expect, it } from "vitest";
import { emptyInput } from "../input.js";
import type { GameState } from "../state.js";
import { initialState, step } from "./index.js";

type Loaded = ReturnType<typeof loadFixtureProject>;

/** minimal（内側 x 1..8・y 1..6、プレイヤーは (2, 2)）に、テスト用のイベントと壁（x, y）だけを置く。 */
function setup(events: MapEvent[], walls: [number, number][] = []): Loaded {
  const loaded = loadFixtureProject("minimal");
  const map = loaded.maps["map_start" as never]!;
  (map as { events: unknown }).events = Object.fromEntries(events.map((e) => [e.id, e]));
  const tiles = map.layers.find((l) => l.name === "walls")!.tiles as number[];
  for (const [x, y] of walls) tiles[y * map.width + x] = 2;
  return loaded;
}
const page = (o: Partial<EventPage>): EventPage => ({ conditions: [], trigger: "action", through: false, priority: "same", commands: [], ...o });
const event = (id: string, x: number, y: number, ...pages: EventPage[]): MapEvent => ({ id: id as never, name: id, x, y, pages });
const route = (steps: MoveRoute["steps"], o: Partial<MoveRoute> = {}): MoveRoute => ({ repeat: true, skippable: false, pace: "playerStep", steps, ...o });
const go = (dir: Direction, n = 1): MoveRoute["steps"] => Array.from({ length: n }, () => ({ kind: "move", dir }));
/** ターン制で動くイベント（`steps` を繰り返す）。 */
const walker = (id: string, x: number, y: number, steps: MoveRoute["steps"], o: Partial<MoveRoute> = {}, p: Partial<EventPage> = {}): MapEvent =>
  event(id, x, y, page({ graphic: { asset: "0123456789abcdef" as never, index: 0, direction: "down" }, moveRoute: route(steps, o), ...p }));

const frames = (state: GameState, n: number, ctx: Loaded["ctx"]): GameState => {
  let s = state;
  for (let i = 0; i < n; i++) s = step(s, emptyInput(), ctx).state;
  return s;
};
/** 動きが止まるまで（歩いているプレイヤーとイベントがなくなるまで）進める。 */
function settle(state: GameState, ctx: Loaded["ctx"]): GameState {
  let s = state;
  for (let i = 0; i < 400 && s.scene.kind === "map" && (s.map.player.moving || Object.values(s.map.events).some((e) => e.moving)); i++) s = step(s, emptyInput(), ctx).state;
  return s;
}
/** 1 回押して、みんなの動きが止まるまで進める。 */
const walk = (state: GameState, ctx: Loaded["ctx"], dir: Direction | "ok"): GameState => settle(step(state, press(dir), ctx).state, ctx);
const start = (loaded: Loaded): GameState => frames(initialState(loaded.ctx, "s"), 2, loaded.ctx);
const at = (s: GameState): [number, number] => [s.map.player.x, s.map.player.y];
const evAt = (s: GameState, id: string): [number, number] => [s.map.events[id as never]!.x, s.map.events[id as never]!.y];

describe("ターン制の移動ルート（pace: playerStep）", () => {
  it("プレイヤーが動かないあいだは、いくら時間がたっても動かない", () => {
    const l = setup([walker("w", 6, 4, go("right", 2))]);
    expect(evAt(frames(start(l), 300, l.ctx), "w")).toEqual([6, 4]);
  });

  it("プレイヤーが 1 歩歩くたびに、1 歩だけ動く（歩いた同じ手の中で動き出す）", () => {
    const l = setup([walker("w", 4, 4, [...go("right"), ...go("down"), ...go("left"), ...go("up")])]);
    let s = start(l);
    const seen: [number, number][] = [];
    for (const dir of ["right", "left", "right", "left"] as const) {
      s = walk(s, l.ctx, dir);
      seen.push(evAt(s, "w"));
    }
    expect(seen).toEqual([[5, 4], [5, 5], [4, 5], [4, 4]]);
    expect(s.map.turns).toBe(4);
  });

  it("通れずに向きだけ変わった手は数えない。足踏み（決定ボタン）は 1 手", () => {
    const l = setup([walker("w", 6, 4, go("right"))], [[1, 2]]);
    let s = start(l);
    s = walk(s, l.ctx, "left"); // (1, 2) は壁。向きが変わるだけ
    expect(at(s)).toEqual([2, 2]);
    expect(s.map.turns ?? 0).toBe(0);
    expect(evAt(s, "w")).toEqual([6, 4]);
    s = walk(s, l.ctx, "ok");
    expect(at(s)).toEqual([2, 2]);
    expect(s.map.turns).toBe(1);
    expect(evAt(s, "w")).toEqual([7, 4]);
  });

  it("ターン制のイベントが居ないマップでは、決定ボタンは何も起こさず、歩いても手数を数えない（状態に turns が増えない）", () => {
    const l = setup([event("plain", 6, 4, page({ moveRoute: { repeat: true, skippable: false, pace: "frames", steps: go("right") } }))]);
    let s = walk(start(l), l.ctx, "ok");
    expect(s.map.turns).toBeUndefined();
    s = walk(walk(s, l.ctx, "right"), l.ctx, "down");
    expect(at(s)).toEqual([3, 3]);
    expect(s.map).not.toHaveProperty("turns");
  });

  it("イベントが歩いているあいだは、プレイヤーは次の手を打てない（遅いイベントなら、その分待つ）", () => {
    const l = setup([walker("w", 6, 4, [{ kind: "speed", value: 2 }, ...go("right")])]);
    let s = step(start(l), press("right"), l.ctx).state; // 手 1：歩き出す
    for (let i = 0; i < 4; i++) s = step(s, emptyInput(), l.ctx).state;
    expect(s.map.events["w" as never]!.moving).toBe(true);
    const before = s.map.turns;
    s = step(s, press("right"), l.ctx).state; // まだ打てない
    expect(s.map.turns).toBe(before);
    s = settle(s, l.ctx);
    s = walk(s, l.ctx, "right");
    expect(s.map.turns).toBe((before ?? 0) + 1);
  });

  it("wait の frames は待つ手数、turn と speed は時間がかからない（向きを変えて、すぐ次の歩へ）", () => {
    const l = setup([walker("w", 6, 4, [{ kind: "wait", frames: 2 }, ...go("right"), { kind: "turn", dir: "up" }, { kind: "wait", frames: 0 }, ...go("up")])]);
    let s = start(l);
    const trace: [number, number][] = [];
    for (const dir of ["right", "left", "right", "left", "right"] as const) {
      s = walk(s, l.ctx, dir);
      trace.push(evAt(s, "w"));
    }
    // 手 1・2 は待ち、手 3 で右へ、手 4 で上へ、手 5 は（ルートを 1 周して）また待ち
    expect(trace).toEqual([[6, 4], [6, 4], [7, 4], [7, 3], [7, 3]]);
  });

  it("通れないときは、その手をあきらめて待たずに次の手へ進む（プレイヤーの手とずれない）", () => {
    const l = setup([walker("w", 6, 4, [...go("right", 2), ...go("left", 2)])], [[7, 4]]);
    let s = start(l);
    const trace: [number, number][] = [];
    for (const dir of ["right", "left", "right", "left"] as const) {
      s = walk(s, l.ctx, dir);
      trace.push(evAt(s, "w"));
    }
    // 右は壁（手 1・2 はあきらめ）、左へ 2 歩（手 3・4）
    expect(trace).toEqual([[6, 4], [6, 4], [5, 4], [4, 4]]);
  });

  it("repeat でないルートは、1 回通ったら止まる", () => {
    const l = setup([walker("w", 6, 4, go("right", 2), { repeat: false })]);
    let s = start(l);
    for (const dir of ["right", "left", "right", "left"] as const) s = walk(s, l.ctx, dir);
    expect(evAt(s, "w")).toEqual([8, 4]);
  });

  it("押せる岩を押した手も 1 手。氷の上で滑っている間は数えない", () => {
    const l = setup([walker("w", 6, 4, go("right")), event("rock", 3, 2, page({ pushable: true, graphic: { asset: "0123456789abcdef" as never, index: 1, direction: "down" } }))]);
    let s = start(l);
    s = walk(s, l.ctx, "right"); // 岩を押して (3, 2) → (4, 2)、自分は (3, 2)
    expect([at(s), evAt(s, "rock")]).toEqual([[3, 2], [4, 2]]);
    expect(s.map.turns).toBe(1);
    expect(evAt(s, "w")).toEqual([7, 4]);
  });

  it("イベントから接触：プレイヤーの居るタイルへは入らず、触れてそのページが始まる", () => {
    const hit = cmd("ControlSwitches", { ids: ["hit"], value: true });
    const l = setup([walker("w", 5, 2, go("left"), {}, { trigger: "eventTouch", commands: [hit] })]);
    let s = start(l);
    s = walk(s, l.ctx, "right"); // 自分は (3, 2)、番人が (4, 2) へ
    expect(evAt(s, "w")).toEqual([4, 2]);
    expect(s.switches["hit" as never]).toBeUndefined();
    s = walk(s, l.ctx, "ok"); // 足踏み：番人は (3, 2) へ入ろうとして、触れる
    s = frames(s, 5, l.ctx);
    expect(evAt(s, "w")).toEqual([4, 2]);
    expect(s.switches["hit" as never]).toBe(true);
  });

  it("視界（eventSight）：プレイヤーが止まったとき、番人の向きと位置で見える", () => {
    const seen = cmd("ControlSwitches", { ids: ["seen"], value: true });
    const w = walker("w", 7, 4, [...go("up", 2)], {}, { trigger: "eventSight", sightRange: 6, commands: [seen] });
    const l = setup([w]);
    let s = start(l);
    expect(s.switches["seen" as never]).toBeUndefined();
    s = walk(s, l.ctx, "right");
    s = walk(s, l.ctx, "right"); // 番人は (7, 2) まで来て、上を向いている。（4, 2）のプレイヤーは右隣の列に居るので見えない
    expect(evAt(s, "w")).toEqual([7, 2]);
    expect(s.switches["seen" as never]).toBeUndefined();
  });

  it("SetMoveRoute でも、pace: playerStep のルートは手に合わせて進む", () => {
    const l = setup([event("w", 6, 4, page({ trigger: "autorun", commands: [cmd("SetMoveRoute", { target: "this", route: route(go("right", 3), { repeat: false }) }), cmd("ControlSelfSwitch", { key: "A", value: true })] }), page({ conditions: [{ kind: "selfSwitch", key: "A", value: true }], graphic: { asset: "0123456789abcdef" as never, index: 0, direction: "down" } }))]);
    let s = frames(initialState(l.ctx, "s"), 4, l.ctx);
    expect(evAt(s, "w")).toEqual([6, 4]);
    s = walk(s, l.ctx, "right");
    expect(evAt(s, "w")).toEqual([7, 4]);
    s = walk(s, l.ctx, "left");
    expect(evAt(s, "w")).toEqual([8, 4]);
  });

  it("SetMoveRoute で wait: true にしても、ターン制のルートは並列で動く（通常のイベントがプレイヤーの手を待って止まらない）", () => {
    const done = cmd("ControlSwitches", { ids: ["done"], value: true });
    const l = setup([event("w", 6, 4, page({ trigger: "autorun", graphic: { asset: "0123456789abcdef" as never, index: 0, direction: "down" }, commands: [cmd("SetMoveRoute", { target: "this", wait: true, route: route(go("right", 2), { repeat: false }) }), done, cmd("ControlSelfSwitch", { key: "A", value: true })] }), page({ conditions: [{ kind: "selfSwitch", key: "A", value: true }], graphic: { asset: "0123456789abcdef" as never, index: 0, direction: "down" } }))]);
    let s = frames(initialState(l.ctx, "s"), 10, l.ctx);
    expect(s.switches["done" as never]).toBe(true);
    s = walk(s, l.ctx, "right");
    s = walk(s, l.ctx, "left");
    expect(evAt(s, "w")).toEqual([8, 4]);
  });

  it("手数はセーブ（スナップショット）に含まれて、ロードしても番人の進み具合が続く", async () => {
    const { toSnapshot, fromSnapshot } = await import("../snapshot.js");
    const l = setup([walker("w", 4, 4, go("right", 3))]);
    let s = start(l);
    s = walk(s, l.ctx, "right");
    s = walk(s, l.ctx, "left");
    expect(evAt(s, "w")).toEqual([6, 4]);
    const loaded = fromSnapshot(toSnapshot(s, { projectId: "minimal", projectHash: "h", savedAt: "2026-01-01T00:00:00Z" }), l.ctx);
    expect(loaded.ok ? "ok" : JSON.stringify(loaded.error)).toBe("ok");
    if (!loaded.ok) return;
    expect(loaded.value.map.turns).toBe(2);
    const t = walk(loaded.value, l.ctx, "right");
    expect(evAt(t, "w")).toEqual([7, 4]);
  });

  it("同じシードと入力なら、同じ結果になる（決定論）", () => {
    const run = (): GameState => {
      const l = setup([walker("w", 6, 4, [{ kind: "move", dir: "random" }, ...go("left")])]);
      let s = start(l);
      for (const dir of ["right", "down", "left", "ok", "up"] as const) s = walk(s, l.ctx, dir);
      return s;
    };
    expect(run()).toEqual(run());
  });
});
