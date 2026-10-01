import { describe, expect, it } from "vitest";
import { drive, idleFrames, loadFixtureProject, press, runReplay } from "@rpg/test-utils";
import type { MapData } from "@rpg/schema";

// 水門の遺跡のデモ（fixtures/projects/v1/water。tools/make-water-demo.mjs が生成する）の約束ごと。
// パズルは、ここに書いた「規則のモデル」（位置 × 水位の BFS）で最短の手順を探して、実際のエンジンで 1 手ずつ再生して確かめる
// （モデルの位置・水位とエンジンの位置・水位・タイルが、毎手そろうこと）。
const { project, maps, ctx } = loadFixtureProject("water");
type State = ReturnType<typeof runReplay>["state"];
type Dir = "up" | "down" | "left" | "right";

const ROOMS = ["map_hall", "map_canal", "map_float", "map_sluice", "map_shrine"];
const mapOf = (id: string): MapData => maps[id as keyof typeof maps]!;
const tileset = Object.values(project.tilesets)[0]!;
const START = { x: 7, y: 8 };
const VEC: Record<Dir, [number, number]> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
/** タイル（`tools/make-water-demo.mjs` の `T`）。 */
const WATER = 2;
const BED = 3;
const SHALLOW = 4;
const BARRIER = 5;

// ── 規則のモデル ──────────────────────────────────────────────────────
interface Room {
  w: number;
  h: number;
  /** どの水位でも通れないタイル（壁・石柱・案内人・レバー・戻る階段）。 */
  wall: Set<number>;
  /** 水位が低いときだけ通れる（水路）／高いときだけ通れる（堰）。 */
  waterway: Set<number>;
  dam: Set<number>;
  levers: number[];
  master?: number;
  up?: number;
  side?: number;
}

function modelOf(id: string): Room {
  const map = mapOf(id);
  const w = map.width;
  const room: Room = { w, h: map.height, wall: new Set(), waterway: new Set(), dam: new Set(), levers: [] };
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < w; x++) {
      const tiles = map.layers.map((l) => l.tiles[y * w + x] ?? 0).filter((t) => t !== 0);
      if (tiles.includes(WATER)) room.waterway.add(y * w + x);
      else if (tiles.includes(SHALLOW)) room.dam.add(y * w + x);
      else if (tiles.some((t) => tileset.passage[t] === 0)) room.wall.add(y * w + x);
    }
  }
  for (const ev of Object.values(map.events)) {
    const k = ev.y * w + ev.x;
    if (ev.id.startsWith("ev_lever_")) {
      room.levers.push(k);
      room.wall.add(k);
    } else if (ev.id === "ev_master") {
      room.master = k;
      room.wall.add(k);
    } else if (ev.id === "ev_up") room.up = k;
    else if (ev.id === "ev_side") room.side = k;
    else if (ev.id === "ev_down" || ev.id === "ev_guide" || ev.id === "ev_orb") room.wall.add(k);
  }
  return room;
}

/** 1 手：歩く（`dir`）か、となりのレバーを引く（`pull`：向く方向と、引くレバーのタイル）。 */
type Move = { kind: "walk"; dir: Dir } | { kind: "pull"; dir: Dir };
interface Node {
  p: number;
  /** 水位が低いか。 */
  low: boolean;
}
interface Solution {
  moves: Move[];
  /** 各手のあとの状態（モデル）。 */
  states: Node[];
}

/**
 * プレイヤーが `start` から始めて、`goal`（階段の上のタイル）に着く、または大水門のレバー（`master`）を引くまでの最短の手順（BFS）。
 * `drained` が真なら、水路はどれも干上がっている（大水門を開けたあとの入口の間）。
 */
