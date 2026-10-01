import { describe, expect, it } from "vitest";
import { drive, driveUntil, idleFrames, loadFixtureProject, press, runReplay } from "@rpg/test-utils";
import type { MapData } from "@rpg/schema";

// おばけ屋敷の追いかけっこのデモ（fixtures/projects/v1/haunted。tools/make-haunted-demo.mjs が生成する）の約束ごと
const { project, maps, ctx } = loadFixtureProject("haunted");
type State = ReturnType<typeof runReplay>["state"];
type Dir = "up" | "down" | "left" | "right";

const mapOf = (id: string): MapData => maps[id as keyof typeof maps]!;
const passage = Object.values(project.tilesets)[0]!.passage;
const STEPS: [Dir, number, number][] = [["up", 0, -1], ["down", 0, 1], ["left", -1, 0], ["right", 1, 0]];

const isGhost = (id: string): boolean => id.startsWith("ev_ghost_");
const variable = (s: State, id: string): number => s.variables[id as keyof State["variables"]] ?? 0;
const busy = (s: State): boolean => s.map.player.moving || s.map.transfer !== undefined || s.interpreters.some((i) => i.mode === "normal") || s.message.open || s.scene.kind !== "map";
const ghostsOf = (s: State) => Object.values(s.map.events).filter((ev) => isGhost(ev.id) && ev.pageIndex !== null);
const ghostAt = (s: State, id: string) => s.map.events[id as keyof State["map"]["events"]]!;

/** タイルが通れないか（壁・家具・居座るイベント）。`avoid` のタイルも通れないとみなす。`ghosts` が偽なら、おばけは数えない（ぶつかって捕まる）。 */
function blocked(s: State, map: MapData, x: number, y: number, avoid: ReadonlySet<string>, ghosts = true): boolean {
  if (x < 0 || y < 0 || x >= map.width || y >= map.height || avoid.has(`${x},${y}`)) return true;
  if (map.layers.some((l) => {
    const t = l.tiles[y * map.width + x] ?? 0;
    return t !== 0 && passage[t] === 0;
  })) return true;
  return Object.values(s.map.events).some((ev) => ev.x === x && ev.y === y && ev.pageIndex !== null && !ev.through && ev.priority === "same" && (ghosts || !isGhost(ev.id)));
}

