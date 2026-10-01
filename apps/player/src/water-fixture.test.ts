import { describe, expect, it } from "vitest";
import { drive, idleFrames, loadFixtureProject, press, runReplay } from "@rpg/test-utils";
import type { MapData } from "@rpg/schema";

// 水門の遺跡のデモ（fixtures/projects/v1/water。tools/make-water-demo.mjs が生成する）の約束ごと。
// パズルは、ここに書いた「規則のモデル」（位置 × 水位 × 木箱の BFS）で最短の手順を探して、実際のエンジンで 1 手ずつ再生して確かめる
// （モデルの位置・水位・木箱とエンジンの位置・水位・木箱が、毎手そろうこと）。
const { project, maps, ctx } = loadFixtureProject("water");
type State = ReturnType<typeof runReplay>["state"];
type Dir = "up" | "down" | "left" | "right";

const ROOMS = ["map_hall", "map_crates", "map_gates", "map_shrine"];
const mapOf = (id: string): MapData => maps[id as keyof typeof maps]!;
const tileset = Object.values(project.tilesets)[0]!;
const W = 15;
const START = { x: 7, y: 8 };
const START_K = START.y * W + START.x;
const VEC: Record<Dir, [number, number]> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
const DIRS = Object.keys(VEC) as Dir[];
/** タイル（`tools/make-water-demo.mjs` の `CHANNELS` と `T`）。 */
const BED = 3;
const RAFT = 10;
/** 水のタイル → 水路（青 a・緑 b・紫 c）、浅瀬のタイル → 堰。 */
const WATER_CH: Record<number, "a" | "b" | "c"> = { 2: "a", 11: "b", 15: "c" };
const SHALLOW_CH: Record<number, "a" | "b" | "c"> = { 4: "a", 13: "b", 17: "c" };
const CH_BIT = { a: 1, b: 2, c: 4 } as const;
/** 連動水門のレバー：動かす水路（レバーのランプの色）。 */
const COUPLE: Record<string, ("a" | "b" | "c")[]> = { ev_lever_1: ["a", "b"], ev_lever_2: ["b", "c"], ev_lever_3: ["a"] };

// ── 規則のモデル ──────────────────────────────────────────────────────
interface Room {
  w: number;
  h: number;
  /** どの水位でも通れないマス（壁・石柱・レバー・祭壇・戻る階段）。 */
  wall: Set<number>;
  /** 水路（水位が低いと通れる）／堰（高いと通れる）。値はその水路。 */
  water: Map<number, "a" | "b" | "c">;
  dam: Map<number, "a" | "b" | "c">;
  /** レバー（マス → 動かす水路）。 */
  levers: Map<number, ("a" | "b" | "c")[]>;
  goal: number;
  crates: number[];
}

function modelOf(id: string): Room {
  const map = mapOf(id);
  const w = map.width;
  const room: Room = { w, h: map.height, wall: new Set(), water: new Map(), dam: new Map(), levers: new Map(), goal: -1, crates: [] };
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < w; x++) {
      const tiles = map.layers.map((l) => l.tiles[y * w + x] ?? 0).filter((t) => t !== 0);
      const k = y * w + x;
      const water = tiles.find((t) => WATER_CH[t] !== undefined);
      const dam = tiles.find((t) => SHALLOW_CH[t] !== undefined);
      if (water !== undefined) room.water.set(k, WATER_CH[water]!);
      else if (dam !== undefined) room.dam.set(k, SHALLOW_CH[dam]!);
      else if (tiles.some((t) => tileset.passage[t] === 0)) room.wall.add(k);
    }
  }
  for (const ev of Object.values(map.events)) {
    const k = ev.y * w + ev.x;
    if (ev.id.startsWith("ev_lever_")) {
      room.levers.set(k, id === "map_gates" ? COUPLE[ev.id]! : ["a"]);
      room.wall.add(k);
    } else if (ev.id === "ev_crystal") {
      room.goal = k;
      room.wall.add(k);
    } else if (ev.id.startsWith("ev_crate_")) room.crates.push(k);
    else if (ev.id === "ev_down") room.wall.add(k);
  }
  room.crates.sort((a, b) => a - b);
  return room;
}

