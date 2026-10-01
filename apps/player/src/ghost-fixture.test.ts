import { describe, expect, it } from "vitest";
import { drive, driveUntil, idleFrames, loadFixtureProject, press, runReplay } from "@rpg/test-utils";
import type { MapData } from "@rpg/schema";

// おばけ屋敷の鬼ごっこのデモ（fixtures/projects/v1/ghosts。tools/make-ghost-demo.mjs が生成する）の約束ごと
const { project, maps, ctx } = loadFixtureProject("ghosts");
type State = ReturnType<typeof runReplay>["state"];
type Dir = "up" | "down" | "left" | "right";

const mapOf = (id: string): MapData => maps[id as keyof typeof maps]!;
const passage = Object.values(project.tilesets)[0]!.passage;
const STEPS: [Dir, number, number][] = [["up", 0, -1], ["down", 0, 1], ["left", -1, 0], ["right", 1, 0]];

const isGhost = (id: string): boolean => id.startsWith("ev_ghost_");
const variable = (s: State, id: string): number => s.variables[id as keyof State["variables"]] ?? 0;
const on = (s: State, id: string): boolean => s.switches[id as keyof State["switches"]] === true;
const busy = (s: State): boolean => s.map.player.moving || s.map.transfer !== undefined || s.interpreters.some((i) => i.mode === "normal") || s.message.open || s.scene.kind !== "map";

/** マップの壁・家具（タイル）と、居座るイベントで通れないか。`ghostsBlock` は、おばけも壁として数える。 */
function blocked(s: State, map: MapData, x: number, y: number, ghostsBlock: boolean): boolean {
  if (x < 0 || y < 0 || x >= map.width || y >= map.height) return true;
  if (map.layers.some((l) => {
    const t = l.tiles[y * map.width + x] ?? 0;
    return t !== 0 && passage[t] === 0;
  })) return true;
  return Object.values(s.map.events).some((ev) => ev.x === x && ev.y === y && ev.pageIndex !== null && !ev.through && ev.priority === "same" && (ghostsBlock || !isGhost(ev.id)));
}

/** いちばん近いおばけ（歩いて何歩か）への、最初の一歩の向き。道はおばけを通り抜けて数える（途中のおばけにぶつかれば、そのおばけをつかまえる）。 */
function chaseDir(s: State): Dir | undefined {
  const map = mapOf(s.map.mapId);
  const ghosts = new Set(Object.values(s.map.events).filter((ev) => isGhost(ev.id) && ev.pageIndex !== null && !ev.through && ev.trigger === "touch").map((ev) => `${ev.x},${ev.y}`));
  const { x, y } = s.map.player;
  const first = new Map<string, Dir | null>([[`${x},${y}`, null]]);
  const queue: [number, number][] = [[x, y]];
  while (queue.length > 0) {
    const [cx, cy] = queue.shift()!;
    for (const [d, dx, dy] of STEPS) {
      const nx = cx + dx;
      const ny = cy + dy;
      const k = `${nx},${ny}`;
      if (first.has(k) || blocked(s, map, nx, ny, false)) continue;
      const via = first.get(`${cx},${cy}`) ?? d;
      first.set(k, via);
      if (ghosts.has(k)) return via;
      queue.push([nx, ny]);
    }
  }
  return undefined;
}

/** 進めている間に出たメッセージ。 */
let seen: string[] = [];
const said = (): string => seen.join("\n");

/** メッセージを決定で閉じ、選択肢には `answers` の順に答えながら、イベントが終わるまで進める。 */
function settle(state: State, answers: number[] = []): State {
  let s = state;
  for (let i = 0; i < 400 && busy(s); i++) {
    if (s.scene.kind === "title") return s;
    if (s.message.open) {
      s = drive(s, ctx, idleFrames(2)).state;
      if (s.message.text !== "") seen.push(s.message.text);
      if (s.message.choices !== null) {
        const want = answers.shift() ?? 0;
        while ((s.message.cursor ?? 0) !== want) s = drive(s, ctx, [press("down"), ...idleFrames(1)]).state;
      }
      s = drive(s, ctx, [press("ok"), ...idleFrames(1)]).state;
    } else s = driveUntil(s, ctx, (x) => !busy(x) || x.message.open || x.scene.kind !== "map", 600);
  }
  return s;
}

