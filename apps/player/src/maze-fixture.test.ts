import { describe, expect, it } from "vitest";
import { drive, driveUntil, idleFrames, loadFixtureProject, press, runReplay } from "@rpg/test-utils";
import type { MapData, MapEvent } from "@rpg/schema";

// 迷宮デモ（fixtures/projects/v1/maze。tools/make-maze-demo.mjs が生成する）の約束ごと
const { project, maps, ctx } = loadFixtureProject("maze");
type State = ReturnType<typeof runReplay>["state"];
type Dir = "up" | "down" | "left" | "right";

const ROOMS = 20;
const roomId = (k: number): string => `map_room${String(k).padStart(2, "0")}`;
const roomOf = (id: string): number => Number(/^map_room(\d+)$/.exec(id)![1]);
const SIGN_ROOMS = [1, 5, 9, 13, 17];
const passage = Object.values(project.tilesets)[0]!.passage;

interface Door {
  dir: Dir;
  event: MapEvent;
  to: string;
  x: number;
  y: number;
}
/** 部屋の出入口（接触で場所移動するイベント）。 */
const doorsOf = (map: MapData): Door[] =>
  Object.values(map.events).flatMap((ev) => {
    // 押し戻しは、看板の記録による分岐のあとに標準の戻り先がある（最後の場所移動）
    const cmd = ev.pages[0]!.commands.filter((c) => c.code === "TransferPlayer").at(-1);
    if (cmd === undefined) return [];
    const p = cmd.params as { mapId: string; x: number; y: number };
    const dir: Dir = ev.y === 0 ? "up" : ev.y === map.height - 1 ? "down" : ev.x === 0 ? "left" : "right";
    return [{ dir, event: ev, to: p.mapId, x: p.x, y: p.y }];
  });

const blocked = (map: MapData, x: number, y: number): boolean =>
  map.layers.some((l) => {
    const t = l.tiles[y * map.width + x] ?? 0;
    return t !== 0 && passage[t] === 0;
  }) || Object.values(map.events).some((ev) => ev.x === x && ev.y === y && ev.pages[0]!.priority === "same");

/** (x, y) から (tx, ty) までの歩く向きの列（途中で出入口は踏まない）。行けなければ undefined。 */
function route(map: MapData, x: number, y: number, tx: number, ty: number): Dir[] | undefined {
  const doorAt = new Set(doorsOf(map).map((d) => `${d.event.x},${d.event.y}`));
  const prev = new Map<string, [string, Dir] | null>([[`${x},${y}`, null]]);
  const queue: [number, number][] = [[x, y]];
  const steps: [Dir, number, number][] = [["up", 0, -1], ["down", 0, 1], ["left", -1, 0], ["right", 1, 0]];
  while (queue.length > 0) {
    const [cx, cy] = queue.shift()!;
    for (const [d, dx, dy] of steps) {
      const nx = cx + dx;
      const ny = cy + dy;
      const k = `${nx},${ny}`;
      if (nx < 0 || ny < 0 || nx >= map.width || ny >= map.height || prev.has(k) || blocked(map, nx, ny)) continue;
      if (doorAt.has(k) && !(nx === tx && ny === ty)) continue;
      prev.set(k, [`${cx},${cy}`, d]);
      queue.push([nx, ny]);
    }
  }
  if (!prev.has(`${tx},${ty}`)) return undefined;
  const dirs: Dir[] = [];
  for (let k = `${tx},${ty}`, p = prev.get(k); p != null; k = p[0], p = prev.get(k)) dirs.unshift(p[1]);
  return dirs;
}

const settled = (s: State): boolean => !s.map.player.moving && s.map.transfer === undefined && s.interpreters.length === 0 && !s.message.open;

/** 1 歩ずつ歩かせる（core の step で。runtime 無し）。メッセージが出たら決定で送る。 */
function walk(state: State, dirs: readonly Dir[]): State {
  let s = state;
  for (const d of dirs) {
    s = drive(s, ctx, [press(d)]).state;
    for (let i = 0; i < 20 && !settled(s); i++) {
      s = driveUntil(s, ctx, (x) => settled(x) || x.message.open, 600);
      if (s.message.open) s = drive(s, ctx, [...idleFrames(2), press("ok")]).state;
    }
  }
  return drive(s, ctx, idleFrames(2)).state;
}

const start = (): State => runReplay({ project: "fixtures/projects/v1/maze", seed: "maze", inputs: [], expect: {} }).state;

