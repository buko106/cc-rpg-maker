import type { Direction, EventPage, MapEvent, MoveRoute } from "@rpg/schema";
import { cmd, loadFixtureProject } from "@rpg/test-utils";
import { describe, expect, it } from "vitest";
import { emptyInput, inputFrame } from "../input.js";
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
const route = (steps: MoveRoute["steps"], o: Partial<MoveRoute> = {}): MoveRoute => ({ repeat: false, skippable: false, steps, ...o });

function frames(state: GameState, n: number, ctx: Loaded["ctx"]): GameState {
  let s = state;
  for (let i = 0; i < n; i++) s = step(s, emptyInput(), ctx).state;
  return s;
}

/** 見えたら switch「seen」を入れる見張り。 */
const guard = (x: number, y: number, dir: Direction, o: Partial<EventPage> = {}): MapEvent =>
  event("guard", x, y, page({ trigger: "eventSight", graphic: { asset: "a" as never, index: 0, direction: dir }, commands: [cmd("ControlSwitches", { ids: ["seen"], value: true })], ...o }));

const seen = (loaded: Loaded, n = 10): boolean => frames(initialState(loaded.ctx, "s"), n, loaded.ctx).switches["seen" as never] === true;

describe("視界（eventSight）", () => {
  it("向いている方向の、視界の長さ（既定 4）以内にプレイヤーが居ると、そのページが始まる", () => {
    expect(seen(setup([guard(6, 2, "left")]))).toBe(true);
    expect(seen(setup([guard(3, 2, "left")]))).toBe(true);
    expect(seen(setup([guard(2, 6, "up")]))).toBe(true);
  });

  it("視界の外・向きが違うときは始まらない", () => {
    expect(seen(setup([guard(7, 2, "left")]))).toBe(false); // 5 タイル先は既定の視界の外
    expect(seen(setup([guard(6, 2, "right")]))).toBe(false);
    expect(seen(setup([guard(6, 3, "left")]))).toBe(false);
  });

  it("sightRange で視界の長さを変えられる", () => {
    expect(seen(setup([guard(7, 2, "left", { sightRange: 5 })]))).toBe(true);
    expect(seen(setup([guard(6, 2, "left", { sightRange: 3 })]))).toBe(false);
  });

  it("通れない壁・通れないイベントが間にあるとさえぎられる（通れるイベントは見通せる）", () => {
    expect(seen(setup([guard(6, 2, "left")], [[4, 2]]))).toBe(false);
    const block = event("block", 4, 2, page({ graphic: { asset: "a" as never, index: 1, direction: "down" } }));
    expect(seen(setup([guard(6, 2, "left"), block]))).toBe(false);
    const thin = event("thin", 4, 2, page({ through: true }));
    expect(seen(setup([guard(6, 2, "left"), thin]))).toBe(true);
    // 壁の手前で向きを変えると見える（壁は視界の向き側にあるときだけさえぎる）
    expect(seen(setup([guard(6, 1, "left")], [[4, 2]]))).toBe(false);
  });

  it("through の見張りでも、視界は壁を抜けない", () => {
    expect(seen(setup([guard(6, 2, "left", { through: true })], [[4, 2]]))).toBe(false);
  });

  it("ページが切り替わって視界を持たなくなると、もう見ない（見つかったあとの警戒状態）", () => {
    const alert = cmd("ControlSwitches", { ids: ["alert"], value: true });
    const watcher = event(
      "guard", 6, 2,
      page({ conditions: [{ kind: "switch", id: "alert" as never, value: false }], trigger: "eventSight", graphic: { asset: "a" as never, index: 0, direction: "left" }, commands: [alert] }),
      page({ conditions: [{ kind: "switch", id: "alert" as never, value: true }], trigger: "action", commands: [cmd("ControlSwitches", { ids: ["again"], value: true })] }),
    );
    const { ctx } = setup([watcher]);
    const s = frames(initialState(ctx, "s"), 60, ctx);
    expect(s.switches["alert" as never]).toBe(true);
    expect(s.switches["again" as never]).toBeUndefined();
  });

  it("メッセージ表示中や通常のイベントの実行中は始まらず、終わったあとも見えていれば始まる", () => {
    const talk = event("talker", 8, 6, page({ trigger: "autorun", conditions: [{ kind: "switch", id: "done" as never, value: false }], commands: [cmd("ShowText", { text: "やあ" }), cmd("ControlSwitches", { ids: ["done"], value: true })] }));
    const { ctx } = setup([talk, guard(6, 2, "left")]);
    let s = frames(initialState(ctx, "s"), 2, ctx);
    expect(s.message.open).toBe(true);
    expect(s.switches["seen" as never]).toBeUndefined();
    s = frames(s, 200, ctx); // メッセージは決定ボタンが無いと閉じない
    expect(s.switches["seen" as never]).toBeUndefined();
    for (let i = 0; i < 30; i++) s = step(s, inputFrame([], i % 2 === 0 ? ["ok"] : []), ctx).state;
    expect(s.message.open).toBe(false);
    expect(s.switches["seen" as never]).toBe(true);
  });

  it("視界を持つイベントは、プレイヤーから触れても始まる（eventTouch と同じ）", () => {
    // 背を向けた見張りに、プレイヤーが突き当たる
    const { ctx } = setup([guard(2, 3, "down")]);
    let s = initialState(ctx, "s");
    for (let i = 0; i < 20; i++) s = step(s, inputFrame(["down"]), ctx).state;
    expect(s.switches["seen" as never]).toBe(true);
  });
});

