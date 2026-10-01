import type { Direction, EventPage, MapData, MapEvent } from "@rpg/schema";
import { battleProject, cmd, loadFixtureProject, press } from "@rpg/test-utils";
import { describe, expect, it } from "vitest";
import { createCtx } from "../ctx.js";
import { emptyInput } from "../input.js";
import { createProjectView } from "../project-view.js";
import type { GameState } from "../state.js";
import { initialState, step } from "./index.js";

type Loaded = ReturnType<typeof loadFixtureProject>;

const ICE = 4;
/** minimal（内側 x 1..8・y 1..6、プレイヤーは (2, 2)）に、氷のタイル（`ICE`）とイベントを置く。`iceCells` は氷にする (x, y)。 */
function setup(iceCells: [number, number][], events: MapEvent[] = [], walls: [number, number][] = []): Loaded {
  const loaded = loadFixtureProject("minimal");
  const map = loaded.maps["map_start" as never]!;
  (map as { events: unknown }).events = Object.fromEntries(events.map((e) => [e.id, e]));
  const ground = map.layers.find((l) => l.name === "ground")!.tiles as number[];
  for (const [x, y] of iceCells) ground[y * map.width + x] = ICE;
  const walls_ = map.layers.find((l) => l.name === "walls")!.tiles as number[];
  for (const [x, y] of walls) walls_[y * map.width + x] = 2;
  const tileset = loaded.project.tilesets["ts_basic" as never]!;
  (tileset as { passage: number[] }).passage[ICE] = 15;
  (tileset as { ice?: number[] }).ice = [ICE];
  return loaded;
}
const page = (o: Partial<EventPage>): EventPage => ({ conditions: [], trigger: "action", through: false, priority: "same", commands: [], ...o });
const event = (id: string, x: number, y: number, ...pages: EventPage[]): MapEvent => ({ id: id as never, name: id, x, y, pages });
const rock = (id: string, x: number, y: number, o: Partial<EventPage> = {}): MapEvent => event(id, x, y, page({ pushable: true, graphic: { asset: "a" as never, index: 0, direction: "down" }, ...o }));
const row = (y: number, from: number, to: number): [number, number][] => Array.from({ length: to - from + 1 }, (_, i) => [from + i, y] as [number, number]);

/** 1 回押して、動きが止まるまで進める（途中で別のシーンになったら止める）。 */
function walk(state: GameState, ctx: Loaded["ctx"], dir: Direction): GameState {
  let s = step(state, press(dir), ctx).state;
  for (let i = 0; i < 400 && s.scene.kind === "map" && s.map.player.moving; i++) s = step(s, emptyInput(), ctx).state;
  return s;
}
const at = (s: GameState): [number, number] => [s.map.player.x, s.map.player.y];
const evAt = (s: GameState, id: string): [number, number] => [s.map.events[id as never]!.x, s.map.events[id as never]!.y];
/** 初期状態（イベントのページを有効にするため 1 フレーム進める）。 */
function start(loaded: Loaded): GameState {
  return step(initialState(loaded.ctx, "s"), emptyInput(), loaded.ctx).state;
}

describe("氷（滑る床）", () => {
  it("氷でない床では 1 タイルだけ進む", () => {
    const l = setup([]);
    expect(at(walk(start(l), l.ctx, "right"))).toEqual([3, 2]);
  });

  it("氷のタイルに着くと同じ向きに滑り、氷を出た最初のタイルで止まる", () => {
    const l = setup(row(2, 3, 5));
    // (3, 2)〜(5, 2) が氷。(5, 2) から 1 歩進んだ (6, 2) は氷でないので、そこで止まる
    expect(at(walk(start(l), l.ctx, "right"))).toEqual([6, 2]);
  });

  it("壁に突き当たるまで氷が続けば、壁の手前で止まる", () => {
    const l = setup(row(2, 3, 8));
    expect(at(walk(start(l), l.ctx, "right"))).toEqual([8, 2]);
  });

  it("滑っている間は操作できず、止まったあとはまた歩ける（氷の上から別の向きへも）", () => {
    const l = setup(row(2, 3, 8));
    let s = step(start(l), press("right"), l.ctx).state;
    for (let i = 0; i < 20; i++) s = step(s, press("left"), l.ctx).state; // 滑っている間の入力は効かない
    expect(s.map.player.x).toBeGreaterThan(2);
    s = walk(s, l.ctx, "right");
    expect(at(s)).toEqual([8, 2]);
    s = walk(s, l.ctx, "left"); // 氷の上でも、向きを変えて滑れる（右端の (8, 2) から左へ。氷の左の (2, 2) で止まる）
    expect(at(s)).toEqual([2, 2]);
  });

  it("通れないイベント（岩など）の手前で止まる", () => {
    const l = setup(row(2, 3, 8), [event("stone", 6, 2, page({ graphic: { asset: "a" as never, index: 0, direction: "down" } }))]);
    expect(at(walk(start(l), l.ctx, "right"))).toEqual([5, 2]);
  });

  it("足元に接触イベントのある氷の上では、そこで止まってイベントが始まる", () => {
    const touch = event("plate", 5, 2, page({ trigger: "touch", priority: "below", through: true, commands: [cmd("ControlSwitches", { ids: ["hit"], value: true })] }));
    const l = setup(row(2, 3, 8), [touch]);
    let s = walk(start(l), l.ctx, "right");
    expect(at(s)).toEqual([5, 2]);
    for (let i = 0; i < 3; i++) s = step(s, emptyInput(), l.ctx).state;
    expect(s.switches["hit" as never]).toBe(true);
  });

  it("滑っている間は歩数を数えず、止まった所で 1 歩として数える（ランダムエンカウント）", () => {
    const project = battleProject();
    const { maps } = loadFixtureProject("minimal");
    const base = structuredClone(maps["map_start" as never]!) as MapData;
    const ground = base.layers.find((l) => l.name === "ground")!.tiles as number[];
    for (const [x] of row(2, 3, 8)) ground[2 * base.width + x] = ICE;
    const map: MapData = { ...base, events: {}, encounters: [{ troop: "tr_slime" as never, weight: 1 }], encounterStep: 999 };
    const tileset = project.tilesets[map.tileset]!;
    (tileset as { passage: number[] }).passage[ICE] = 15;
    (tileset as { ice?: number[] }).ice = [ICE];
    const ctx = createCtx(createProjectView(project, { ...maps, ["map_start" as never]: map }));
    const s = walk(initialState(ctx, "s"), ctx, "right");
    expect(at(s)).toEqual([8, 2]);
    expect(s.map.encounterSteps).toBe(1);
  });
});

