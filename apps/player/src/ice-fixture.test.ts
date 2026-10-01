import { describe, expect, it } from "vitest";
import { drive, idleFrames, loadFixtureProject, press, runReplay } from "@rpg/test-utils";
import type { MapData } from "@rpg/schema";

// 氷の神殿のデモ（fixtures/projects/v1/ice。tools/make-ice-demo.mjs が生成する）の約束ごと。
// パズルは、ここに書いた「規則のモデル」で最短の手順を探して、実際のエンジンで 1 手ずつ再生して確かめる
// （モデルの位置とエンジンの位置・岩の位置が、毎手そろうこと）。
const { project, maps, ctx } = loadFixtureProject("ice");
type State = ReturnType<typeof runReplay>["state"];
type Dir = "up" | "down" | "left" | "right";

const ROOMS = ["map_hall", "map_slide", "map_rock1", "map_rock2", "map_orb"];
const mapOf = (id: string): MapData => maps[id as keyof typeof maps]!;
const tileset = Object.values(project.tilesets)[0]!;
const START = { x: 7, y: 8 };
const VEC: Record<Dir, [number, number]> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

// ── 規則のモデル ──────────────────────────────────────────────────────
interface Room {
  w: number;
  h: number;
  /** 壁・柱・動かない通常のイベント（案内人）のタイル。 */
  wall: Set<number>;
  ice: Set<number>;
  rockIds: string[];
  rocks: number[];
  plates: number[];
  door?: number;
  /** 触れる・話しかけると動くイベントのタイル（岩は押せない）。 */
  interactive: Set<number>;
  up?: number;
  down?: number;
}

function modelOf(id: string): Room {
  const map = mapOf(id);
  const w = map.width;
  const room: Room = { w, h: map.height, wall: new Set(), ice: new Set(), rockIds: [], rocks: [], plates: [], interactive: new Set() };
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < w; x++) {
      const tiles = map.layers.map((l) => l.tiles[y * w + x] ?? 0).filter((t) => t !== 0);
      if (tiles.some((t) => tileset.passage[t] === 0)) room.wall.add(y * w + x);
      if (tiles.some((t) => tileset.ice?.includes(t) === true)) room.ice.add(y * w + x);
    }
  }
  for (const ev of Object.values(map.events)) {
    const k = ev.y * w + ev.x;
    const first = ev.pages[0]!;
    if (ev.pages.some((p) => p.pushable === true)) {
      room.rockIds.push(ev.id);
      room.rocks.push(k);
    } else if (ev.id.startsWith("ev_plate_")) room.plates.push(k);
    else if (ev.id === "ev_door") {
      room.door = k;
      room.interactive.add(k);
    } else if (ev.id === "ev_up") {
      room.up = k;
      room.interactive.add(k);
    } else if (ev.id === "ev_down") {
      room.down = k;
      room.interactive.add(k);
    } else if (first.trigger === "action" && first.priority === "below") room.interactive.add(k);
    else if (first.trigger === "action" && first.priority === "same") room.wall.add(k); // 案内人・台座
  }
  return room;
}

interface Node {
  p: number;
  rocks: number[];
  open: boolean;
}
interface Solution {
  moves: Dir[];
  /** 各手のあとの状態（モデル）。 */
  states: Node[];
}