function solve(room: Room, start: number, goal: "up" | "side" | "master", drained = false): Solution | undefined {
  const { w, h } = room;
  const inside = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < w && y < h;
  const open = (k: number, low: boolean): boolean => !room.wall.has(k) && (room.waterway.has(k) ? low || drained : room.dam.has(k) ? !low : true);
  const key = (n: Node): string => `${n.p}|${n.low ? 1 : 0}`;
  const first: Node = { p: start, low: false };
  const prev = new Map<string, { from: string; move: Move; node: Node } | null>([[key(first), null]]);
  let queue = [first];
  const target = goal === "up" ? room.up : goal === "side" ? room.side : room.master;
  while (queue.length > 0) {
    const next: Node[] = [];
    for (const n of queue) {
      const x = n.p % w;
      const y = Math.floor(n.p / w);
      const moves: [Move, Node][] = [];
      for (const dir of Object.keys(VEC) as Dir[]) {
        const [dx, dy] = VEC[dir];
        if (!inside(x + dx, y + dy)) continue;
        const tk = (y + dy) * w + x + dx;
        if (open(tk, n.low)) moves.push([{ kind: "walk", dir }, { p: tk, low: n.low }]);
        else if (room.levers.includes(tk) || tk === room.master) moves.push([{ kind: "pull", dir }, tk === room.master ? { p: n.p, low: n.low } : { p: n.p, low: !n.low }]);
      }
      for (const [move, node] of moves) {
        const k = `${key(node)}${move.kind === "pull" && node.p === n.p && node.low === n.low ? "#goal" : ""}`;
        if (prev.has(k)) continue;
        prev.set(k, { from: key(n), move, node });
        const reached = goal === "master" ? k.endsWith("#goal") : node.p === target;
        if (reached) {
          const out: Move[] = [];
          const states: Node[] = [];
          for (let cur: string | undefined = k; cur !== undefined && prev.get(cur) != null; cur = prev.get(cur)!.from) {
            out.unshift(prev.get(cur)!.move);
            states.unshift(prev.get(cur)!.node);
          }
          return { moves: out, states };
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

/** 操作できる状態になるまで進める。メッセージは決定で送り、選択肢は `answers` の順に答える（尽きたら先頭＝「引く」「水位と水路」）。 */
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

const newGame = (seed = "water"): State => settle(drive(runReplay({ project: "fixtures/projects/v1/water", seed, inputs: [], expect: {} }).state, ctx, idleFrames(4)).state);
const tile = (s: State): number => s.map.player.y * mapOf(s.map.mapId).width + s.map.player.x;
const warp = (s: State, mapId: string, x: number, y: number): State => settle({ ...s, map: { ...s.map, transfer: { to: mapId as never, x, y, dir: "up", fade: "none", requested: false } } });
/** 部屋の水位が低い（水が引いている）か。 */
const isLow = (s: State, room: string): boolean => s.switches[`sw_low_${room}` as never] === true;
/** いまのマップの、地面のレイヤのタイル（`ChangeMapTile` で書き換えたものを重ねて）。 */
const groundAt = (s: State, x: number, y: number): number => s.mapTiles?.[s.map.mapId]?.[`0:${x},${y}`] ?? (mapOf(s.map.mapId).layers[0]!.tiles[y * mapOf(s.map.mapId).width + x] as number);

/** その部屋の入口からの解き方（モデル）。 */
function solution(roomId: string, goal: "up" | "side" | "master", start = START.y * 15 + START.x, drained = false): Solution {
  const sol = solve(modelOf(roomId), start, goal, drained);
  if (sol === undefined) throw new Error(`${roomId} は解けない`);
  return sol;
}

/**
 * 手順をエンジンで 1 手ずつ再生する。毎手のあとで、モデルの位置・水位と一致することを確かめる
 * （最後の 1 手が階段・大水門のレバーなら、場所移動のあとなので確かめない）。
 */
function play(state: State, roomId: string, sol: Solution, leavesRoom: boolean): State {
  let s = state;
  sol.moves.forEach((move, i) => {
    s = settle(drive(s, ctx, [press(move.dir)]).state);
    if (move.kind === "pull") s = settle(drive(s, ctx, [press("ok")]).state, [0]);
    if (leavesRoom && i === sol.moves.length - 1) return;
    expect(tile(s), `${roomId} の ${i + 1} 手目（${move.dir}）のあとの位置`).toBe(sol.states[i]!.p);
    if (move.kind === "pull") expect(isLow(s, roomId), `${roomId} の ${i + 1} 手目（レバー）のあとの水位`).toBe(sol.states[i]!.low);
  });
  return s;
}

describe("水門の遺跡のデモ（fixtures/projects/v1/water）", () => {
  it("入口の間・水路の間・浮き橋の間・大水門の間・水神の間の 5 枚。どれも 15×11 タイル（1 画面）", () => {
    expect(Object.keys(maps).sort()).toEqual([...ROOMS].sort());
    for (const id of ROOMS) expect([mapOf(id).width, mapOf(id).height]).toEqual([15, 11]);
    expect(project.system.screen).toEqual({ width: 15 * 32, height: 11 * 32 });
    expect(project.system.autosave).toEqual({ onTransfer: true });
    expect(Object.keys(project.database.enemies)).toEqual([]);
  });

  it("水と石の堰は通れず、水路の底・水の下の浅瀬・床は通れる（タイルセットの通行設定）", () => {
    expect([WATER, BARRIER].map((t) => tileset.passage[t])).toEqual([0, 0]);
    expect([BED, SHALLOW, 1].map((t) => tileset.passage[t])).toEqual([15, 15, 15]);
  });

  it("どの部屋も、水位が高い（水路は水・堰は浅瀬）ところから始まる。レバーのとなりに水路・堰はない", () => {
    for (const id of ROOMS) {
      const room = modelOf(id);
      for (const k of room.levers) for (const d of [-1, 1, -room.w, room.w]) expect(room.waterway.has(k + d) || room.dam.has(k + d), `${id} のレバー ${k}`).toBe(false);
    }
    const s = newGame();
    for (const id of ROOMS) expect(isLow(s, id)).toBe(false);
  });

  it("パズルは解ける。最短の手数は 9・39・51 手（レバーを 1・3・4 回。大水門の間は、最後の大水門のレバーを含む）。入口の間は水路が干上がるまで階段へ行けない", () => {
    const count = (id: string, goal: "up" | "master"): [number, number] => {
      const sol = solution(id, goal);
      return [sol.moves.length, sol.moves.filter((m) => m.kind === "pull").length];
    };
    expect(count("map_canal", "up")).toEqual([9, 1]);
    expect(count("map_float", "up")).toEqual([39, 3]);
    expect(count("map_sluice", "master")).toEqual([51, 4]); // 水位のレバー 3 回と、最後の大水門のレバー
    expect(solve(modelOf("map_hall"), START.y * 15 + START.x, "up")).toBeUndefined();
    expect(solve(modelOf("map_hall"), START.y * 15 + START.x, "up", true)).toBeDefined();
  });

  it("レバーを引くと水位が変わり、水路が干上がって歩ける（水路の間）。もう一度引くと、水に沈んで歩けなくなる", () => {
    let s = warp(newGame(), "map_canal", 7, 4);
    s = settle(drive(s, ctx, [press("up")]).state);
    expect([s.map.player.x, s.map.player.y]).toEqual([7, 4]); // 水路にさえぎられる
    expect(groundAt(s, 7, 3)).toBe(WATER);
    // レバー (9, 8) を引く
    s = warp(s, "map_canal", 8, 8);
    s = settle(drive(s, ctx, [press("right"), press("ok")]).state, [0]);
    expect(isLow(s, "map_canal")).toBe(true);
    expect(groundAt(s, 7, 3)).toBe(BED);
    s = warp(s, "map_canal", 7, 4);
    s = settle(drive(s, ctx, [press("up")]).state);
    expect([s.map.player.x, s.map.player.y]).toEqual([7, 3]); // 水の引いた水路の底を歩ける
    // もう一度引く
    s = warp(s, "map_canal", 8, 8);
    s = settle(drive(s, ctx, [press("right"), press("ok")]).state, [0]);
    expect(isLow(s, "map_canal")).toBe(false);
    expect(groundAt(s, 7, 3)).toBe(WATER);
  });

  it("堰は逆：水位が高いと浅瀬で歩けて、低いと石の壁になる（浮き橋の間）", () => {
    let s = warp(newGame(), "map_float", 4, 6);
    expect(groundAt(s, 4, 5)).toBe(SHALLOW);
    s = settle(drive(s, ctx, [press("up")]).state);
    expect([s.map.player.x, s.map.player.y]).toEqual([4, 5]);
    // 水位を下げる（レバー (1, 8)）と、堰は石の壁になる
    s = warp(s, "map_float", 2, 8);
    s = settle(drive(s, ctx, [press("left"), press("ok")]).state, [0]);
    expect(groundAt(s, 4, 5)).toBe(BARRIER);
    s = warp(s, "map_float", 4, 6);
    s = settle(drive(s, ctx, [press("up")]).state);
    expect([s.map.player.x, s.map.player.y]).toEqual([4, 6]);
  });

  it("水位は部屋を出入りしても残り、セーブデータ（JSON）にも入る（GameState.mapTiles）", () => {
    let s = warp(newGame(), "map_canal", 8, 8);
    s = settle(drive(s, ctx, [press("right"), press("ok")]).state, [0]);
    expect(s.mapTiles).toEqual({ map_canal: { "0:1,3": BED, "0:2,3": BED, "0:3,3": BED, "0:4,3": BED, "0:5,3": BED, "0:6,3": BED, "0:7,3": BED, "0:8,3": BED, "0:9,3": BED, "0:10,3": BED, "0:11,3": BED, "0:12,3": BED, "0:13,3": BED } });
    // 別の部屋へ行って戻ってくる
    s = warp(warp(s, "map_hall", START.x, START.y), "map_canal", 7, 4);
    expect(isLow(s, "map_canal")).toBe(true);
    expect(groundAt(s, 7, 3)).toBe(BED);
    // セーブデータは JSON：書き換えは JSON を経由しても同じ（読みなおしの検証は core の mapTile.test.ts）
    const saved = JSON.parse(JSON.stringify(s)) as State;
    expect(saved.mapTiles).toEqual(s.mapTiles);
    expect(groundAt(saved, 7, 3)).toBe(BED);
  });

  it("大水門のレバーは、まだ入っていない別のマップ（入口の間）の水路を干上がらせ、入口の間へ運ぶ", () => {
    let s = warp(newGame(), "map_sluice", 6, 2);
    expect(s.mapTiles?.["map_hall" as never]).toBeUndefined();
    s = settle(drive(s, ctx, [press("right"), press("ok")]).state, [0]);
    expect(s.map.mapId).toBe("map_hall");
    expect(s.switches["sw_hall_drained" as never]).toBe(true);
    expect(Object.keys(s.mapTiles!["map_hall" as never]!)).toHaveLength(13);
    expect(groundAt(s, 7, 3)).toBe(BED);
    // 案内人の話が変わる
    s = warp(s, "map_hall", 7, 6);
    s = settle(drive(s, ctx, [press("up"), press("ok")]).state);
    expect(s.map.events["ev_guide" as never]!.pageIndex).toBe(1);
  });

  it("入口からすべての部屋を解いて、宝珠を取ると、エンディング（タイトルへ戻る）", () => {
    let s = newGame("full");
    expect(s.map.mapId).toBe("map_hall");
    // 入口の間：水路に沈んでいて、北の階段へは行けない。東の階段から水路の間へ
    s = play(s, "map_hall", solution("map_hall", "side"), true);
    for (const [id, goal] of [["map_canal", "up"], ["map_float", "up"], ["map_sluice", "master"]] as const) {
      expect(s.map.mapId).toBe(id);
      expect([s.map.player.x, s.map.player.y], id).toEqual([START.x, START.y]);
      s = play(s, id, solution(id, goal), true);
    }
    // 大水門を開けて、入口の間へ運ばれた：こんどは水路を渡って、北の階段へ
    expect(s.map.mapId).toBe("map_hall");
    expect(s.switches["sw_hall_drained" as never]).toBe(true);
    s = play(s, "map_hall", solution("map_hall", "up", START.y * 15 + START.x, true), true);
    // 水神の間：祭壇の手前まで歩いて、話しかける
    expect(s.map.mapId).toBe("map_shrine");
    for (let i = 0; i < 3; i++) s = settle(drive(s, ctx, [press("up")]).state);
    expect([s.map.player.x, s.map.player.y, s.map.player.direction]).toEqual([7, 5, "up"]);
    s = settle(drive(s, ctx, [press("ok")]).state);
    expect(s.scene.kind).toBe("title");
  });

  it("決定論：同じシードなら、同じ手順で同じ状態になる", () => {
    const run = (): string => {
      const s = play(warp(newGame("same"), "map_canal", START.x, START.y), "map_canal", solution("map_canal", "up"), true);
      return JSON.stringify([s.map.mapId, s.map.player.x, s.map.player.y, s.tick, s.mapTiles]);
    };
    expect(run()).toBe(run());
  });
});