type Move = { kind: "walk" | "push" | "pull" | "goal"; dir: Dir };
interface Node {
  p: number;
  /** 水位が低い水路（ビット：a=1, b=2, c=4）。浮き橋の間は水路が青（a）だけ。 */
  low: number;
  crates: number[];
  /** 木箱が沈んでできた浮き橋のマス。 */
  rafts: number[];
}
interface Solution {
  moves: Move[];
  states: Node[];
  final: Node;
}

/**
 * 入口 (7, 8) から始めて、水晶の祭壇のとなりに着いて（`goal`）調べるまでの最短の手順（BFS）。`from` / `target: "start"` なら、`from` から入口へ戻る手順。
 * 水路のマスは、その水路の水位が低いか浮き橋のとき、堰は水位が高いときだけ通れる。レバーは動かす水路の水位を入れかえる。
 * 水位が高くなったとき、水路のマスにある木箱は沈んで、そのマスが浮き橋になる。木箱は水路・堰・浮き橋の上を押せる（入口の魔法陣のマスへは押せない）。
 * `noSink` なら木箱は沈まない（沈めないと解けないことの確認用）。
 */
function solve(room: Room, opts: { from?: Node; target?: "goal" | "start"; noSink?: boolean } = {}): Solution | undefined {
  const { w, h } = room;
  const inside = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < w && y < h;
  const open = (k: number, n: { low: number; rafts: number[] }): boolean => {
    if (room.wall.has(k)) return false;
    const wc = room.water.get(k);
    if (wc !== undefined) return (n.low & CH_BIT[wc]) !== 0 || n.rafts.includes(k);
    const dc = room.dam.get(k);
    if (dc !== undefined) return (n.low & CH_BIT[dc]) === 0;
    return true;
  };
  const key = (n: Node): string => `${n.p}|${n.low}|${n.crates.join(",")}|${n.rafts.join(",")}`;
  const first: Node = opts.from ?? { p: START_K, low: 0, crates: room.crates, rafts: [] };
  const prev = new Map<string, { from: string; move: Move; node: Node } | null>([[key(first), null]]);
  const queue: Node[] = [first];
  const target = opts.target ?? "goal";
  for (let qi = 0; qi < queue.length; qi++) {
    const n = queue[qi]!;
    const x = n.p % w;
    const y = Math.floor(n.p / w);
    const finish = (last: Move | undefined, at: Node): Solution => {
      const moves: Move[] = last === undefined ? [] : [last];
      const states: Node[] = last === undefined ? [] : [at];
      for (let cur: string | undefined = key(n); cur !== undefined && prev.get(cur) != null; cur = prev.get(cur)!.from) {
        moves.unshift(prev.get(cur)!.move);
        states.unshift(prev.get(cur)!.node);
      }
      return { moves, states, final: n };
    };
    if (target === "start" && n.p === START_K && qi > 0) return finish(undefined, n);
    for (const dir of DIRS) {
      const [dx, dy] = VEC[dir];
      if (!inside(x + dx, y + dy)) continue;
      const t = (y + dy) * w + x + dx;
      let move: Move | undefined;
      let node: Node | undefined;
      if (t === room.goal) {
        if (target === "goal") return finish({ kind: "goal", dir }, n);
        continue;
      }
      const lever = room.levers.get(t);
      if (lever !== undefined) {
        const low = lever.reduce((m, c) => m ^ CH_BIT[c], n.low);
        let { crates, rafts } = n;
        if (opts.noSink !== true) {
          // 水位が高い水路のマスにある木箱は沈む
          const sunk = crates.filter((c) => room.water.has(c) && (low & CH_BIT[room.water.get(c)!]) === 0 && !rafts.includes(c));
          if (sunk.length > 0) {
            crates = crates.filter((c) => !sunk.includes(c));
            rafts = [...rafts, ...sunk].sort((a, b) => a - b);
          }
        }
        move = { kind: "pull", dir };
        node = { p: n.p, low, crates, rafts };
      } else if (n.crates.includes(t)) {
        const nx = x + 2 * dx;
        const ny = y + 2 * dy;
        if (!inside(nx, ny)) continue;
        const t2 = ny * w + nx;
        if (!open(t, n) || !open(t2, n) || n.crates.includes(t2) || t2 === START_K) continue;
        move = { kind: "push", dir };
        node = { p: t, low: n.low, crates: n.crates.map((c) => (c === t ? t2 : c)).sort((a, b) => a - b), rafts: n.rafts };
      } else if (open(t, n)) {
        move = { kind: "walk", dir };
        node = { p: t, low: n.low, crates: n.crates, rafts: n.rafts };
      }
      if (move === undefined || node === undefined) continue;
      const k = key(node);
      if (prev.has(k)) continue;
      prev.set(k, { from: key(n), move, node });
      queue.push(node);
    }
  }
  return undefined;
}