/** プレイヤーが (px, py) から始めて、`goal` のタイルに着く最短の手順（BFS）。 */
function solve(room: Room, start: number, goal: number): Solution | undefined {
  const { w, h } = room;
  const inside = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < w && y < h;
  const key = (n: Node): string => `${n.p}|${n.rocks.join(",")}|${n.open ? 1 : 0}`;
  const blocked = (k: number, n: Node, forRock: boolean): boolean =>
    room.wall.has(k) || (k === room.door && !n.open) || k === room.down || n.rocks.includes(k) || (forRock && room.interactive.has(k));
  const first: Node = { p: start, rocks: [...room.rocks].sort((a, b) => a - b), open: room.plates.length === 0 };
  const prev = new Map<string, { from: string; dir: Dir; node: Node } | null>([[key(first), null]]);
  let queue = [first];
  while (queue.length > 0) {
    const next: Node[] = [];
    for (const n of queue) {
      for (const dir of Object.keys(VEC) as Dir[]) {
        const [dx, dy] = VEC[dir];
        let x = n.p % w;
        let y = Math.floor(n.p / w);
        const tx = x + dx;
        const ty = y + dy;
        if (!inside(tx, ty)) continue;
        let rocks = n.rocks;
        const tk = ty * w + tx;
        if (rocks.includes(tk)) {
          if (!inside(tx + dx, ty + dy)) continue;
          const rk = (ty + dy) * w + tx + dx;
          if (blocked(rk, n, true)) continue;
          rocks = rocks.map((r) => (r === tk ? rk : r)).sort((a, b) => a - b);
        } else if (blocked(tk, n, false)) continue;
        x = tx;
        y = ty;
        // 氷：同じ向きに滑る（岩は押さない）。階段 `>` の上に着いたら、そこで場所移動が始まる（滑りは続かない）
        while (y * w + x !== room.up && room.ice.has(y * w + x)) {
          const nx = x + dx;
          const ny = y + dy;
          if (!inside(nx, ny) || blocked(ny * w + nx, { ...n, rocks }, false)) break;
          x = nx;
          y = ny;
        }
        const open = n.open || room.plates.every((p) => rocks.includes(p));
        const node: Node = { p: y * w + x, rocks, open };
        const k = key(node);
        if (prev.has(k)) continue;
        prev.set(k, { from: key(n), dir, node });
        if (node.p === goal) {
          const moves: Dir[] = [];
          const states: Node[] = [];
          for (let cur: string | undefined = k; cur !== undefined && prev.get(cur) != null; cur = prev.get(cur)!.from) {
            moves.unshift(prev.get(cur)!.dir);
            states.unshift(prev.get(cur)!.node);
          }
          return { moves, states };
        }
        next.push(node);
      }
    }
    queue = next;
  }
  return undefined;
}

// ── エンジンを動かす ──────────────────────────────────────────────────
const busy = (s: State): boolean => s.map.player.moving || s.map.transfer !== undefined || s.interpreters.some((i) => i.mode === "normal");

/** 操作できる状態になるまで進める。メッセージは決定で送り、選択肢は `answers` の順に答える（尽きたら先頭）。 */
function settle(state: State, answers: number[] = []): State {
  let s = state;
  for (let i = 0; i < 1500; i++) {
    if (s.scene.kind !== "map") return s;
    if (s.message.open && s.message.choices !== null) {
      const want = answers.shift() ?? 0;
      s = drive(s, ctx, idleFrames(2)).state;
      while ((s.message.cursor ?? 0) !== want) s = drive(s, ctx, [press("down"), ...idleFrames(1)]).state;
      s = drive(s, ctx, [press("ok"), ...idleFrames(1)]).state;
    } else if (s.message.open) s = drive(s, ctx, [...idleFrames(2), press("ok"), ...idleFrames(1)]).state;
    else if (busy(s)) s = drive(s, ctx, idleFrames(1)).state;
    else return drive(s, ctx, idleFrames(2)).state;
  }
  throw new Error("操作できる状態にならない");
}

const newGame = (seed = "ice"): State => settle(drive(runReplay({ project: "fixtures/projects/v1/ice", seed, inputs: [], expect: {} }).state, ctx, idleFrames(4)).state);
const tile = (s: State): number => s.map.player.y * mapOf(s.map.mapId).width + s.map.player.x;
const rocksOf = (s: State): number[] => {
  const w = mapOf(s.map.mapId).width;
  return Object.values(s.map.events)
    .filter((ev) => ev.id.startsWith("ev_rock"))
    .map((ev) => ev.y * w + ev.x)
    .sort((a, b) => a - b);
};
const warp = (s: State, mapId: string, x: number, y: number): State => settle({ ...s, map: { ...s.map, transfer: { to: mapId as never, x, y, dir: "up", fade: "none", requested: false } } });