describe("移動ルートの chase（道を探して追う）", () => {
  const chaser = (x: number, y: number, dir: "toward" | "chase") =>
    event("npc", x, y, page({ moveRoute: route([{ kind: "move", dir }, { kind: "wait", frames: 4 }], { repeat: true, skippable: true }) }));
  // x = 4 の壁（y = 1..5）。通れるのは y = 6 の隙間だけ
  const WALL: [number, number][] = [1, 2, 3, 4, 5].map((y) => [4, y]);
  const pos = (s: GameState): { x: number; y: number } => ({ x: s.map.events["npc" as never]!.x, y: s.map.events["npc" as never]!.y });

  it("toward は壁に突き当たって動けないが、chase は隙間を回ってプレイヤーに近づく", () => {
    const toward = setup([chaser(6, 2, "toward")], WALL);
    const t = frames(initialState(toward.ctx, "s"), 400, toward.ctx);
    expect(pos(t).x).toBeGreaterThan(4);
    const chase = setup([chaser(6, 2, "chase")], WALL);
    const c = frames(initialState(chase.ctx, "s"), 400, chase.ctx);
    expect(pos(c).x).toBeLessThan(4);
  });

  it("chase は、プレイヤーのタイルへは入らずに隣まで来て止まる", () => {
    const { ctx } = setup([chaser(6, 2, "chase")], WALL);
    const c = frames(initialState(ctx, "s"), 800, ctx);
    const { x, y } = pos(c);
    expect(Math.abs(x - 2) + Math.abs(y - 2)).toBe(1);
  });

  it("たどり着けないとき（壁で囲まれている）は toward と同じに動き、落ちない", () => {
    const enclosed: [number, number][] = [[3, 1], [3, 2], [3, 3], [1, 3], [2, 3]];
    const { ctx } = setup([chaser(6, 2, "chase")], enclosed);
    const c = frames(initialState(ctx, "s"), 400, ctx);
    expect(pos(c)).toEqual({ x: 4, y: 2 });
  });

  it("通れないイベントにふさがれた道は避けて、別の道を探す", () => {
    const door = event("door", 4, 6, page({ graphic: { asset: "a" as never, index: 1, direction: "down" } }));
    const { ctx } = setup([chaser(6, 2, "chase"), door], WALL);
    const c = frames(initialState(ctx, "s"), 400, ctx);
    expect(pos(c).x).toBeGreaterThan(4); // どこも通れないので壁の向こうへは行けない
  });
});
