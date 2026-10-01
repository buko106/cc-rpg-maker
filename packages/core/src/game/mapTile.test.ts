import type { EventPage, MapEvent } from "@rpg/schema";
import { cmd, loadFixtureProject, press } from "@rpg/test-utils";
import { describe, expect, it } from "vitest";
import { emptyInput } from "../input.js";
import { currentMap, tileKey, withTileChanges } from "../map/index.js";
import { fromSnapshot, toSnapshot } from "../snapshot.js";
import type { SaveSnapshot } from "../snapshot.js";
import type { GameState } from "../state.js";
import { initialState, step } from "./index.js";

type Loaded = ReturnType<typeof loadFixtureProject>;

const ICE = 4;
const WALL = 2;
const page = (o: Partial<EventPage>): EventPage => ({ conditions: [], trigger: "action", through: false, priority: "same", commands: [], ...o });
const event = (id: string, x: number, y: number, ...pages: EventPage[]): MapEvent => ({ id: id as never, name: id, x, y, pages });
/** 自動実行で `commands` を一度だけ実行し、`done` スイッチが入ったらこのイベントのページは無効になる（何も起こさない）。 */
const once = (...commands: ReturnType<typeof cmd>[]): MapEvent =>
  event("lever", 8, 6, page({ trigger: "autorun", through: true, priority: "below", conditions: [{ kind: "switch", id: "done" as never, value: false }], commands: [...commands, cmd("ControlSwitches", { ids: ["done"], value: true })] }));

/** minimal（10×8、内側 x 1..8・y 1..6、プレイヤーは (2, 2)。壁は walls レイヤ（層 1）のタイル 2）。 */
function setup(events: MapEvent[]): Loaded {
  const loaded = loadFixtureProject("minimal");
  const map = loaded.maps["map_start" as never]!;
  (map as { events: unknown }).events = Object.fromEntries(events.map((e) => [e.id, e]));
  const tileset = loaded.project.tilesets["ts_basic" as never]!;
  (tileset as { passage: number[] }).passage[ICE] = 15;
  (tileset as { ice?: number[] }).ice = [ICE];
  return loaded;
}
const run = (l: Loaded, n = 5): GameState => {
  let s = initialState(l.ctx, "s");
  for (let i = 0; i < n; i++) s = step(s, emptyInput(), l.ctx).state;
  return s;
};
function walk(l: Loaded, state: GameState, dir: "right" | "left" | "up" | "down"): GameState {
  let s = step(state, press(dir), l.ctx).state;
  for (let i = 0; i < 400 && s.scene.kind === "map" && s.map.player.moving; i++) s = step(s, emptyInput(), l.ctx).state;
  return s;
}
const at = (s: GameState): [number, number] => [s.map.player.x, s.map.player.y];
const wallAt = (l: Loaded, x: number, y: number): number => l.maps["map_start" as never]!.layers[1]!.tiles[y * 10 + x] as number;

