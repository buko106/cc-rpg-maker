import type { Direction, EventPage, MapEvent } from "@rpg/schema";
import { cmd, loadFixtureProject, press } from "@rpg/test-utils";
import { describe, expect, it } from "vitest";
import { emptyInput } from "../input.js";
import type { GameState } from "../state.js";
import { initialState, step } from "./index.js";

type Loaded = ReturnType<typeof loadFixtureProject>;

/** ベルトのタイル（右・左・下・上）。 */
const BELT: Record<Direction, number> = { right: 4, left: 5, down: 6, up: 7 };
const ICE = 8;
type Cell = [number, number, Direction];

/** minimal（内側 x 1..8・y 1..6、プレイヤーは (2, 2)）に、ベルトのタイルとイベントを置く。 */
function setup(belts: Cell[], events: MapEvent[] = [], walls: [number, number][] = [], opts: { ice?: [number, number][]; conveyor?: boolean } = {}): Loaded {
  const loaded = loadFixtureProject("minimal");
  const map = loaded.maps["map_start" as never]!;
  (map as { events: unknown }).events = Object.fromEntries(events.map((e) => [e.id, e]));
  const ground = map.layers.find((l) => l.name === "ground")!.tiles as number[];
  for (const [x, y, d] of belts) ground[y * map.width + x] = BELT[d];
  for (const [x, y] of opts.ice ?? []) ground[y * map.width + x] = ICE;
  const wallLayer = map.layers.find((l) => l.name === "walls")!.tiles as number[];
  for (const [x, y] of walls) wallLayer[y * map.width + x] = 2;
  const tileset = loaded.project.tilesets["ts_basic" as never]!;
  for (const id of [...Object.values(BELT), ICE]) (tileset as { passage: number[] }).passage[id] = 15;
  if (opts.conveyor !== false) (tileset as { conveyor?: Record<string, Direction> }).conveyor = Object.fromEntries(Object.entries(BELT).map(([d, id]) => [String(id), d as Direction]));
  (tileset as { ice?: number[] }).ice = [ICE];
  return loaded;
}
const page = (o: Partial<EventPage>): EventPage => ({ conditions: [], trigger: "action", through: false, priority: "same", commands: [], ...o });
const event = (id: string, x: number, y: number, ...pages: EventPage[]): MapEvent => ({ id: id as never, name: id, x, y, pages });
const box = (id: string, x: number, y: number): MapEvent => event(id, x, y, page({ pushable: true, graphic: { asset: "a" as never, index: 0, direction: "down" } }));
const row = (y: number, from: number, to: number, d: Direction): Cell[] => Array.from({ length: to - from + 1 }, (_, i) => [from + i, y, d] as Cell);
const col = (x: number, from: number, to: number, d: Direction): Cell[] => Array.from({ length: to - from + 1 }, (_, i) => [x, from + i, d] as Cell);

/** 1 回押して、プレイヤーも箱も止まるまで進める。 */
function walk(state: GameState, ctx: Loaded["ctx"], dir: Direction): GameState {
  let s = step(state, press(dir), ctx).state;
  return settle(s, ctx);
}
function settle(state: GameState, ctx: Loaded["ctx"]): GameState {
  let s = state;
  for (let i = 0; i < 600 && s.scene.kind === "map" && (s.map.player.moving || Object.values(s.map.events).some((e) => e.moving)); i++) s = step(s, emptyInput(), ctx).state;
  return s;
}
const at = (s: GameState): [number, number] => [s.map.player.x, s.map.player.y];
const evAt = (s: GameState, id: string): [number, number] => [s.map.events[id as never]!.x, s.map.events[id as never]!.y];
function start(loaded: Loaded): GameState {
  return step(initialState(loaded.ctx, "s"), emptyInput(), loaded.ctx).state;
}