describe("押せる岩（pushable）", () => {
  it("突き当たると 1 タイル押せて、プレイヤーも 1 タイル進む", () => {
    const l = setup([], [rock("rock", 3, 2)]);
    const s = walk(start(l), l.ctx, "right");
    expect(evAt(s, "rock")).toEqual([4, 2]);
    expect(at(s)).toEqual([3, 2]);
    expect(evAt(walk(s, l.ctx, "right"), "rock")).toEqual([5, 2]);
  });

  it("岩の向きは変わらず、プレイヤーは押した向きを向く", () => {
    const l = setup([], [rock("rock", 3, 2)]);
    const s = walk(start(l), l.ctx, "right");
    expect(s.map.events["rock" as never]!.direction).toBe("down");
    expect(s.map.player.direction).toBe("right");
  });

  it("岩の先が壁・別のイベント・マップの外のときは動かない", () => {
    const wall = setup([], [rock("rock", 3, 2)], [[4, 2]]);
    let s = walk(start(wall), wall.ctx, "right");
    expect(evAt(s, "rock")).toEqual([3, 2]);
    expect(at(s)).toEqual([2, 2]);

    const other = setup([], [rock("rock", 3, 2), event("stone", 4, 2, page({ graphic: { asset: "a" as never, index: 1, direction: "down" } }))]);
    s = walk(start(other), other.ctx, "right");
    expect(evAt(s, "rock")).toEqual([3, 2]);

    const edge = setup([], [rock("rock", 1, 2)]);
    s = walk(start(edge), edge.ctx, "left");
    s = walk(s, edge.ctx, "left");
    expect(evAt(s, "rock")).toEqual([1, 2]);
  });

  it("2 つ並んだ岩は押せない（先の岩にさえぎられる）", () => {
    const l = setup([], [rock("a", 3, 2), rock("b", 4, 2)]);
    const s = walk(start(l), l.ctx, "right");
    expect(evAt(s, "a")).toEqual([3, 2]);
    expect(evAt(s, "b")).toEqual([4, 2]);
  });

  it("pushable でないイベントは押せない。有効なページが pushable のときだけ押せる", () => {
    const plain = setup([], [event("stone", 3, 2, page({ graphic: { asset: "a" as never, index: 0, direction: "down" } }))]);
    expect(evAt(walk(start(plain), plain.ctx, "right"), "stone")).toEqual([3, 2]);

    const gated = setup([], [event("rock", 3, 2, page({ pushable: true, conditions: [{ kind: "switch", id: "free" as never, value: true }] }), page({ conditions: [{ kind: "switch", id: "free" as never, value: false }] }))]);
    expect(evAt(walk(start(gated), gated.ctx, "right"), "rock")).toEqual([3, 2]);
  });

  it("通れるイベント（through）や、通常より下のイベントは押さない", () => {
    const l = setup([], [event("floor", 3, 2, page({ pushable: true, priority: "below", through: true }))]);
    const s = walk(start(l), l.ctx, "right");
    expect(evAt(s, "floor")).toEqual([3, 2]);
    expect(at(s)).toEqual([3, 2]); // 通れるので、ふつうに上に乗る
  });

  it("岩の先に、触れる・話しかけると何かが起こるイベント（階段・台座・扉）があるときは押せない。仕掛けの感知用のイベントなら押せる", () => {
    const stairs = event("stairs", 4, 2, page({ trigger: "touch", priority: "below", through: true }));
    let l = setup([], [rock("rock", 3, 2), stairs]);
    expect(evAt(walk(start(l), l.ctx, "right"), "rock")).toEqual([3, 2]);
    const pedestal = event("pedestal", 4, 2, page({ trigger: "action", priority: "below", through: true }));
    l = setup([], [rock("rock", 3, 2), pedestal]);
    expect(evAt(walk(start(l), l.ctx, "right"), "rock")).toEqual([3, 2]);
    const plate = event("plate", 4, 2, page({ trigger: "parallel", priority: "below", through: true }));
    l = setup([], [rock("rock", 3, 2), plate]);
    expect(evAt(walk(start(l), l.ctx, "right"), "rock")).toEqual([4, 2]);
  });

  it("氷の上の岩を押すと、プレイヤーは氷に着くが、岩に突き当たってすぐ止まる", () => {
    const l = setup(row(2, 3, 7), [rock("rock", 3, 2)]);
    const s = walk(start(l), l.ctx, "right");
    expect(evAt(s, "rock")).toEqual([4, 2]);
    expect(at(s)).toEqual([3, 2]);
  });

  it("岩は滑る床で止まる位置の目印になる：岩の手前で滑りが止まる", () => {
    const l = setup(row(2, 3, 8), [rock("rock", 7, 2)]);
    const s = walk(start(l), l.ctx, "right");
    expect(at(s)).toEqual([6, 2]);
    expect(evAt(s, "rock")).toEqual([7, 2]);
  });
});