// ── エンジンを動かす ──────────────────────────────────────────────────
const busy = (s: State): boolean => s.map.player.moving || s.map.transfer !== undefined || s.interpreters.some((i) => i.mode === "normal");

/** 操作できる状態になるまで進める。メッセージは決定で送り、選択肢は `answers` の順に答える（尽きたら先頭＝「引く」など）。 */
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
const on = (s: State, id: string): boolean => s.switches[id as never] === true;
/** いまのマップの、地面のレイヤのタイル（`ChangeMapTile` で書き換えたものを重ねて）。 */
const groundAt = (s: State, x: number, y: number): number => s.mapTiles?.[s.map.mapId]?.[`0:${x},${y}`] ?? (mapOf(s.map.mapId).layers[0]!.tiles[y * mapOf(s.map.mapId).width + x] as number);
/** 水位が低い水路（ビット）。浮き橋の間は 1 つの水位（青）。 */
const lowMask = (s: State, id: string): number => {
  if (id === "map_crates") return on(s, "sw_low_map_crates") ? 1 : 0;
  return (["a", "b", "c"] as const).reduce((m, c) => m | (on(s, `sw_low_map_gates_${c}`) ? CH_BIT[c] : 0), 0);
};
/** 沈んでいない木箱のマス。 */
const cratesOf = (s: State): number[] =>
  Object.values(s.map.events)
    .filter((ev) => ev.id.startsWith("ev_crate_") && !on(s, `sw_sunk_${ev.id.replace("ev_crate_", "")}`))
    .map((ev) => ev.y * mapOf(s.map.mapId).width + ev.x)
    .sort((a, b) => a - b);

/** 手順をエンジンで 1 手ずつ再生する。毎手のあとで、モデルの位置・水位・木箱と一致することを確かめる。 */
function play(state: State, roomId: string, sol: Solution, opts: { checkLast?: boolean } = {}): State {
  let s = state;
  sol.moves.forEach((move, i) => {
    s = settle(drive(s, ctx, [press(move.dir)]).state);
    if (move.kind === "pull" || move.kind === "goal") {
      s = settle(drive(s, ctx, [press("ok")]).state, [0]);
      // 木箱が沈むのは、水位が変わったあとの並列イベント（数フレーム後）
      s = settle(drive(s, ctx, idleFrames(8)).state);
    }
    if (move.kind === "goal") return;
    if (i === sol.moves.length - 1 && opts.checkLast === false) return;
    const st = sol.states[i]!;
    expect(tile(s), `${roomId} の ${i + 1} 手目（${move.kind} ${move.dir}）のあとの位置`).toBe(st.p);
    if (move.kind === "pull") expect(lowMask(s, roomId), `${roomId} の ${i + 1} 手目（レバー）のあとの水位`).toBe(st.low);
    if (roomId === "map_crates") expect(cratesOf(s), `${roomId} の ${i + 1} 手目のあとの木箱`).toEqual(st.crates);
  });
  return s;
}