describe("ベルトコンベア（プレイヤー）", () => {
  it("ベルトに着くと、ベルトの向きに運ばれ、ベルトを出た最初のタイルで止まる", () => {
    const l = setup(row(2, 3, 5, "right"));
    expect(at(walk(start(l), l.ctx, "right"))).toEqual([6, 2]);
  });

  it("入った向きと関係なく、ベルトの向きに運ばれる（向きは変わらない）", () => {
    // (2, 3) から下へ歩いて (2, 4) のベルト（右向き）に着く → 右へ運ばれる
    const l = setup(row(4, 2, 4, "right"));
    let s = walk(start(l), l.ctx, "down");
    s = walk(s, l.ctx, "down");
    expect(at(s)).toEqual([5, 4]);
    expect(s.map.player.direction).toBe("down");
  });

  it("壁・通れないイベントの手前で止まる。ベルトの上で止まったときも、運ばれる先に障害物があればそのまま", () => {
    const wall = setup(row(2, 3, 8, "right"));
    expect(at(walk(start(wall), wall.ctx, "right"))).toEqual([8, 2]);
    const stone = setup(row(2, 3, 8, "right"), [event("stone", 6, 2, page({ graphic: { asset: "a" as never, index: 0, direction: "down" } }))]);
    expect(at(walk(start(stone), stone.ctx, "right"))).toEqual([5, 2]);
  });

  it("運ばれている間は操作できず、止まったあとはまた歩ける", () => {
    const l = setup(row(2, 3, 7, "right"));
    let s = step(start(l), press("right"), l.ctx).state;
    for (let i = 0; i < 30; i++) s = step(s, press("down"), l.ctx).state;
    expect(s.map.player.y).toBe(2);
    expect(s.map.player.x).toBeGreaterThan(2);
    s = settle(s, l.ctx);
    expect(at(s)).toEqual([8, 2]);
    expect(at(walk(s, l.ctx, "down"))).toEqual([8, 3]);
  });

  it("足元に接触イベント（階段・出口）のあるベルトの上では、そこで止まってイベントが始まる", () => {
    const touch = event("exit", 5, 2, page({ trigger: "touch", priority: "below", through: true, commands: [cmd("ControlSwitches", { ids: ["hit"], value: true })] }));
    const l = setup(row(2, 3, 8, "right"), [touch]);
    let s = walk(start(l), l.ctx, "right");
    expect(at(s)).toEqual([5, 2]);
    for (let i = 0; i < 3; i++) s = step(s, emptyInput(), l.ctx).state;
    expect(s.switches["hit" as never]).toBe(true);
  });

  it("ベルトからベルトへ乗りかえると、向きが変わって運ばれる", () => {
    const l = setup([...row(2, 3, 5, "right"), ...col(6, 2, 4, "down")]);
    expect(at(walk(start(l), l.ctx, "right"))).toEqual([6, 5]);
  });

  it("上のレイヤのベルトの向きが勝つ", () => {
    const l = setup(row(2, 3, 5, "right"));
    const map = l.maps["map_start" as never]!;
    const top = map.layers.find((m) => m.name === "walls")!.tiles as number[];
    top[2 * map.width + 4] = BELT.down; // (4, 2) は、下のレイヤが右向き、上のレイヤが下向き
    expect(at(walk(start(l), l.ctx, "right"))).toEqual([4, 3]);
  });

  it("輪になったベルトでは止まれない（作る側が避ける）。運ばれ続けても、輪の中で状態が壊れない", () => {
    const ring: Cell[] = [[3, 2, "right"], [4, 2, "down"], [4, 3, "left"], [3, 3, "up"]];
    const l = setup(ring);
    let s = step(start(l), press("right"), l.ctx).state;
    for (let i = 0; i < 300; i++) {
      s = step(s, press("left"), l.ctx).state;
      expect(ring.some(([x, y]) => x === s.map.player.x && y === s.map.player.y)).toBe(true);
    }
  });

  it("ベルトを使わないタイルセットでは何も変わらない（conveyor が無いと、ベルトのタイルは普通の床）", () => {
    const l = setup(row(2, 3, 5, "right"), [], [], { conveyor: false });
    expect(at(walk(start(l), l.ctx, "right"))).toEqual([3, 2]);
  });

  it("氷とベルトが重なったら、ベルトが先に効く", () => {
    const l = setup([], [], [], { ice: [[3, 2], [4, 2], [5, 2]] });
    const map = l.maps["map_start" as never]!;
    const top = map.layers.find((m) => m.name === "walls")!.tiles as number[];
    top[2 * map.width + 3] = BELT.down; // (3, 2) は氷の上に下向きのベルト
    expect(at(walk(start(l), l.ctx, "right"))).toEqual([3, 3]); // 氷なら右へ滑るところを、下へ運ばれる
  });
});