/** その部屋の入口からの解き方（モデル）。 */
function solution(roomId: string, goal: "up" | { x: number; y: number }): Solution {
  const room = modelOf(roomId);
  const target = goal === "up" ? room.up! : goal.y * room.w + goal.x;
  const sol = solve(room, START.y * room.w + START.x, target);
  if (sol === undefined) throw new Error(`${roomId} は解けない`);
  return sol;
}

/** 手順をエンジンで 1 手ずつ再生する。毎手のあとで、モデルの位置・岩の位置と一致することを確かめる（最後の 1 手が階段なら、場所移動のあとなので確かめない）。 */
function play(state: State, roomId: string, sol: Solution, leavesRoom: boolean): State {
  let s = state;
  sol.moves.forEach((dir, i) => {
    s = settle(drive(s, ctx, [press(dir)]).state);
    if (leavesRoom && i === sol.moves.length - 1) return;
    expect(tile(s), `${roomId} の ${i + 1} 手目（${dir}）のあとの位置`).toBe(sol.states[i]!.p);
    expect(rocksOf(s), `${roomId} の ${i + 1} 手目（${dir}）のあとの岩`).toEqual(sol.states[i]!.rocks);
  });
  return s;
}

describe("氷の神殿のデモ（fixtures/projects/v1/ice）", () => {
  it("入口の間・すべる回廊・岩と感圧板・二つの感圧板・炎のしずくの間の 5 枚。どれも 15×11 タイル（1 画面）", () => {
    expect(Object.keys(maps).sort()).toEqual([...ROOMS].sort());
    for (const id of ROOMS) expect([mapOf(id).width, mapOf(id).height]).toEqual([15, 11]);
    expect(project.system.screen).toEqual({ width: 15 * 32, height: 11 * 32 });
    expect(project.system.autosave).toEqual({ onTransfer: true });
    expect(tileset.ice).toEqual([2]);
    expect(Object.keys(project.database.enemies)).toEqual([]);
  });

  it("岩は押せる（pushable）イベント。感圧板と同じ数で、岩のある部屋の入口には魔法陣がある", () => {
    for (const id of ROOMS) {
      const room = modelOf(id);
      expect(room.rocks.length, id).toBe(room.plates.length);
      expect(Object.hasOwn(mapOf(id).events, "ev_rune"), id).toBe(room.rocks.length > 0);
    }
    expect(modelOf("map_rock1").rocks).toHaveLength(1);
    expect(modelOf("map_rock2").rocks).toHaveLength(2);
    for (const ev of Object.values(mapOf("map_rock2").events).filter((e) => e.id.startsWith("ev_rock"))) expect(ev.pages[0]!.pushable).toBe(true);
  });

  it("パズルは解ける。最短の手数は 7・16・19 手（入口の間は階段まで歩くだけ）", () => {
    expect(solution("map_hall", "up").moves).toHaveLength(6);
    expect(solution("map_slide", "up").moves).toHaveLength(7);
    expect(solution("map_rock1", "up").moves).toHaveLength(16);
    expect(solution("map_rock2", "up").moves).toHaveLength(19);
  });

  it("すべる回廊：氷に着くと止まるまで滑る。入口から 1 歩目はまっすぐ階段へは行けない", () => {
    let s = warp(newGame(), "map_slide", START.x, START.y);
    expect(s.map.mapId).toBe("map_slide");
    // まっすぐ上へ：氷の上を滑って、柱の手前で止まる（階段までは行けない）
    s = settle(drive(s, ctx, [press("up")]).state);
    expect(s.map.mapId).toBe("map_slide");
    expect([s.map.player.x, s.map.player.y]).not.toEqual([START.x, START.y]);
    expect(s.map.player.y).toBeGreaterThan(2);
  });

  it("扉が閉じているあいだは通れず、感圧板に岩が載ると開く", () => {
    let s = warp(newGame(), "map_rock1", 7, 4);
    s = settle(drive(s, ctx, [press("up")]).state);
    expect([s.map.player.x, s.map.player.y]).toEqual([7, 4]); // 扉にふさがれている
    expect(s.switches["sw_open_map_rock1" as never]).toBeUndefined();
    const sol = solution("map_rock1", "up");
    s = play(warp(newGame(), "map_rock1", START.x, START.y), "map_rock1", { ...sol, moves: sol.moves.slice(0, -2), states: sol.states.slice(0, -2) }, false);
    expect(s.switches["sw_open_map_rock1" as never]).toBe(true);
    expect(s.map.events["ev_door" as never]!.pageIndex).toBe(1); // 開いた扉
  });

  it("魔法陣：岩を押したあとで決定ボタンを押すと、岩が元の位置に戻る（板の光は消える）", () => {
    const room = modelOf("map_rock1");
    const sol = solution("map_rock1", "up");
    let s = warp(newGame(), "map_rock1", START.x, START.y);
    // 岩が動くところまで進める
    let n = 0;
    while (JSON.stringify(rocksOf(s)) === JSON.stringify(room.rocks)) s = settle(drive(s, ctx, [press(sol.moves[n++]!)]).state);
    expect(rocksOf(s)).not.toEqual(room.rocks);
    // 入口へ戻ったことにして、魔法陣で戻す
    s = { ...s, map: { ...s.map, player: { ...s.map.player, x: START.x, y: START.y, realX: START.x, realY: START.y, direction: "up", moving: false } } };
    s = settle(drive(s, ctx, [press("ok")]).state, [0]);
    expect(rocksOf(s)).toEqual(room.rocks);
    expect(s.switches["sw_open_map_rock1" as never]).toBeUndefined();
  });

  it("階段・魔法陣・扉の上へは岩を押せない（マップの定義から確かめる）", () => {
    for (const id of ["map_rock1", "map_rock2"]) {
      const room = modelOf(id);
      for (const k of [room.up!, room.down!, room.door!, START.y * room.w + START.x]) expect(room.interactive.has(k), `${id} の ${k}`).toBe(true);
    }
  });

  it("入口からすべての部屋を解いて、炎のしずくを取ると、エンディング（タイトルへ戻る）", () => {
    let s = newGame("full");
    expect(s.map.mapId).toBe("map_hall");
    for (const [i, id] of ROOMS.slice(0, 4).entries()) {
      expect(s.map.mapId).toBe(id);
      expect([s.map.player.x, s.map.player.y], id).toEqual([START.x, START.y]);
      s = play(s, id, solution(id, "up"), true);
      expect(s.map.mapId, `${id} の階段のあと`).toBe(ROOMS[i + 1]);
    }
    // 炎のしずくの間：台座の手前まで歩いて、話しかける
    expect(s.map.mapId).toBe("map_orb");
    s = play(s, "map_orb", solution("map_orb", { x: 7, y: 5 }), false);
    expect([s.map.player.x, s.map.player.y, s.map.player.direction]).toEqual([7, 5, "up"]);
    s = settle(drive(s, ctx, [press("ok")]).state);
    expect(s.scene.kind).toBe("title");
  });

  it("開けた扉は部屋を出入りしても開いたまま。岩はもとの位置に戻る", () => {
    let s = warp(newGame(), "map_rock1", START.x, START.y);
    s = play(s, "map_rock1", solution("map_rock1", "up"), true);
    expect(s.map.mapId).toBe("map_rock2");
    s = settle(drive(s, ctx, [press("down")]).state); // 階段 `<` から前の部屋へ（扉のところに着く）
    expect(s.map.mapId).toBe("map_rock1");
    expect(s.switches["sw_open_map_rock1" as never]).toBe(true);
    expect(rocksOf(s)).toEqual(modelOf("map_rock1").rocks);
    expect(s.map.events["ev_door" as never]!.pageIndex).toBe(1);
  });

  it("決定論：同じシードなら、同じ手順で同じ状態になる", () => {
    const run = (): string => {
      const s = play(warp(newGame("same"), "map_slide", START.x, START.y), "map_slide", solution("map_slide", "up"), true);
      return JSON.stringify([s.map.mapId, s.map.player.x, s.map.player.y, s.tick]);
    };
    expect(run()).toBe(run());
  });
});