/** 通れる道（家具・壁・居座るイベントを避ける）。 */
function route(s: State, tx: number, ty: number): Dir[] | undefined {
  const map = mapOf(s.map.mapId);
  const { x, y } = s.map.player;
  const prev = new Map<string, [string, Dir] | null>([[`${x},${y}`, null]]);
  const queue: [number, number][] = [[x, y]];
  while (queue.length > 0) {
    const [cx, cy] = queue.shift()!;
    for (const [d, dx, dy] of STEPS) {
      const k = `${cx + dx},${cy + dy}`;
      if (prev.has(k) || blocked(s, map, cx + dx, cy + dy, true)) continue;
      prev.set(k, [`${cx},${cy}`, d]);
      queue.push([cx + dx, cy + dy]);
    }
  }
  if (!prev.has(`${tx},${ty}`)) return undefined;
  const dirs: Dir[] = [];
  for (let k = `${tx},${ty}`, p = prev.get(k); p != null; k = p[0], p = prev.get(k)) dirs.unshift(p[1]);
  return dirs;
}

const stepOnce = (s: State, d: Dir): State => driveUntil(drive(s, ctx, [press(d)]).state, ctx, (x) => !x.map.player.moving, 60);

/** (tx, ty) まで 1 歩ずつ歩く（動くおばけにふさがれたら道を引きなおす）。 */
function walkTo(state: State, tx: number, ty: number): State {
  let s = state;
  for (let guard = 0; guard < 400 && !(s.map.player.x === tx && s.map.player.y === ty); guard++) {
    const r = route(s, tx, ty);
    if (r === undefined) throw new Error(`${s.map.mapId} の (${tx}, ${ty}) へ行けない`);
    s = busy(s) && !s.map.player.moving ? settle(s) : stepOnce(s, r[0]!);
  }
  return s;
}

/** マップのイベント `id` の隣まで歩き、そちらを向いて話しかける。 */
function talk(state: State, id: string, answers: number[] = []): State {
  let s = state;
  const ev = mapOf(s.map.mapId).events[id as keyof MapData["events"]]!;
  const spot = STEPS.map(([d, dx, dy]) => ({ d, x: ev.x - dx, y: ev.y - dy }))
    .filter((p) => route(s, p.x, p.y) !== undefined)
    .sort((a, b) => route(s, a.x, a.y)!.length - route(s, b.x, b.y)!.length)[0];
  if (spot === undefined) throw new Error(`${id} に話しかけられる場所が無い`);
  s = walkTo(s, spot.x, spot.y);
  s = drive(s, ctx, [press(spot.d), ...idleFrames(2)]).state;
  seen = [];
  return settle(drive(s, ctx, [press("ok"), ...idleFrames(1)]).state, answers);
}

/** はじめの場面（自動実行）が終わるまで。 */
const newGame = (seed = "ghosts"): State => {
  const s = runReplay({ project: "fixtures/projects/v1/ghosts", seed, inputs: [], expect: {} }).state;
  seen = [];
  const settled = settle(driveUntil(s, ctx, busy, 60));
  return settled;
};
const withVars = (s: State, vars: Record<string, number>): State => ({ ...s, variables: { ...s.variables, ...vars } as State["variables"] });

const DOOR_X: Record<number, number> = { 1: 3, 2: 6, 3: 9 };
const FLOORS = [
  { n: 1, id: "map_floor1", ghosts: 4, time: 50 },
  { n: 2, id: "map_floor2", ghosts: 5, time: 60 },
  { n: 3, id: "map_floor3", ghosts: 6, time: 75 },
] as const;

/** 玄関ホールの扉 `n` の前まで歩いて突き当たり、「はじめる」を選ぶ（`answer` は選択肢の番号）。 */
function knock(state: State, n: number, answer = 0): State {
  let s = walkTo(state, DOOR_X[n]!, 2);
  s = drive(s, ctx, [press("up"), ...idleFrames(2)]).state;
  seen = [];
  return settle(s, [answer]);
}
/** 階がはじまって「よーい、スタート！」が終わるまで。 */
const begin = (s: State): State => settle(driveUntil(s, ctx, busy, 120));
const ghostsOf = (s: State) => Object.values(s.map.events).filter((e) => isGhost(e.id));
const liveGhosts = (s: State) => ghostsOf(s).filter((e) => e.pageIndex === 1);

interface Outcome { state: State; frames: number; caught: number }
/** 追いかけ役（いちばん近いおばけへ向かう）で、`until` が真になるか、玄関ホールへ戻るまで遊ぶ。 */
function chase(state: State, until: (s: State) => boolean = () => false, maxFrames = 60 * 200): Outcome {
  let s = state;
  const t0 = s.tick;
  const left0 = variable(s, "var_left");
  while (s.tick - t0 < maxFrames && s.map.mapId !== "map_lobby" && !until(s)) {
    if (busy(s) && !s.map.player.moving) {
      s = settle(s);
      continue;
    }
    const d = chaseDir(s);
    s = d === undefined ? drive(s, ctx, idleFrames(10)).state : driveUntil(drive(s, ctx, [press(d)]).state, ctx, (x) => !x.map.player.moving || x.message.open, 40);
  }
  return { state: s, frames: s.tick - t0, caught: left0 - variable(s, "var_left") };
}