describe("ベルトコンベア（箱）", () => {
  it("プレイヤーが歩くたびに、ベルトの上の箱が 1 タイルずつ運ばれる", () => {
    const l = setup(row(5, 3, 7, "right"), [box("b", 3, 5)]);
    let s = start(l); // プレイヤーは (2, 2)
    s = walk(s, l.ctx, "down");
    expect(evAt(s, "b")).toEqual([4, 5]);
    s = walk(s, l.ctx, "right");
    expect(evAt(s, "b")).toEqual([5, 5]);
    s = walk(s, l.ctx, "left");
    expect(evAt(s, "b")).toEqual([6, 5]);
    s = walk(s, l.ctx, "right");
    s = walk(s, l.ctx, "left");
    s = walk(s, l.ctx, "right");
    expect(evAt(s, "b")).toEqual([8, 5]); // 壁の手前で止まる
  });

  it("歩けなかった手（壁に突き当たる）では箱は運ばれない", () => {
    const l = setup(row(5, 3, 7, "right"), [box("b", 3, 5)]);
    let s = start(l);
    s = walk(s, l.ctx, "up"); // (2, 1) へ歩く：箱は 1 タイル
    expect(evAt(s, "b")).toEqual([4, 5]);
    s = walk(s, l.ctx, "up"); // (2, 0) は壁：向きが変わるだけで、箱は動かない
    s = walk(s, l.ctx, "up");
    expect(at(s)).toEqual([2, 1]);
    expect(evAt(s, "b")).toEqual([4, 5]);
  });

  it("ベルトでない床の箱は動かない。運ばれるのは pushable な箱だけ", () => {
    const l = setup(row(5, 3, 7, "right"), [box("b", 3, 4), event("npc", 4, 5, page({ graphic: { asset: "a" as never, index: 0, direction: "down" } }))]);
    const s = walk(start(l), l.ctx, "down");
    expect(evAt(s, "b")).toEqual([3, 4]);
    expect(evAt(s, "npc")).toEqual([4, 5]);
  });

  it("運ばれた先が壁・通れないイベントなら、その場に残る", () => {
    const l = setup(row(5, 3, 7, "right"), [box("b", 3, 5), event("stone", 4, 5, page({ graphic: { asset: "a" as never, index: 0, direction: "down" } }))]);
    expect(evAt(walk(start(l), l.ctx, "down"), "b")).toEqual([3, 5]);
  });

  it("触れる・話しかけると何かが起こるイベント（階段・台座・出荷口の扉）のタイルへは運ばれない", () => {
    const stairs = event("stairs", 4, 5, page({ trigger: "touch", priority: "below", through: true }));
    const l = setup(row(5, 3, 7, "right"), [box("b", 3, 5), stairs]);
    expect(evAt(walk(start(l), l.ctx, "down"), "b")).toEqual([3, 5]);
    const plate = event("plate", 4, 5, page({ trigger: "parallel", priority: "below", through: true }));
    const l2 = setup(row(5, 3, 7, "right"), [box("b", 3, 5), plate]);
    expect(evAt(walk(start(l2), l2.ctx, "down"), "b")).toEqual([4, 5]);
  });

  it("プレイヤーのいるタイルへは運ばれない", () => {
    const l = setup([[4, 2, "left"], [3, 2, "left"]], [box("b", 4, 2)]);
    // プレイヤーは (2, 2)。箱は (4, 2) → (3, 2) → (2, 2) へは入れない
    let s = walk(start(l), l.ctx, "down"); // 歩くと (2, 3)。箱は (3, 2)
    expect(evAt(s, "b")).toEqual([3, 2]);
    s = walk(s, l.ctx, "up"); // プレイヤーが (2, 2) に戻る。箱の行き先は (2, 2) → 動けない
    expect(at(s)).toEqual([2, 2]);
    expect(evAt(s, "b")).toEqual([3, 2]);
  });

  it("押した箱は、その手では運ばれない。次の手から運ばれる", () => {
    const l = setup(row(2, 4, 8, "right"), [box("b", 3, 2)]);
    let s = walk(start(l), l.ctx, "right"); // 箱を (3, 2) から (4, 2) へ押す。ベルトの上だが、この手では運ばれない
    expect(evAt(s, "b")).toEqual([4, 2]);
    expect(at(s)).toEqual([3, 2]);
    s = walk(s, l.ctx, "down");
    expect(evAt(s, "b")).toEqual([5, 2]);
  });

  it("ほかの箱を押す手でも、ベルトの上の箱は運ばれる", () => {
    const l = setup(row(5, 4, 8, "right"), [box("belt", 4, 5), box("push", 3, 2)]);
    const s = walk(start(l), l.ctx, "right");
    expect(evAt(s, "push")).toEqual([4, 2]);
    expect(evAt(s, "belt")).toEqual([5, 5]);
  });
});