/** 入口の間で、`goal` のマスまで歩く最短の手順（BFS）。水路が干上がっていれば渡れる。階段のマス（W・E・北）は目的地のときだけ踏む。 */
function route(goal: number, from: number, drained: boolean): Dir[] {
  const hall = mapOf("map_hall");
  const w = hall.width;
  const stairs = new Set(Object.values(hall.events).filter((e) => ["ev_up", "ev_west", "ev_east"].includes(e.id)).map((e) => e.y * w + e.x));
  const blocked = new Set<number>();
  for (let k = 0; k < w * hall.height; k++) {
    const tiles = hall.layers.map((l) => l.tiles[k] ?? 0).filter((t) => t !== 0);
    if (tiles.some((t) => (WATER_CH[t] !== undefined ? !drained : tileset.passage[t] === 0))) blocked.add(k);
  }
  for (const e of Object.values(hall.events)) if (["ev_guide", "ev_down", "ev_ped_a", "ev_ped_b"].includes(e.id)) blocked.add(e.y * w + e.x);
  const prev = new Map<number, { from: number; dir: Dir } | null>([[from, null]]);
  const queue = [from];
  for (let qi = 0; qi < queue.length; qi++) {
    const k = queue[qi]!;
    if (k === goal) break;
    for (const dir of DIRS) {
      const t = k + VEC[dir][0] + VEC[dir][1] * w;
      if (blocked.has(t) || prev.has(t) || (stairs.has(t) && t !== goal)) continue;
      prev.set(t, { from: k, dir });
      queue.push(t);
    }
  }
  const out: Dir[] = [];
  for (let k = goal; prev.get(k) != null; k = prev.get(k)!.from) out.unshift(prev.get(k)!.dir);
  return out;
}
/** 入口の間を歩く。最後に階段を踏むと、場所移動する。 */
function walkHall(s: State, goal: number, drained = false): State {
  let t = s;
  for (const dir of route(goal, tile(s), drained)) t = settle(drive(t, ctx, [press(dir)]).state);
  return t;
}
const hallK = (x: number, y: number): number => y * W + x;

/** 部屋の入口から、水晶を取って、入口（`<` の上）へ戻るまでをエンジンで通しで行う。 */
function solveRoom(s0: State, roomId: string): State {
  const room = modelOf(roomId);
  const there = solve(room)!;
  let s = play(s0, roomId, there);
  expect(on(s, roomId === "map_crates" ? "sw_crystal_a" : "sw_crystal_b"), `${roomId} の水晶`).toBe(true);
  const back = solve(room, { from: there.final, target: "start" })!;
  s = play(s, roomId, back);
  expect(tile(s)).toBe(START_K);
  return settle(drive(s, ctx, [press("down")]).state); // 階段 `<` から入口の間へ
}