describe("迷宮デモ（fixtures/projects/v1/maze）", () => {
  it("20 の部屋はどれも正方形で、第 1〜19 の間は上下左右に出入口がある（ゴールは入口だけ）", () => {
    expect(Object.keys(maps).sort()).toEqual(Array.from({ length: ROOMS }, (_, i) => roomId(i + 1)));
    for (const map of Object.values(maps)) {
      expect(map.width).toBe(map.height);
      const dirs = doorsOf(map).map((d) => d.dir).sort();
      expect(dirs, map.id).toEqual(roomOf(map.id) === ROOMS ? [expect.any(String)] : ["down", "left", "right", "up"]);
      for (const d of doorsOf(map)) expect(d.event.pages[0]).toMatchObject({ trigger: "touch", priority: "below" });
    }
    expect(project.system.screen).toEqual({ width: 11 * 32, height: 11 * 32 });
  });

  it("部屋を移るときは暗転する（場所移動の fade: black。暗転 → 場所移動 → 明転は TransferPlayer が行う）", () => {
    for (const map of Object.values(maps)) {
      for (const d of doorsOf(map)) {
        const transfer = d.event.pages[0]!.commands.find((c) => c.code === "TransferPlayer");
        expect(transfer?.params, `${map.id} の ${d.dir}`).toMatchObject({ fade: "black" });
      }
    }
  });

  it("出入口の行き先はどれも、行き先の部屋の通れるタイルで、出入口の上ではない", () => {
    for (const map of Object.values(maps)) {
      for (const d of doorsOf(map)) {
        const to = maps[d.to as keyof typeof maps];
        expect(to, `${map.id} の ${d.dir}`).toBeDefined();
        expect(blocked(to!, d.x, d.y), `${map.id} の ${d.dir} → ${d.to} (${d.x},${d.y})`).toBe(false);
        expect(doorsOf(to!).some((o) => o.event.x === d.x && o.event.y === d.y)).toBe(false);
      }
    }
  });

  it("先へ進める出入口は各部屋に 1 つだけ。間違いはループ（同じ間）か、手前の間への押し戻し", () => {
    const traps: number[] = [];
    for (let k = 1; k < ROOMS; k++) {
      const doors = doorsOf(maps[roomId(k) as keyof typeof maps]!);
      expect(doors.filter((d) => roomOf(d.to) === k + 1), roomId(k)).toHaveLength(1);
      for (const d of doors.filter((x) => roomOf(x.to) !== k + 1)) {
        const trap = d.event.pages[0]!.commands.some((c) => c.code === "ShowText");
        // 押し戻し（メッセージが出る）は 1 つ以上手前の間へ。それ以外は同じ間（ループ）か、1 つ前の間（来た道）
        if (trap) {
          expect(SIGN_ROOMS, `看板の間 ${roomId(k)} に風が吹いている`).not.toContain(k);
          expect(roomOf(d.to), `${roomId(k)} の ${d.dir}`).toBeLessThan(k);
          traps.push(roomOf(d.to));
        } else expect([k, k - 1], `${roomId(k)} の ${d.dir}`).toContain(roomOf(d.to));
      }
      expect(doors.some((d) => roomOf(d.to) === k), `${roomId(k)} にループが無い`).toBe(true);
    }
    // 押し戻しのある部屋はたくさんある。第 1 の間まで戻されるものも、看板の間まで戻されるものもある
    expect(traps.length).toBeGreaterThanOrEqual(10);
    expect(traps).toContain(1);
    expect(traps.some((to) => to > 1 && SIGN_ROOMS.includes(to))).toBe(true);
  });

  it("看板のある部屋では、看板が今いる間と出口までの残りを教える", () => {
    for (const map of Object.values(maps)) {
      const k = roomOf(map.id);
      const sign = map.events["ev_sign" as keyof typeof map.events];
      expect(sign !== undefined, map.id).toBe(SIGN_ROOMS.includes(k));
      if (sign === undefined) continue;
      const text = sign.pages[0]!.commands.map((c) => (c.params as { text?: string }).text ?? "").join("\n");
      expect(text).toContain(`第${k}の間`);
      if (k > 1) expect(text).toContain(`${ROOMS - k}`);
      // 看板の前（下）に立って読める
      expect(blocked(map, sign.x, sign.y + 1)).toBe(false);
    }
  });

  it("正解の出入口をたどると第 20 の間に着き、出口の光に触れるとクリアしてタイトルに戻る", () => {
    let s = start();
    expect(s.map.mapId).toBe(roomId(1));
    for (let k = 1; k < ROOMS; k++) {
      const map = maps[s.map.mapId as keyof typeof maps]!;
      const forward = doorsOf(map).find((d) => roomOf(d.to) === k + 1)!;
      const dirs = route(map, s.map.player.x, s.map.player.y, forward.event.x, forward.event.y);
      expect(dirs, `${map.id} で出入口へ行けない`).toBeDefined();
      s = walk(s, dirs!);
      expect(s.map.mapId).toBe(roomId(k + 1));
      expect([s.map.player.x, s.map.player.y]).toEqual([forward.x, forward.y]);
    }
    const goal = maps[roomId(ROOMS) as keyof typeof maps]!;
    const light = goal.events["ev_light" as keyof typeof goal.events]!;
    s = walk(s, route(goal, s.map.player.x, s.map.player.y, light.x, light.y)!);
    s = driveUntil(s, ctx, (x) => x.scene.kind === "title", 600);
    expect(s.scene.kind).toBe("title");
  });

  it("間違えると：ループは同じ間の反対側へ、押し戻しはメッセージのあと手前の間へ", () => {
    let s = start();
    const room1 = maps[roomId(1) as keyof typeof maps]!;
    const loop = doorsOf(room1).find((d) => d.to === roomId(1))!;
    s = walk(s, route(room1, s.map.player.x, s.map.player.y, loop.event.x, loop.event.y)!);
    expect([s.map.mapId, s.map.player.x, s.map.player.y]).toEqual([roomId(1), loop.x, loop.y]);

    // 第 2 の間へ進んでから、押し戻しの出入口に入る
    const forward = doorsOf(room1).find((d) => d.to === roomId(2))!;
    s = walk(s, route(room1, s.map.player.x, s.map.player.y, forward.event.x, forward.event.y)!);
    const room2 = maps[roomId(2) as keyof typeof maps]!;
    const trap = doorsOf(room2).find((d) => d.event.pages[0]!.commands.some((c) => c.code === "ShowText"))!;
    let sawMessage = false;
    for (const d of route(room2, s.map.player.x, s.map.player.y, trap.event.x, trap.event.y)!) {
      s = drive(s, ctx, [press(d)]).state;
      s = driveUntil(s, ctx, (x) => settled(x) || x.message.open, 600);
    }
    if (s.message.open) {
      sawMessage = s.message.text.includes("押し戻された");
      s = walk(drive(s, ctx, [...idleFrames(2), press("ok")]).state, []);
      s = driveUntil(s, ctx, settled, 600);
    }
    expect(sawMessage).toBe(true);
    expect([s.map.mapId, s.map.player.x, s.map.player.y]).toEqual([trap.to, trap.x, trap.y]);
  });

  it("看板を読むと覚えて、押し戻されるときは一番進んだ看板の部屋へ戻る（先の看板を読んだあとで手前の看板を読んでも戻らない）", () => {
    const readSign = (state: State, k: number): State => {
      const map = maps[roomId(k) as keyof typeof maps]!;
      const sign = map.events["ev_sign" as keyof typeof map.events]!;
      const s = walk(state, route(map, state.map.player.x, state.map.player.y, sign.x, sign.y + 1)!);
      let r = drive(s, ctx, [press("up"), ...idleFrames(2), press("ok")]).state;
      for (let i = 0; i < 20 && !settled(r); i++) {
        r = driveUntil(r, ctx, (x) => settled(x) || x.message.open, 600);
        if (r.message.open) r = drive(r, ctx, [...idleFrames(2), press("ok")]).state;
      }
      return r;
    };
    const checkpoint = (s: State): number => (s.variables as Record<string, number>)["var_maze_checkpoint"] ?? 0;
    /** 第 k の間から、標準の戻り先が 1 つ以上手前の押し戻しの出入口へ入る。 */
    const blown = (state: State, k: number): State => {
      const map = maps[roomId(k) as keyof typeof maps]!;
      const trap = doorsOf(map).find((d) => d.event.pages[0]!.commands.some((c) => c.code === "ShowText"))!;
      let s = state;
      for (const d of route(map, s.map.player.x, s.map.player.y, trap.event.x, trap.event.y)!) {
        s = drive(s, ctx, [press(d)]).state;
        s = driveUntil(s, ctx, (x) => settled(x) || x.message.open, 600);
      }
      for (let i = 0; i < 5 && !settled(s); i++) {
        if (s.message.open) s = drive(s, ctx, [...idleFrames(2), press("ok")]).state;
        s = driveUntil(s, ctx, (x) => settled(x) || x.message.open, 600);
      }
      return s;
    };
    // 第 1・5 の間の看板を読んでから、第 6 の間で押し戻される → 第 5 の間（標準なら第 1 の間）
    let s = readSign(start(), 1);
    expect(checkpoint(s)).toBe(1);
    const room1 = maps[roomId(1) as keyof typeof maps]!;
    const f1 = doorsOf(room1).find((d) => roomOf(d.to) === 2)!;
    s = walk(s, route(room1, s.map.player.x, s.map.player.y, f1.event.x, f1.event.y)!);
    expect(s.map.mapId).toBe(roomId(2));
    // 第 2〜4 の間の正解をたどって第 5 の間へ
    for (let k = 2; k < 5; k++) {
      const map = maps[s.map.mapId as keyof typeof maps]!;
      const f = doorsOf(map).find((d) => roomOf(d.to) === k + 1)!;
      s = walk(s, route(map, s.map.player.x, s.map.player.y, f.event.x, f.event.y)!);
    }
    s = readSign(s, 5);
    expect(checkpoint(s)).toBe(5);
    // 第 6 の間へ進んで押し戻される
    const room5 = maps[roomId(5) as keyof typeof maps]!;
    const f5 = doorsOf(room5).find((d) => roomOf(d.to) === 6)!;
    s = walk(s, route(room5, s.map.player.x, s.map.player.y, f5.event.x, f5.event.y)!);
    s = blown(s, 6);
    expect(s.map.mapId).toBe(roomId(5));
    expect(checkpoint(s)).toBe(5);
  });
});