describe("ベルトコンベア（いっせいに動く）", () => {
  it("プレイヤーと箱が同じベルトに並んで乗ると、そろって運ばれる（箱が前でも後ろでも）", () => {
    const l = setup([...row(2, 3, 6, "right")], [box("b", 5, 2)]);
    // プレイヤー (2, 2) → (3, 2) に着く → 箱は (5, 2) → (6, 2)。プレイヤーは (4, 2)。次は箱 (7, 2)、プレイヤー (5, 2)。…
    const s = walk(start(l), l.ctx, "right");
    expect(evAt(s, "b")).toEqual([7, 2]);
    expect(at(s)).toEqual([6, 2]);
  });

  it("後ろの箱は、前のプレイヤーの行き先をふさがない", () => {
    const l = setup(row(2, 3, 6, "right"), [box("b", 3, 3), event("far", 8, 6, page({ through: true, priority: "below", trigger: "parallel" }))]);
    expect(at(walk(start(l), l.ctx, "right"))).toEqual([7, 2]);
  });

  it("行き先をふさぐものが動けなければ、後ろも動けない", () => {
    // 箱 a (5, 2) は壁 (6, 2) で止まる → 箱 b (4, 2) とプレイヤーも、その後ろで止まる
    const l = setup(row(2, 3, 5, "right"), [box("a", 5, 2), box("b", 4, 2)], [[6, 2]]);
    const s = walk(start(l), l.ctx, "right");
    expect(evAt(s, "a")).toEqual([5, 2]);
    expect(evAt(s, "b")).toEqual([4, 2]);
    expect(at(s)).toEqual([3, 2]);
  });

  it("向かい合うベルトの箱は、場所を入れかえない（どちらも動かない）", () => {
    const l = setup([[4, 5, "right"], [5, 5, "left"]], [box("a", 4, 5), box("b", 5, 5)]);
    const s = walk(start(l), l.ctx, "down");
    expect(evAt(s, "a")).toEqual([4, 5]);
    expect(evAt(s, "b")).toEqual([5, 5]);
  });

  it("輪になったベルトの上の箱は、そろって回る", () => {
    const ring: Cell[] = [[4, 4, "right"], [5, 4, "down"], [5, 5, "left"], [4, 5, "up"]];
    const l = setup(ring, [box("a", 4, 4), box("b", 5, 4), box("c", 5, 5), box("d", 4, 5)]);
    const s = walk(start(l), l.ctx, "down");
    expect([evAt(s, "a"), evAt(s, "b"), evAt(s, "c"), evAt(s, "d")]).toEqual([[5, 4], [5, 5], [4, 5], [4, 4]]);
  });

  it("2 つが同じタイルを目指したら、プレイヤーが先、次にイベントの定義順の早いほう", () => {
    // 箱 a (4, 4) は右、箱 b (5, 3) は下 → どちらも (5, 4) を目指す。定義順の早い a が先に動き、b は残る
    const l = setup([[4, 4, "right"], [5, 3, "down"]], [box("a", 4, 4), box("b", 5, 3)]);
    const s = walk(start(l), l.ctx, "down");
    expect(evAt(s, "a")).toEqual([5, 4]);
    expect(evAt(s, "b")).toEqual([5, 3]);
    const l2 = setup([[4, 4, "right"], [5, 3, "down"]], [box("b", 5, 3), box("a", 4, 4)]);
    const s2 = walk(start(l2), l2.ctx, "down");
    expect(evAt(s2, "a")).toEqual([4, 4]);
    expect(evAt(s2, "b")).toEqual([5, 4]);
  });

  it("プレイヤーが運ばれないとき（壁で止まる）は、箱も運ばれない", () => {
    // プレイヤーは (8, 2) のベルトに着く → 右は壁で動けない → その手では箱も動かない
    const l = setup([...row(2, 3, 8, "right"), ...row(5, 3, 7, "right")], [box("b", 3, 5)]);
    const s = walk(start(l), l.ctx, "right");
    expect(at(s)).toEqual([8, 2]);
    // 歩き出しの 1 歩（(3, 2) へ）と、運ばれる 5 歩（4〜8）で、箱は 6 回運ばれる前に壁で止まる：(3, 5) → (8, 5)
    expect(evAt(s, "b")).toEqual([8, 5]);
  });

  it("プレイヤーと箱は同じ速さで運ばれ、同じフレームに着く（間の距離が変わらない）", () => {
    const l = setup(row(2, 3, 8, "right"), [box("b", 4, 2)]);
    let s = step(start(l), press("right"), l.ctx).state;
    for (let i = 0; i < 45; i++) {
      const ev = s.map.events["b" as never]!;
      expect(ev.moving).toBe(s.map.player.moving);
      expect(ev.realX - s.map.player.realX).toBe(2);
      s = step(s, emptyInput(), l.ctx).state;
    }
  });
});