describe("水門の遺跡のデモ（fixtures/projects/v1/water）", () => {
  it("入口の間・浮き橋の間・連動水門の間・水神の間の 4 枚。どれも 15×11 タイル（1 画面）", () => {
    expect(Object.keys(maps).sort()).toEqual([...ROOMS].sort());
    for (const id of ROOMS) expect([mapOf(id).width, mapOf(id).height]).toEqual([15, 11]);
    expect(project.system.screen).toEqual({ width: 15 * 32, height: 11 * 32 });
    expect(project.system.autosave).toEqual({ onTransfer: true });
    expect(Object.keys(project.database.enemies)).toEqual([]);
  });

  it("水と石の堰は通れず、水路の底・水の下の浅瀬・浮き橋・床は通れる（タイルセットの通行設定）", () => {
    for (const c of ["a", "b", "c"] as const) {
      const ids = Object.entries(WATER_CH).find(([, v]) => v === c)![0];
      expect(tileset.passage[Number(ids)], `水 ${c}`).toBe(0);
      expect(tileset.passage[Number(ids) + 3], `堰 ${c}`).toBe(0); // 石の堰（水・底・浅瀬・堰の順）
      expect(tileset.passage[Number(ids) + 1], `底 ${c}`).toBe(15);
      expect(tileset.passage[Number(ids) + 2], `浅瀬 ${c}`).toBe(15);
    }
    expect([RAFT, 1].map((t) => tileset.passage[t])).toEqual([15, 15]);
  });

  it("どの部屋も、水位が高い（水路は水・堰は浅瀬）ところから始まる。レバーのとなりに水路・堰はない", () => {
    for (const id of ROOMS) {
      const room = modelOf(id);
      for (const k of room.levers.keys()) for (const d of [-1, 1, -room.w, room.w]) expect(room.water.has(k + d) || room.dam.has(k + d), `${id} のレバー ${k}`).toBe(false);
    }
    const s = newGame();
    expect([lowMask(s, "map_crates"), lowMask(s, "map_gates")]).toEqual([0, 0]);
  });

  it("パズルは解ける。浮き橋の間は 91 手（木箱を 20 回あまり押す）、連動水門の間は 80 手（レバーを 5 回）。浮き橋の間は、木箱を沈めないと解けない", () => {
    const crates = solve(modelOf("map_crates"))!;
    expect(crates.moves).toHaveLength(91);
    expect(crates.moves.filter((m) => m.kind === "push").length).toBeGreaterThanOrEqual(20); // 同じ長さの解は何通りもある
    expect(crates.moves.filter((m) => m.kind === "pull")).toHaveLength(2);
    expect(solve(modelOf("map_crates"), { noSink: true })).toBeUndefined();
    const gates = solve(modelOf("map_gates"))!;
    expect(gates.moves).toHaveLength(80);
    expect(gates.moves.filter((m) => m.kind === "pull")).toHaveLength(5);
    // 解き終えたあとも、入口へ戻れる（箱は沈んで浮き橋になっていて、戻る道が閉じない）
    expect(solve(modelOf("map_crates"), { from: crates.final, target: "start" })).toBeDefined();
    expect(solve(modelOf("map_gates"), { from: gates.final, target: "start" })).toBeDefined();
  });

  it("入口の間：水路に沈んでいて、北の階段へは行けない。干上がっていれば渡れる", () => {
    expect(route(hallK(7, 2), START_K, false)).toEqual([]);
    expect(route(hallK(7, 2), START_K, true).length).toBeGreaterThan(5);
    expect(route(hallK(2, 8), START_K, false)).toHaveLength(5); // 西の階段
    expect(route(hallK(12, 8), START_K, false)).toHaveLength(5); // 東の階段
  });

  it("木箱を水路の底へ押しこんで水位を上げると、箱は沈んで浮き橋になる。水位を下げても、浮き橋はもとに戻らない", () => {
    const sol = solve(modelOf("map_crates"))!;
    // 最初のレバーから 2 番目のレバーまでの手順のあと、浮き橋が 1 つできている
    let s = warp(newGame(), "map_crates", START.x, START.y);
    const firstSink = sol.states.findIndex((st) => st.rafts.length > 0);
    s = play(s, "map_crates", { ...sol, moves: sol.moves.slice(0, firstSink + 1), states: sol.states.slice(0, firstSink + 1) });
    const rafts = Object.entries(s.mapTiles!["map_crates" as never]!).filter(([, t]) => t === RAFT);
    expect(rafts).toHaveLength(1);
    const [x, y] = rafts[0]![0].slice(2).split(",").map(Number) as [number, number];
    expect(on(s, "sw_sunk_1") || on(s, "sw_sunk_2")).toBe(true);
    expect(groundAt(s, x, y)).toBe(RAFT);
    // 解ききると、水位の切り替えのあとも浮き橋は残っている（水位の高い・低いどちらでも渡れる）
    s = play(warp(newGame(), "map_crates", START.x, START.y), "map_crates", sol);
    expect(Object.values(s.mapTiles!["map_crates" as never]!).filter((t) => t === RAFT).length).toBeGreaterThanOrEqual(1);
    expect(lowMask(s, "map_crates")).toBe(0); // 解き終えたとき、水位は高い
  });

  it("連動水門のレバーは、ランプの色の水路の水位を入れかえる（連動水門の間のタイルも書き換わる）", () => {
    // レバー 1（青・緑）を、となりから引く：レバー 1 は (11, 2)
    let s = warp(newGame(), "map_gates", 10, 2);
    s = settle(drive(s, ctx, [press("right")]).state);
    s = settle(drive(s, ctx, [press("ok")]).state, [0]);
    expect(lowMask(s, "map_gates")).toBe(CH_BIT.a | CH_BIT.b);
    expect(groundAt(s, 9, 5)).toBe(BED); // 青の水路 a
    expect(groundAt(s, 13, 5)).toBe(12); // 緑の水路 b の底
    expect(groundAt(s, 7, 3)).toBe(15); // 紫の水路 c はそのまま（水）
    // もう一度引くと、もとにもどる
    s = settle(drive(s, ctx, [press("right")]).state);
    s = settle(drive(s, ctx, [press("ok")]).state, [0]);
    expect(lowMask(s, "map_gates")).toBe(0);
    expect(groundAt(s, 9, 5)).toBe(2);
  });

  it("魔法陣：箱を動かして水位を変えたあとでも、はじめの状態にもどせる", () => {
    const sol = solve(modelOf("map_crates"))!;
    let s = play(warp(newGame(), "map_crates", START.x, START.y), "map_crates", { ...sol, moves: sol.moves.slice(0, 12), states: sol.states.slice(0, 12) });
    expect(cratesOf(s)).not.toEqual(modelOf("map_crates").crates);
    s = warp(s, "map_crates", START.x, START.y);
    s = settle(drive(s, ctx, [press("ok")]).state, [0]);
    expect(cratesOf(s)).toEqual(modelOf("map_crates").crates);
    expect(lowMask(s, "map_crates")).toBe(0);
    expect(groundAt(s, 3, 6)).toBe(2);
    // もどしたあとでも、同じ手順で解ける
    s = warp(s, "map_crates", START.x, START.y);
    s = play(s, "map_crates", sol);
    expect(on(s, "sw_crystal_a")).toBe(true);
  });

  it("水位は部屋を出入りしても残り、セーブデータ（JSON）にも入る（GameState.mapTiles）", () => {
    let s = warp(newGame(), "map_gates", 10, 2);
    s = settle(drive(s, ctx, [press("right"), press("ok")]).state, [0]);
    s = warp(warp(s, "map_hall", START.x, START.y), "map_gates", 10, 3);
    expect(lowMask(s, "map_gates")).toBe(CH_BIT.a | CH_BIT.b);
    expect(groundAt(s, 9, 5)).toBe(BED);
    const saved = JSON.parse(JSON.stringify(s)) as State;
    expect(saved.mapTiles).toEqual(s.mapTiles);
  });

  it("水晶は台座に戻り、二つそろうと、入口の間の水路が別のマップから干上がる", () => {
    let s = newGame();
    s = warp(s, "map_crates", START.x, START.y);
    s = play(s, "map_crates", solve(modelOf("map_crates"))!);
    expect(on(s, "sw_crystal_a")).toBe(true);
    expect(on(s, "sw_hall_drained")).toBe(false);
    expect(s.mapTiles?.["map_hall" as never]).toBeUndefined();
    s = warp(s, "map_gates", START.x, START.y);
    s = play(s, "map_gates", solve(modelOf("map_gates"))!);
    expect(on(s, "sw_hall_drained")).toBe(true);
    expect(Object.keys(s.mapTiles!["map_hall" as never]!)).toHaveLength(13);
    s = warp(s, "map_hall", START.x, START.y);
    expect(groundAt(s, 7, 3)).toBe(BED);
    expect(s.map.events["ev_ped_a" as never]!.pageIndex).toBe(1); // 水晶が台座に置かれている
    expect(s.map.events["ev_ped_b" as never]!.pageIndex).toBe(1);
    expect(s.map.events["ev_guide" as never]!.pageIndex).toBe(1); // 案内人の話が変わる
  });

  it("入口から、西と東の部屋を（どちらから先でも）解いて、宝珠を取ると、エンディング（タイトルへ戻る）", () => {
    for (const order of [["map_crates", "map_gates"], ["map_gates", "map_crates"]] as const) {
      let s = newGame(`full-${order[0]}`);
      expect(s.map.mapId).toBe("map_hall");
      for (const id of order) {
        // 入口の間から、その部屋の階段へ。水晶を取って、入口へ戻る
        s = walkHall(s, id === "map_crates" ? hallK(2, 8) : hallK(12, 8));
        expect(s.map.mapId).toBe(id);
        expect([s.map.player.x, s.map.player.y], id).toEqual([START.x, START.y]);
        s = solveRoom(s, id);
        expect(s.map.mapId).toBe("map_hall");
      }
      expect(on(s, "sw_hall_drained")).toBe(true);
      // 干上がった水路を渡って、北の階段から水神の間へ
      s = walkHall(s, hallK(7, 2), true);
      expect(s.map.mapId).toBe("map_shrine");
      for (let i = 0; i < 3; i++) s = settle(drive(s, ctx, [press("up")]).state);
      expect([s.map.player.x, s.map.player.y, s.map.player.direction]).toEqual([7, 5, "up"]);
      s = settle(drive(s, ctx, [press("ok")]).state);
      expect(s.scene.kind).toBe("title");
    }
  });

  it("決定論：同じシードなら、同じ手順で同じ状態になる", () => {
    const run = (): string => {
      const s = play(warp(newGame("same"), "map_gates", START.x, START.y), "map_gates", solve(modelOf("map_gates"))!);
      return JSON.stringify([s.map.mapId, s.map.player.x, s.map.player.y, s.tick, s.mapTiles]);
    };
    expect(run()).toBe(run());
  });
});