/** 何もしないで、玄関ホールへ戻るまで（時間切れ）。 */
function idleOut(state: State): State {
  let s = state;
  for (let i = 0; i < 400 && s.map.mapId !== "map_lobby"; i++) s = busy(s) && !s.map.player.moving ? settle(s) : drive(s, ctx, idleFrames(60)).state;
  return s;
}

/** マップのタイルだけで見た、歩ける床（家具・壁は通れない）。 */
function floorTiles(map: MapData): Set<string> {
  const out = new Set<string>();
  for (let y = 0; y < map.height; y++) for (let x = 0; x < map.width; x++) {
    if (!map.layers.some((l) => passage[l.tiles[y * map.width + x] ?? 0] === 0 && (l.tiles[y * map.width + x] ?? 0) !== 0)) out.add(`${x},${y}`);
  }
  return out;
}
function distances(map: MapData, from: { x: number; y: number }): Map<string, number> {
  const floor = floorTiles(map);
  const dist = new Map<string, number>([[`${from.x},${from.y}`, 0]]);
  const queue: [number, number][] = [[from.x, from.y]];
  while (queue.length > 0) {
    const [x, y] = queue.shift()!;
    for (const [, dx, dy] of STEPS) {
      const k = `${x + dx},${y + dy}`;
      if (floor.has(k) && !dist.has(k)) {
        dist.set(k, dist.get(`${x},${y}`)! + 1);
        queue.push([x + dx, y + dy]);
      }
    }
  }
  return dist;
}
const eventsOf = (map: MapData, prefix: string) => Object.values(map.events).filter((e) => e.id.startsWith(prefix));