describe("ベルトコンベア（レバー）", () => {
  it("ChangeMapTile でタイルを入れ替えると、ベルトの向きが変わる", () => {
    const lever = event("lever", 2, 3, page({ trigger: "action", commands: [cmd("ChangeMapTile", { layer: 0, x: 3, y: 2, width: 3, height: 1, tile: BELT.left })] }));
    const l = setup(row(2, 3, 5, "right"), [lever]);
    let s = start(l);
    expect(at(walk(s, l.ctx, "right"))).toEqual([6, 2]);
    s = start(l);
    s = walk(s, l.ctx, "down"); // (2, 3) はレバー（通れない）→ 向きだけ変わる
    expect(at(s)).toEqual([2, 2]);
    s = step(s, press("ok"), l.ctx).state;
    for (let i = 0; i < 10; i++) s = step(s, emptyInput(), l.ctx).state;
    s = walk(s, l.ctx, "right"); // ベルトは左向きになった：(3, 2) に着くと左へ運ばれ、(2, 2) へ戻る
    expect(at(s)).toEqual([2, 2]);
  });
});

describe("ベルトコンベア（ターン制との関係）", () => {
  it("運ばれた歩は、ターン制の手数（turns）に数えない。ベルトに乗る 1 歩だけが 1 手で、ターン制のイベントは 1 歩だけ動く", () => {
    const walker = event("w", 4, 5, page({ graphic: { asset: "a" as never, index: 0, direction: "down" }, moveRoute: { repeat: true, skippable: false, pace: "playerStep", steps: [{ kind: "move", dir: "right" }] } }));
    const l = setup(row(2, 3, 7, "right"), [walker]);
    const s = walk(start(l), l.ctx, "right");
    expect(at(s)).toEqual([8, 2]);
    expect(s.map.turns).toBe(1);
    expect(evAt(s, "w")).toEqual([5, 5]);
  });
});

describe("ベルトコンベア（状態）", () => {
  it("ベルトの無いタイルセットでは、状態にも入力にも何も足さない", () => {
    const l = setup([], [box("b", 3, 2)], [], { conveyor: false });
    const base = walk(start(l), l.ctx, "right");
    expect(Object.keys(base.map).sort()).toEqual(Object.keys(start(l).map).sort());
  });

  it("同じ入力列からは、同じ状態になる", () => {
    const run = (): GameState => {
      const l = setup([...row(2, 3, 5, "right"), ...row(5, 3, 7, "right")], [box("b", 3, 5)]);
      let s = start(l);
      for (const d of ["right", "down", "left", "down", "right"] as Direction[]) s = walk(s, l.ctx, d);
      return s;
    };
    expect(run()).toEqual(run());
  });
});