describe("evx / evy（イベントの位置を式で読む）", () => {
  const flag = (expr: string): MapEvent =>
    event("probe", 8, 6, page({ trigger: "autorun", through: true, priority: "below", commands: [cmd("ConditionalBranch", { condition: expr }), cmd("ControlSwitches", { ids: ["yes"], value: true }, 1), cmd("EndBranch")] }));

  it("イベントの現在位置と比べられる。居ないイベントは -1", () => {
    const hit = (expr: string): boolean => {
      const l = setup([], [rock("rock", 3, 2), flag(expr)]);
      let s = start(l);
      for (let i = 0; i < 5; i++) s = step(s, emptyInput(), l.ctx).state;
      return s.switches["yes" as never] === true;
    };
    expect(hit('evx("rock") == 3 && evy("rock") == 2')).toBe(true);
    expect(hit('evx("rock") == 4')).toBe(false);
    expect(hit('evx("nobody") == -1 && evy("nobody") == -1')).toBe(true);
  });

  it("押した岩の新しい位置が読める", () => {
    const l = setup([], [rock("rock", 3, 2)]);
    const s = walk(start(l), l.ctx, "right");
    expect(evAt(s, "rock")).toEqual([4, 2]);
  });
});

describe("SetEventLocation", () => {
  const mover = (params: Record<string, unknown>): MapEvent =>
    event("lever", 8, 6, page({ trigger: "autorun", through: true, priority: "below", commands: [cmd("SetEventLocation", params), cmd("ControlSwitches", { ids: ["done"], value: true })] }));
  const run = (loaded: Loaded, n = 5): GameState => {
    let s = start(loaded);
    for (let i = 0; i < n; i++) s = step(s, emptyInput(), loaded.ctx).state;
    return s;
  };

  it("イベントを (x, y) へ瞬間移動する（向きは retain なら変えない）", () => {
    const l = setup([], [rock("rock", 3, 2), mover({ target: "rock", x: 6, y: 4 })]);
    const s = run(l);
    expect(evAt(s, "rock")).toEqual([6, 4]);
    expect(s.map.events["rock" as never]!.moving).toBe(false);
    expect(s.map.events["rock" as never]!.realX).toBe(6);
    expect(s.map.events["rock" as never]!.direction).toBe("down");
  });

  it("dir を指定すると向きも変わる。target 省略は、このコマンドを実行しているイベント", () => {
    const l = setup([], [mover({ x: 5, y: 5, dir: "up" })]);
    const s = run(l);
    expect(evAt(s, "lever")).toEqual([5, 5]);
    expect(s.map.events["lever" as never]!.direction).toBe("up");
  });

  it("居ないイベント・マップの外は警告してスキップする（あとのコマンドは続く）", () => {
    for (const params of [{ target: "nobody", x: 1, y: 1 }, { target: "rock", x: 99, y: 1 }]) {
      const l = setup([], [rock("rock", 3, 2), mover(params)]);
      const out = step(start(l), emptyInput(), l.ctx);
      const s = run(l);
      expect(evAt(s, "rock")).toEqual([3, 2]);
      expect(s.switches["done" as never]).toBe(true);
      void out;
    }
  });
});