describe("おばけ屋敷の鬼ごっこのデモ（fixtures/projects/v1/ghosts）", () => {
  it("玄関ホールは画面（416×320）にちょうど収まり、階はそれより広い（スクロールする）。戦闘は無い", () => {
    expect(project.system.screen).toEqual({ width: 13 * 32, height: 10 * 32 });
    expect(Object.keys(maps).sort()).toEqual(["map_floor1", "map_floor2", "map_floor3", "map_lobby"]);
    expect([mapOf("map_lobby").width, mapOf("map_lobby").height]).toEqual([13, 10]);
    for (const f of FLOORS) {
      const m = mapOf(f.id);
      expect(m.width, f.id).toBeGreaterThan(13);
      expect(m.height, f.id).toBeGreaterThan(10);
    }
    expect(Object.keys(project.database.troops)).toEqual([]);
  });

  it.each(FLOORS)("$id：床はすべてつながっていて、おばけ・くつ・スタートに行ける。おばけは、はじめスタートから 5 歩以上はなれている", ({ id, ghosts, time }) => {
    const map = mapOf(id);
    const ready = map.events["ev_ready" as keyof MapData["events"]]!;
    const dist = distances(map, ready);
    expect(dist.size).toBe(floorTiles(map).size);
    const gs = eventsOf(map, "ev_ghost_");
    expect(gs).toHaveLength(ghosts);
    for (const g of gs) expect(dist.get(`${g.x},${g.y}`), g.id).toBeGreaterThanOrEqual(5);
    const boots = map.events["ev_boots" as keyof MapData["events"]]!;
    expect(dist.get(`${boots.x},${boots.y}`)).toBeDefined();
    // ふさぐ家具は、戸口には置かれない：どのおばけも別々のタイルに居る
    expect(new Set(gs.map((g) => `${g.x},${g.y}`)).size).toBe(gs.length);
    // 制限時間は、よーいの時に始めるタイマーと、扉が入れる時間（変数）で同じ
    const timer = ready.pages[0]!.commands.find((c) => c.code === "ControlTimer")!.params as { seconds: number };
    expect(timer.seconds).toBe(time);
  });

  it("おばけのイベントは 3 ページ（待機 → 遊び中 → つかまった）。遊び中は、逃げる動きを繰り返し、行き止まりは飛ばす", () => {
    for (const f of FLOORS) {
      for (const g of eventsOf(mapOf(f.id), "ev_ghost_")) {
        const [idle, play, caught] = g.pages;
        expect(g.pages, g.id).toHaveLength(3);
        expect(idle!.moveRoute, g.id).toBeUndefined();
        expect(play!.conditions).toEqual([{ kind: "switch", id: "sw_playing", value: true }]);
        expect(play!.trigger).toBe("touch");
        expect(play!.priority).toBe("same");
        expect(play!.moveRoute).toMatchObject({ repeat: true, skippable: true });
        expect(play!.moveRoute!.steps).toContainEqual({ kind: "move", dir: "away" });
        expect(caught!.conditions).toHaveLength(1);
        expect(caught!.through).toBe(true);
        expect(caught!.graphic).toBeUndefined();
      }
    }
  });

  it("はじめに管理人の話。2 階・3 階の扉は、前の階をクリアするまで開かない。「やめておく」なら始まらない", () => {
    let s = newGame();
    expect(s.map.mapId).toBe("map_lobby");
    expect(said()).toContain("管理人の じいさんが あなたを 呼んでいる");
    s = walkTo(s, 6, 2);
    s = drive(s, ctx, [press("up"), ...idleFrames(2)]).state;
    seen = [];
    s = settle(s);
    expect(said()).toContain("かぎが かかっている");
    expect(s.map.mapId).toBe("map_lobby");
    // 1 階は開いている：「やめておく」（選択肢 1）で、始まらない
    s = knock(s, 1, 1);
    expect(said()).toContain("おばけ 4ひき・制限時間 50びょう");
    expect(said()).not.toContain("スタート");
    expect(s.map.mapId).toBe("map_lobby");
    expect(on(s, "sw_ready")).toBe(false);
  });

  it.each(FLOORS)("$n かい：はじめると暗転して階に移り、よーいスタートのあと、のこり時間（変数）と画面右上のタイマーが同じ秒数で減っていく", ({ n, id, ghosts, time }) => {
    let s = withVars(newGame(), { var_cleared: n - 1 });
    s = knock(s, n);
    expect(s.map.mapId).toBe(id);
    expect(variable(s, "var_left")).toBe(ghosts);
    expect(variable(s, "var_time")).toBe(time);
    s = begin(s);
    expect(said()).toContain("スタート");
    expect(on(s, "sw_playing")).toBe(true);
    expect(s.timers.active).toBe(true);
    for (const frames of [1, 299, 600, 1500]) {
      s = drive(s, ctx, idleFrames(frames)).state;
      expect(Math.ceil(s.timers.ticks / 60), `${frames}`).toBe(variable(s, "var_time"));
    }
    expect(variable(s, "var_time")).toBeLessThan(time - 25);
  });

  it("おばけは、始まるまでは動かず、始まると勝手に動きまわる。つかまえられるのは始まってから", () => {
    let s = withVars(newGame(), {});
    s = knock(s, 1);
    const at = (x: State) => ghostsOf(x).map((e) => `${e.x},${e.y}`).join(" ");
    const before = at(s);
    s = driveUntil(s, ctx, (x) => x.message.open, 300);
    s = drive(s, ctx, idleFrames(120)).state;
    expect(at(s)).toBe(before);
    expect(ghostsOf(s).every((e) => e.pageIndex === 0)).toBe(true);
    s = begin(s);
    expect(liveGhosts(s)).toHaveLength(4);
    s = drive(s, ctx, idleFrames(600)).state;
    expect(at(s)).not.toBe(before);
  });

  it("つかまえると、名前と のこりの数が出て、そのおばけは消える。のこりは変数に数える", () => {
    let s = begin(knock(newGame(), 1));
    const r = chase(s, (x) => variable(x, "var_left") < 4 && !x.message.open);
    s = r.state;
    expect(variable(s, "var_left")).toBe(3);
    expect(said()).toMatch(/\\C\[0\]を つかまえた！\nのこり \\V\[var_left\]ひき/);
    const gone = ghostsOf(s).filter((e) => e.pageIndex === 2);
    expect(gone).toHaveLength(1);
    expect(gone[0]!.through).toBe(true);
    expect(on(s, `sw_g1_${gone[0]!.id.slice(-1)}`)).toBe(true);
    expect(on(s, "sw_playing")).toBe(true);
  });

  it.each(["a", "b", "c"])("追いかけ役で、3 つの階を順にクリアできる（のこり時間が記録になり、次の扉が開く）。シード %s", (seed) => {
    let s = newGame(seed);
    for (const f of FLOORS) {
      s = begin(knock(s, f.n));
      expect(s.map.mapId).toBe(f.id);
      const r = chase(s, () => false, 60 * f.time);
      s = settle(r.state);
      expect(s.map.mapId, `${f.id}: ${r.frames} フレーム`).toBe("map_lobby");
      expect(variable(s, "var_cleared")).toBe(f.n);
      expect(said()).toContain("ぜんいん つかまえた");
      // 玄関ホールの、その階の扉の前に戻る。足の速さも元に戻る
      expect([s.map.player.x, s.map.player.y]).toEqual([DOOR_X[f.n], 2]);
      expect(s.map.player.speed).toBe(4);
      expect(s.timers.active).toBe(false);
      // 手際のいい追いかけ役（人間より速い）なら、時間の半分もかからない
      const best = variable(s, `var_best${f.n}`);
      expect(best, `${f.id}: のこり ${best}`).toBeGreaterThanOrEqual(Math.ceil(f.time / 4));
      expect(best).toBeLessThanOrEqual(f.time);
    }
    expect(said()).toContain("鬼ごっこの 名人");
    // 全部クリアしたあとの管理人
    s = talk(s, "ev_keeper", [1]);
    expect(said()).toContain("すべての おばけを つかまえて くれた");
  });

  it("何もしないと時間切れ：玄関ホールに戻り、クリアは進まない。もう一度挑めて、おばけは元の位置・のこりも元に戻る", () => {
    let s = begin(knock(newGame(), 1));
    const start = eventsOf(mapOf("map_floor1"), "ev_ghost_");
    s = idleOut(s);
    expect(said()).toContain("じかんぎれ");
    expect(s.map.mapId).toBe("map_lobby");
    expect(variable(s, "var_cleared")).toBe(0);
    expect(variable(s, "var_best1")).toBe(0);
    expect(on(s, "sw_playing")).toBe(false);
    expect(s.timers.active).toBe(false);
    // 3 の扉はまだ閉まっている。1 の扉からもう一度
    s = begin(knock(s, 1));
    expect(s.map.mapId).toBe("map_floor1");
    expect(variable(s, "var_left")).toBe(4);
    expect(variable(s, "var_time")).toBeGreaterThanOrEqual(49);
    // ほぼ元の場所から（動き出して、まだ数歩）
    for (const g of ghostsOf(s)) {
      const home = start.find((e) => e.id === g.id)!;
      expect(Math.abs(g.x - home.x) + Math.abs(g.y - home.y), g.id).toBeLessThanOrEqual(4);
    }
    expect(ghostsOf(s).every((e) => e.pageIndex === 1)).toBe(true);
  });

  it("クリアしたあと、つかまえた記録のスイッチは次に始めるときに戻る（つかまえたおばけがまた現れる）", () => {
    let s = begin(knock(newGame("a"), 1));
    s = settle(chase(s).state);
    expect(variable(s, "var_cleared")).toBe(1);
    s = begin(knock(s, 1));
    expect(ghostsOf(s).every((e) => e.pageIndex === 1)).toBe(true);
    expect(variable(s, "var_left")).toBe(4);
  });

  it("記録は、よくなったときだけ更新する（ベストより悪い・同じなら、そのまま）", () => {
    let s = begin(knock(withVars(newGame("a"), { var_best1: 999 }), 1));
    s = settle(chase(s).state);
    expect(variable(s, "var_best1")).toBe(999);
    expect(said()).not.toContain("ベストきろく こうしん");

    s = begin(knock(withVars(newGame("a"), { var_best1: 1 }), 1));
    s = settle(chase(s).state);
    expect(variable(s, "var_best1")).toBeGreaterThan(1);
    expect(said()).toContain("ベストきろく こうしん");
  });

  it("くつを拾うと足が速くなる（その階の間だけ）", () => {
    let s = begin(knock(newGame("a"), 1));
    expect(s.map.player.speed).toBe(4);
    const boots = mapOf("map_floor1").events["ev_boots" as keyof MapData["events"]]!;
    seen = [];
    s = settle(walkTo(s, boots.x, boots.y));
    expect(said()).toContain("はやあしのくつ");
    expect(s.map.player.speed).toBe(5);
    expect(s.map.events["ev_boots" as keyof State["map"]["events"]]!.pageIndex).toBe(1);
    // おばけをつかまえきって玄関ホールに戻ると、元の速さ
    s = settle(chase(s).state);
    expect(s.map.mapId).toBe("map_lobby");
    expect(s.map.player.speed).toBe(4);
  });

  it("きろくの掲示板は、まだ遊んでいない階を「まだ」、遊んだ階をのこり秒数で見せる", () => {
    let s = withVars(newGame(), { var_best1: 23 });
    s = talk(s, "ev_board");
    expect(said()).toContain("1かい：のこり \\V[var_best1]びょう");
    expect(said()).not.toContain("1かい：まだ");
    expect(said()).toContain("2かい：まだ");
    expect(said()).toContain("3かい：まだ");
  });
});