describe("ChangeMapTile", () => {
  it("壁のタイルを空にすると、そこを通れるようになる", () => {
    const before = setup([]); // 書き換える前は、(3, 2) に壁がある
    before.maps["map_start" as never]!.layers[1]!.tiles[2 * 10 + 3] = WALL;
    expect(at(walk(before, run(before), "right"))).toEqual([2, 2]);
    const l = setup([once(cmd("ChangeMapTile", { layer: 1, x: 3, y: 2, tile: 0 }))]);
    l.maps["map_start" as never]!.layers[1]!.tiles[2 * 10 + 3] = WALL;
    expect(at(walk(l, run(l), "right"))).toEqual([3, 2]);
  });

  it("空いていた所へ壁を置くと、通れなくなる。もとの MapData は変わらない", () => {
    const l = setup([once(cmd("ChangeMapTile", { layer: 1, x: 3, y: 2, tile: WALL }))]);
    const s = run(l);
    expect(at(walk(l, s, "right"))).toEqual([2, 2]);
    expect(wallAt(l, 3, 2)).toBe(0);
    expect(currentMap(l.ctx.project, s)!.layers[1]!.tiles[2 * 10 + 3]).toBe(WALL);
  });

  it("床を氷のタイルにすると、そこで滑る", () => {
    const l = setup([once(cmd("ChangeMapTile", { layer: 0, x: 3, y: 2, width: 3, height: 1, tile: ICE }))]);
    expect(at(walk(l, run(l), "right"))).toEqual([6, 2]); // (3..5, 2) が氷 → (6, 2) で止まる
  });

  it("範囲（width × height）を一度に書き換える", () => {
    const l = setup([once(cmd("ChangeMapTile", { layer: 0, x: 2, y: 3, width: 3, height: 2, tile: ICE }))]);
    const tiles = currentMap(l.ctx.project, run(l))!.layers[0]!.tiles;
    const ice = [...tiles].flatMap((t, i) => (t === ICE ? [[i % 10, Math.floor(i / 10)]] : []));
    expect(ice).toEqual([[2, 3], [3, 3], [4, 3], [2, 4], [3, 4], [4, 4]]);
  });

  it("もう一度書き換えると戻せる", () => {
    const l = setup([once(cmd("ChangeMapTile", { layer: 1, x: 3, y: 2, tile: WALL }), cmd("ChangeMapTile", { layer: 1, x: 3, y: 2, tile: 0 }))]);
    expect(at(walk(l, run(l), "right"))).toEqual([3, 2]);
  });

  it("書き換えはセーブに残り、ロードしても反映される（セーブの検証も通る）", () => {
    const l = setup([once(cmd("ChangeMapTile", { layer: 1, x: 3, y: 2, tile: WALL }))]);
    const s = run(l);
    const snap = JSON.parse(JSON.stringify(toSnapshot(s, { projectId: "minimal", projectHash: "h", savedAt: "2026-01-01T00:00:00Z" }))) as SaveSnapshot;
    expect(snap.state.mapTiles).toEqual({ map_start: { [tileKey(1, 3, 2)]: WALL } });
    const loaded = fromSnapshot(snap, l.ctx);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(at(walk(l, loaded.value, "right"))).toEqual([2, 2]);
  });

  it("書き換えが無いセーブには mapTiles が無い（既存のセーブ・リプレイのハッシュは変わらない）", () => {
    const l = setup([]);
    expect("mapTiles" in run(l)).toBe(false);
  });

  it("別のマップは、まだ読み込んでいなくても書き換えられる（入ったときに反映される）", () => {
    const l = setup([once(cmd("ChangeMapTile", { map: "map_start", layer: 1, x: 3, y: 2, tile: WALL }))]);
    expect(run(l).mapTiles).toEqual({ map_start: { [tileKey(1, 3, 2)]: WALL } });
  });

  it("存在しないマップ・レイヤは警告してスキップし、範囲外にはみ出した分は切り詰める", () => {
    const l = setup([once(cmd("ChangeMapTile", { map: "map_nowhere", x: 0, y: 0, tile: 1 }), cmd("ChangeMapTile", { layer: 9, x: 0, y: 0, tile: 1 }), cmd("ChangeMapTile", { layer: 0, x: 8, y: 6, width: 5, height: 5, tile: ICE }))]);
    let s = initialState(l.ctx, "s");
    const warnings: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = step(s, emptyInput(), l.ctx);
      s = r.state;
      for (const e of r.effects) if (e.kind === "log" && e.level === "warn") warnings.push(e.message);
    }
    expect(warnings).toHaveLength(3);
    expect(Object.keys(s.mapTiles?.["map_start" as never] ?? {}).sort()).toEqual([tileKey(0, 8, 6), tileKey(0, 9, 6), tileKey(0, 8, 7), tileKey(0, 9, 7)].sort());
  });
});

describe("withTileChanges", () => {
  const { maps } = loadFixtureProject("minimal");
  const map = maps["map_start" as never]!;

  it("書き換えが無ければ、同じ MapData をそのまま返す", () => {
    expect(withTileChanges(map, undefined)).toBe(map);
    expect(withTileChanges(map, {})).toBe(map);
  });

  it("同じ書き換えには同じ結果を返し（毎フレーム作り直さない）、範囲外・壊れたキーは無視する", () => {
    const changes = { [tileKey(0, 1, 1)]: 7, [tileKey(5, 1, 1)]: 7, [tileKey(0, 99, 1)]: 7, bogus: 7 };
    const a = withTileChanges(map, changes);
    expect(withTileChanges(map, changes)).toBe(a);
    expect(a.layers[0]!.tiles[1 * 10 + 1]).toBe(7);
    expect(a.layers).toHaveLength(map.layers.length);
    expect(map.layers[0]!.tiles[1 * 10 + 1]).not.toBe(7);
  });
});