/** (tx, ty) への道（歩く向きの列）。`avoid` のタイルは通らない。 */
function route(s: State, tx: number, ty: number, avoid: ReadonlySet<string> = new Set(), ghosts = true): Dir[] | undefined {
  const map = mapOf(s.map.mapId);
  const { x, y } = s.map.player;
  const prev = new Map<string, [string, Dir] | null>([[`${x},${y}`, null]]);
  const queue: [number, number][] = [[x, y]];
  while (queue.length > 0) {
    const [cx, cy] = queue.shift()!;
    for (const [d, dx, dy] of STEPS) {
      const [nx, ny] = [cx + dx, cy + dy];
      const k = `${nx},${ny}`;
      // 目的地が壁（扉）でも、そこへ突き当たる道は数える
      if (prev.has(k) || (!(nx === tx && ny === ty) && blocked(s, map, nx, ny, avoid, ghosts))) continue;
      prev.set(k, [`${cx},${cy}`, d]);
      queue.push([nx, ny]);
    }
  }
  if (!prev.has(`${tx},${ty}`)) return undefined;
  const dirs: Dir[] = [];
  for (let k = `${tx},${ty}`, p = prev.get(k); p != null; k = p[0], p = prev.get(k)) dirs.unshift(p[1]);
  return dirs;
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

const stepOnce = (s: State, d: Dir): State => driveUntil(drive(s, ctx, [press(d)]).state, ctx, (x) => !x.map.player.moving, 60);

/** (tx, ty) まで歩く（おばけは考えない）。途中でイベントが始まったら、それが終わるまで進めて止まる。 */
function walkTo(state: State, tx: number, ty: number, answers: number[] = []): State {
  let s = state;
  const mapId = s.map.mapId;
  for (let guard = 0; guard < 200 && s.map.mapId === mapId && !(s.map.player.x === tx && s.map.player.y === ty); guard++) {
    if (busy(s) && !s.map.player.moving) return settle(s, answers);
    const r = route(s, tx, ty);
    if (r === undefined) throw new Error(`${s.map.mapId} の (${tx}, ${ty}) へ行けない`);
    s = stepOnce(s, r[0]!);
  }
  return busy(s) ? settle(s, answers) : s;
}

/** はじめの場面（自動実行）が終わるまで。 */
const newGame = (seed = "haunted"): State => {
  const s = runReplay({ project: "fixtures/projects/v1/haunted", seed, inputs: [], expect: {} }).state;
  seen = [];
  return settle(driveUntil(s, ctx, busy, 60));
};
const withVars = (s: State, vars: Record<string, number>): State => ({ ...s, variables: { ...s.variables, ...vars } as State["variables"] });

const DOOR_X: Record<number, number> = { 1: 3, 2: 6, 3: 9 };
const FLOORS = [
  { n: 1, id: "map_floor1", candles: 4, start: { x: 8, y: 2 } },
  { n: 2, id: "map_floor2", candles: 5, start: { x: 10, y: 2 } },
  { n: 3, id: "map_floor3", candles: 6, start: { x: 10, y: 2 } },
] as const;

/** 玄関ホールの扉 `n` に突き当たって、選択肢に答える（0 = 入る）。 */
const knock = (state: State, n: number, answer = 0): State => {
  seen = [];
  return walkTo(walkTo(state, DOOR_X[n]!, 2), DOOR_X[n]!, 1, [answer]);
};

/** 待ちの間、何もせずに進める（おばけが来たら捕まる）。 */
function idle(state: State, frames: number, until: (s: State) => boolean): State {
  let s = state;
  for (let i = 0; i < frames && !until(s); i++) s = drive(s, ctx, idleFrames(1)).state;
  return s;
}

/** おばけから `r` 歩以内のタイル（通り抜けのおばけは遅いので 1 歩以内）。 */
function danger(s: State, r: number): Set<string> {
  const out = new Set<string>();
  for (const g of ghostsOf(s)) {
    const k = g.through ? Math.min(r, 1) : r;
    for (let dy = -k; dy <= k; dy++) for (let dx = -k; dx <= k; dx++) if (Math.abs(dx) + Math.abs(dy) <= k) out.add(`${g.x + dx},${g.y + dy}`);
  }
  return out;
}
const nearest = (s: State, x: number, y: number): number => Math.min(...ghostsOf(s).map((g) => Math.abs(g.x - x) + Math.abs(g.y - y)));

/**
 * その階のろうそくを全部集めるまで歩く。いちばん近いろうそくへ、おばけから 2 歩（だめなら 1 歩）離れた道を行く。
 * そういう道が無ければ、おばけが近いときは離れる方へ 1 歩逃げ、そうでなければ少し待つ（待ちすぎたら構わず進む）。
 * 捕まったら入口からやり直す（拾ったろうそくは残る）。玄関ホールに戻ったら終わり。
 */
function collect(state: State, n: number): { state: State; caught: number } {
  let s = state;
  const floor = FLOORS[n - 1]!;
  const before = variable(s, "var_caught");
  const map = mapOf(floor.id);
  let waited = 0;
  for (let guard = 0; guard < 4000 && s.map.mapId === floor.id; guard++) {
    if (busy(s) && !s.map.player.moving) {
      s = settle(s);
      continue;
    }
    const left = Object.values(map.events).filter((ev) => ev.id.startsWith("ev_candle_") && s.map.events[ev.id]?.graphic !== undefined);
    const best = (r: number) => left.map((ev) => route(s, ev.x, ev.y, danger(s, r))).filter((p) => p !== undefined && p.length > 0).sort((a, b) => a!.length - b!.length)[0];
    // 待ちすぎたら、おばけに構わず進む
    const next = best(2) ?? best(1) ?? (waited > 30 ? best(0) : undefined);
    if (next !== undefined) {
      waited = 0;
      s = stepOnce(s, next[0]!);
      continue;
    }
    waited++;
    const { x, y } = s.map.player;
    const mapData = mapOf(s.map.mapId);
    const away = STEPS.filter(([, dx, dy]) => !blocked(s, mapData, x + dx, y + dy, new Set()))
      .map(([d, dx, dy]) => ({ d, far: nearest(s, x + dx, y + dy) }))
      .sort((a, b) => b.far - a.far)[0];
    if (nearest(s, x, y) <= 3 && away !== undefined && away.far > nearest(s, x, y)) s = stepOnce(s, away.d);
    else s = drive(s, ctx, idleFrames(8)).state;
  }
  if (s.map.mapId === floor.id) throw new Error(`${floor.id}: 集めきれない ${JSON.stringify([variable(s, `var_c${n}`), variable(s, "var_caught") - before, s.map.player.x, s.map.player.y])}`);
  return { state: s, caught: variable(s, "var_caught") - before };
}

describe("fixtures/projects/v1/haunted（おばけ屋敷の追いかけっこ）", () => {
  it("玄関ホールと 3 つの階。ろうそくは 4・5・6 本、おばけのページは「イベントから接触」の自律移動", () => {
    expect(Object.keys(maps).sort()).toEqual(["map_floor1", "map_floor2", "map_floor3", "map_hall"]);
    for (const f of FLOORS) {
      const events = Object.values(mapOf(f.id).events);
      expect(events.filter((e) => e.id.startsWith("ev_candle_"))).toHaveLength(f.candles);
      const ghosts = events.filter((e) => isGhost(e.id));
      expect(ghosts.length).toBeGreaterThanOrEqual(3);
      for (const g of ghosts) {
        expect(g.pages).toHaveLength(1);
        expect(g.pages[0]).toMatchObject({ trigger: "eventTouch", priority: "same", moveRoute: { repeat: true } });
        expect(g.pages[0]!.commands.at(-1)).toMatchObject({ code: "TransferPlayer", params: { mapId: f.id, ...f.start } });
      }
      // 近づく・離れる・通り抜けのおばけがいる
      const dirs = ghosts.flatMap((g) => g.pages[0]!.moveRoute!.steps.map((st) => (st.kind === "move" ? st.dir : st.kind)));
      expect(dirs).toContain("toward");
      if (f.n >= 2) expect(ghosts.some((g) => g.pages[0]!.through)).toBe(true);
      if (f.n === 3) expect(dirs).toContain("away");
    }
  });

  it("はじめは執事が話しかけてと言い、2・3 の扉には鍵がかかっている", () => {
    let s = newGame();
    expect(s.map.mapId).toBe("map_hall");
    expect(said()).toContain("執事");
    s = knock(s, 2);
    expect(said()).toContain("かぎが かかっている");
    expect(s.map.mapId).toBe("map_hall");
    s = knock(s, 1, 1); // やめておく
    expect(s.map.mapId).toBe("map_hall");
    s = knock(s, 1);
    expect(s.map).toMatchObject({ mapId: "map_floor1", player: { x: 8, y: 2 } });
  });

  it("階は暗い色調（並列イベントの TintScreen）で、全部の階を終えた玄関ホールは明るい", () => {
    const tints = (s: State, frames: number) => {
      const out: { a: number }[] = [];
      for (let i = 0; i < frames; i++) {
        const r = drive(s, ctx, idleFrames(1));
        s = r.state;
        for (const e of r.effects) if (e.kind === "screenTint") out.push(e.color);
      }
      return out;
    };
    const s = knock(newGame(), 1);
    const dark = tints(s, 130);
    expect(dark.length).toBeGreaterThanOrEqual(2); // かけ続ける
    expect(dark[0]!.a).toBeGreaterThan(0.3);
    const hall = tints(newGame(), 70);
    expect(hall[0]!.a).toBeGreaterThan(0);
    expect(hall[0]!.a).toBeLessThan(dark[0]!.a);
    const done = tints(withVars(newGame(), { var_cleared: 3 }), 70);
    expect(done.at(-1)!.a).toBe(0);
  });

  it("おばけの方から触れてくると捕まり、入口へ戻される。おばけも元の位置から。拾ったろうそくは残る", () => {
    let s = knock(newGame(), 1);
    // 1 本拾ってから、入口で待つ
    const candle = mapOf("map_floor1").events["ev_candle_1" as never]!;
    s = walkTo(s, candle.x, candle.y);
    expect(variable(s, "var_c1")).toBe(1);
    expect(variable(s, "var_left")).toBe(3);
    expect(said()).toContain("あと \\V[var_left]本");
    s = walkTo(s, 8, 2);
    s = idle(s, 3000, (x) => x.interpreters.some((i) => i.mode === "normal"));
    // 立ち止まっていても、向こうから来て捕まえる（プレイヤーからは動いていない）
    const catcher = ghostsOf(s).find((g) => Math.abs(g.x - s.map.player.x) + Math.abs(g.y - s.map.player.y) === 1);
    expect(catcher).toBeDefined();
    // 決定でメッセージを閉じると、入口へ移される。移った瞬間、おばけも元の位置に戻っている
    seen = [];
    s = drive(s, ctx, idleFrames(2)).state;
    seen.push(s.message.text);
    expect(said()).toContain("つかまった");
    // 場所移動は暗転したところで（予約と同じフレームに）行われる
    const home = (x: State) => ghostsOf(x).every((g) => {
      const def = mapOf("map_floor1").events[g.id]!;
      return g.x === def.x && g.y === def.y;
    });
    expect(home(s)).toBe(false);
    s = drive(s, ctx, [press("ok")]).state;
    s = driveUntil(s, ctx, home, 120);
    expect(home(s)).toBe(true);
    expect(s.map.player).toMatchObject({ x: 8, y: 2 });
    s = settle(s);
    expect(s.map).toMatchObject({ mapId: "map_floor1", player: { x: 8, y: 2 } });
    expect(variable(s, "var_caught")).toBe(1);
    expect(variable(s, "var_c1")).toBe(1);
    expect(s.map.events["ev_candle_1" as never]!.graphic).toBeUndefined();
  });

  it("かげろう（通り抜け）は、壁にかこまれた所から抜け出してくる", () => {
    let s = knock(withVars(newGame(), { var_cleared: 1 }), 2);
    expect(s.map.mapId).toBe("map_floor2");
    const phantom = ghostsOf(s).find((g) => g.through)!;
    const start = { x: phantom.x, y: phantom.y };
    // 壁にかこまれた柱（x = 10、y = 5〜7）の中から始まる
    expect(start.x).toBe(10);
    expect(start.y).toBeGreaterThanOrEqual(5);
    expect(start.y).toBeLessThanOrEqual(7);
    expect([[9, 6], [11, 6], [10, 4], [10, 8]].every(([x, y]) => blocked(s, mapOf("map_floor2"), x!, y!, new Set()))).toBe(true);
    s = idle(s, 900, () => false);
    const moved = ghostAt(s, phantom.id);
    expect(Math.abs(moved.x - start.x) + Math.abs(moved.y - start.y)).toBeGreaterThan(0);
    expect(moved.x !== 10 || moved.y < 5 || moved.y > 7).toBe(true);
  });

  it("ほむら（いたずら）は、近づいてきては離れていく", () => {
    let s = knock(withVars(newGame(), { var_cleared: 2 }), 3);
    expect(s.map.mapId).toBe("map_floor3");
    const id = ghostsOf(s).find((g) => mapOf("map_floor3").events[g.id]!.pages[0]!.moveRoute!.steps.some((st) => st.kind === "move" && st.dir === "away"))!.id;
    // プレイヤーを近くの決まった場所に置いたまま、距離の変化を見る
    const dist = (x: State) => Math.abs(ghostAt(x, id).x - x.map.player.x) + Math.abs(ghostAt(x, id).y - x.map.player.y);
    // ほむらの居る真ん中の部屋の、すみ
    s = { ...s, map: { ...s.map, player: { ...s.map.player, x: 14, y: 7, realX: 14, realY: 7 } } };
    const ds: number[] = [];
    for (let i = 0; i < 240 && !busy(s); i++) {
      s = drive(s, ctx, idleFrames(1)).state;
      ds.push(dist(s));
    }
    const closest = Math.min(...ds);
    const after = ds.slice(ds.indexOf(closest));
    expect(closest).toBeLessThan(ds[0]!);
    expect(Math.max(...after)).toBeGreaterThan(closest); // 離れる
  });

  it.each(["haunted", "seed-2", "seed-3"])("通しプレイ（シード %s）：3 つの階のろうそくを全部集めるとエンディングでタイトルに戻る", (seed) => {
    let s = newGame(seed);
    let caught = 0;
    for (const f of FLOORS) {
      s = knock(s, f.n);
      expect(s.map.mapId).toBe(f.id);
      seen = [];
      const r = collect(s, f.n);
      s = r.state;
      caught += r.caught;
      expect(variable(s, `var_c${f.n}`)).toBe(f.candles);
      expect(said()).toContain("ぜんぶ 集めた");
      expect(s.map).toMatchObject({ mapId: "map_hall", player: { x: DOOR_X[f.n], y: 2 } });
      expect(variable(s, "var_cleared")).toBe(f.n);
      if (f.n < 3) {
        // 終えた階にはもう入れない
        s = knock(s, f.n);
        expect(said()).toContain("もう ぜんぶ 集めた");
        expect(s.map.mapId).toBe("map_hall");
      }
    }
    expect(variable(s, "var_total")).toBe(15);
    expect(variable(s, "var_caught")).toBe(caught);
    // 最後の階から戻るとエンディング
    seen = [];
    s = settle(driveUntil(s, ctx, busy, 30));
    expect(said()).toContain("おめでとう");
    expect(said()).toContain("つかまった 回数");
    expect(s.scene.kind).toBe("title");
  });
});
