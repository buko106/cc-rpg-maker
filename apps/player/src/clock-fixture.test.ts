import type { MapData } from "@rpg/schema";
import { drive, driveUntil, idleFrames, loadFixtureProject, press, runReplay } from "@rpg/test-utils";
import { describe, expect, it } from "vitest";
import { initial, replay, roomOf, seenAtStart, solve, solveCatch } from "./clock-model.testkit.js";
import type { Move, Room } from "./clock-model.testkit.js";

// 時の番人の回廊のデモ（fixtures/projects/v1/clock。tools/make-clock-demo.mjs が生成する）の約束ごと。
// 部屋の手順は、clock-model.testkit.ts の「規則のモデル」で最短を探して、実際のエンジンで 1 手ずつ再生して確かめる
// （モデルの位置とエンジンの位置・番人の位置・岩の位置が、毎手そろうこと）。
const { project, maps, ctx } = loadFixtureProject("clock");
type State = ReturnType<typeof runReplay>["state"];

const ROOMS = ["map_r1", "map_r2", "map_r3", "map_r4"];
const tileset = Object.values(project.tilesets)[0]!;
const mapOf = (id: string): MapData => maps[id as keyof typeof maps]!;
const roomModel = (id: string): Room => roomOf(maps as Record<string, MapData>, tileset, id);
const START = { x: 7, y: 8 };

const busy = (s: State): boolean =>
  s.map.player.moving || Object.values(s.map.events).some((e) => e.moving) || s.map.transfer !== undefined || s.interpreters.some((i) => i.mode === "normal") || s.message.open || s.scene.kind !== "map";
const variable = (s: State, id: string): number => s.variables[id as keyof State["variables"]] ?? 0;

/** 進めている間に出たメッセージ。 */
let seen: string[] = [];
const said = (): string => seen.join("\n");

/** メッセージを決定で閉じながら、イベントが終わるまで進める。`choose` は選択肢のときに選ぶ番号（既定は先頭）。 */
function settle(state: State, choose = 0): State {
  let s = state;
  for (let i = 0; i < 400 && busy(s); i++) {
    if (s.scene.kind !== "map") return s;
    if (s.message.open) {
      s = drive(s, ctx, idleFrames(2)).state;
      if (s.message.text !== "") seen.push(s.message.text);
      if (s.message.choices !== null) {
        const downs = Array.from({ length: choose }, () => [press("down"), ...idleFrames(1)]).flat();
        s = drive(s, ctx, [...downs, press("ok"), ...idleFrames(1)]).state;
      } else s = drive(s, ctx, [press("ok"), ...idleFrames(1)]).state;
    } else s = driveUntil(s, ctx, (x) => !busy(x) || x.message.open || x.scene.kind !== "map", 600);
  }
  return s;
}

/** 文章を決定で送りながら、選択肢が出るまで進める。 */
function untilChoices(state: State): State {
  let s = state;
  for (let i = 0; i < 200 && !(s.message.open && s.message.choices !== null); i++) {
    if (s.message.open) {
      s = drive(s, ctx, idleFrames(2)).state;
      if (s.message.text !== "" && s.message.choices === null) seen.push(s.message.text);
      if (s.message.choices === null) s = drive(s, ctx, [press("ok"), ...idleFrames(1)]).state;
    } else s = drive(s, ctx, idleFrames(1)).state;
  }
  return s;
}

/** 部屋のはじまりの場所に立った状態（ロビーから、本物の場所移動で入る）。 */
function enter(id: string, seed = "clock"): State {
  seen = [];
  const s = runReplay({ project: "fixtures/projects/v1/clock", seed, inputs: [], expect: {} }).state;
  const started = driveUntil(s, ctx, (x) => !busy(x), 200);
  const moved = { ...started, interpreters: [], message: { ...started.message, open: false }, map: { ...started.map, transfer: { to: id as never, x: START.x, y: START.y, dir: "up" as const, fade: "none" as const, requested: false } } };
  return driveUntil(drive(moved, ctx, idleFrames(3)).state, ctx, (x) => !busy(x), 200);
}

/** プレイヤーの 1 手を打って、みんなの動きが止まるまで進める。 */
function play(s: State, move: Move): State {
  const button = move === "wait" ? "ok" : move;
  return driveUntil(drive(s, ctx, [press(button)]).state, ctx, (x) => !busy(x), 400);
}

/** エンジンの状態から、モデルの状態と同じ形の数字を取り出す（位置・向き）。 */
function snapshot(s: State, room: Room) {
  const k = (e: { x: number; y: number }): number => e.y * room.w + e.x;
  return {
    player: k(s.map.player),
    rocks: room.rocks.map((r) => k(s.map.events[r.id as never]!)),
    guards: room.guards.map((g) => [k(s.map.events[g.id as never]!), s.map.events[g.id as never]!.direction[0]]),
  };
}

describe("fixtures/projects/v1/clock（時の番人の回廊）", () => {
  it("部屋は 5 つ（ロビー + 4 つの部屋）。部屋はどれも 1 画面で、番人の移動ルートはすべてターン制", () => {
    expect(Object.keys(maps).sort()).toEqual(["map_hall", ...ROOMS].sort());
    for (const id of Object.keys(maps)) expect([mapOf(id).width, mapOf(id).height]).toEqual([15, 11]);
    for (const id of ROOMS) {
      const guards = Object.values(mapOf(id).events).filter((e) => e.id.startsWith("ev_guard_"));
      for (const g of guards) {
        expect(g.pages[0]).toMatchObject({ trigger: "eventSight", priority: "same", moveRoute: { repeat: true, pace: "playerStep" } });
        expect(g.pages[0]!.commands.at(-1)).toMatchObject({ code: "TransferPlayer", params: { mapId: id, ...START } });
      }
    }
  });

  describe.each(ROOMS)("%s", (id) => {
    const room = roomModel(id);
    const solution = solve(room);

    it("部屋に入った瞬間には見つからない。最短の手順でぬけられる", () => {
      expect(seenAtStart(room)).toBe(false);
      expect(solution).toBeDefined();
      expect(replay(room, solution!.moves).ok).toBe(true);
    });

    it("手順を実際のエンジンで 1 手ずつ再生すると、プレイヤー・番人・岩の位置が毎手モデルと一致し、一度もつかまらずに出口へ着く", () => {
      let s = enter(id);
      expect(snapshot(s, room)).toEqual({ ...snapshot(s, room), player: initial(room).player, rocks: initial(room).rocks });
      const model = replay(room, solution!.moves).states;
      const last = solution!.moves.length - 1;
      solution!.moves.forEach((move, i) => {
        s = play(s, move);
        expect(variable(s, "var_caught"), `${i + 1} 手目（${move}）でつかまった`).toBe(0);
        if (i === last) return;
        const m = model[i]!;
        expect(snapshot(s, room), `${i + 1} 手目（${move}）`).toEqual({ player: m.player, rocks: m.rocks, guards: m.guards.map(([k, d]) => [k, d[0]]) });
      });
      // 最後の手で出口に着いて、次の部屋へ（最後の部屋は、歯車を取ってタイトルへ）
      const next = ROOMS[ROOMS.indexOf(id) + 1];
      if (next === undefined) {
        const said: string[] = [];
        for (let i = 0; i < 30 && s.scene.kind === "map"; i++) {
          if (s.message.open) {
            if (s.message.text !== "") said.push(s.message.text);
            s = drive(s, ctx, [press("ok"), ...idleFrames(2)]).state;
          } else s = driveUntil(s, ctx, (x) => x.message.open || x.scene.kind !== "map", 200);
        }
        expect(said.join("\n")).toContain("時の歯車");
        expect(s.scene.kind).toBe("title");
      }
      else expect(s.map.mapId).toBe(next);
    });
  });

  describe("つかまる", () => {
    /** 手順を実際のエンジンで打って、つかまったところ（イベントが始まったところ）の状態。 */
    function caughtBy(id: string, moves: Move[]): State {
      let s = enter(id);
      for (const m of moves) s = play(s, m);
      return s;
    }

    it.each(ROOMS)("%s：視界に入ると、つかまって、部屋のはじまりへ戻される（番人も岩も最初の位置から、手数も数え直し）", (id) => {
      const room = roomModel(id);
      const moves = solveCatch(room, "sight");
      expect(moves, "視界に入る手順がある").toBeDefined();
      let s = caughtBy(id, moves!);
      expect(s.message.open || s.interpreters.some((i) => i.mode === "normal")).toBe(true);
      s = settle(s);
      expect(said()).toContain("見つかった");
      expect(variable(s, "var_caught")).toBe(1);
      expect(s.map.mapId).toBe(id);
      expect(s.map.player).toMatchObject(START);
      const first = initial(room);
      expect(snapshot(s, room)).toEqual({ player: first.player, rocks: first.rocks, guards: first.guards.map(([k, d]) => [k, d[0]]) });
      expect(s.map.turns ?? 0).toBe(0);
    });

    it("番人の歩く先に居ても（視界の外から歩いてきて、ぶつかるとき）つかまる", () => {
      const room = ROOMS.map(roomModel).find((r) => solveCatch(r, "touch") !== undefined);
      expect(room, "ぶつかってつかまる部屋がある").toBeDefined();
      let s = caughtBy(room!.id, solveCatch(room!, "touch")!);
      s = settle(s);
      expect(said()).toContain("見つかった");
      expect(variable(s, "var_caught")).toBe(1);
      expect(s.map.player).toMatchObject(START);
    });

    it("岩を動かしたあとでつかまっても、岩はもとの場所に戻る（第三の間）", () => {
      const room = roomModel("map_r3");
      // 岩を 1 つ上に押してから（まだ廊下に入っていない）、見つかる
      const pushed = solve(room)!.moves.slice(0, 6);
      const after = replay(room, pushed).states.at(-1)!;
      expect(after.rocks).not.toEqual(initial(room).rocks);
      const caught = solveCatch(room, "sight", { from: after });
      expect(caught).toBeDefined();
      let s = enter("map_r3");
      for (const m of [...pushed, ...caught!]) s = play(s, m);
      s = settle(s);
      expect(said()).toContain("見つかった");
      expect(snapshot(s, room).rocks).toEqual(initial(room).rocks);
    });
  });

  describe("入口の階段", () => {
    const bump = (id: string): State => untilChoices(drive(enter(id), ctx, [press("down"), ...idleFrames(1)]).state);

    it("第一の間：階段にぶつかると、ロビーへ もどる／やりなおす／やめる を選べる", () => {
      const s = bump("map_r1");
      expect(s.message.choices).toEqual(["ロビーへ もどる", "この 部屋を はじめから やりなおす", "やめる"]);
      const home = settle(s, 0);
      expect(home.map.mapId).toBe("map_hall");
      expect([home.map.player.x, home.map.player.y]).toEqual([7, 2]);
    });

    it("やりなおすを選ぶと、部屋の奥へ進んでいても、はじまりの場所へ戻る（番人も最初から）", () => {
      const room = roomModel("map_r1");
      let s = enter("map_r1");
      s = play(play(s, "up"), "wait");
      expect(s.map.player.y).toBe(START.y - 1);
      // はじまりの場所へ戻ってから、階段にぶつかる（階段は 1 つ下）。そこまでは普通に歩いて戻る
      s = play(s, "down");
      s = untilChoices(drive(s, ctx, [press("down"), ...idleFrames(1)]).state);
      expect(s.message.choices).toHaveLength(3);
      s = settle(s, 1);
      expect(s.map.mapId).toBe("map_r1");
      expect(s.map.player).toMatchObject(START);
      const first = initial(room);
      expect(snapshot(s, room)).toEqual({ player: first.player, rocks: first.rocks, guards: first.guards.map(([k, d]) => [k, d[0]]) });
    });

    it("第二の間より先は、やりなおす／やめる だけ。やめるとそのまま", () => {
      const s = bump("map_r2");
      expect(s.message.choices).toEqual(["この 部屋を はじめから やりなおす", "やめる"]);
      const cancelled = settle(s, 1);
      expect(cancelled.map.mapId).toBe("map_r2");
      expect(cancelled.map.player).toMatchObject(START);
    });
  });

  describe("ロビー", () => {
    it("はじめに あらすじ、時計守に話しかけると 遊び方を教えてくれる。奥の扉から第一の間へ", () => {
      seen = [];
      const s0 = runReplay({ project: "fixtures/projects/v1/clock", seed: "clock", inputs: [], expect: {} }).state;
      let s = settle(driveUntil(s0, ctx, busy, 60));
      expect(said()).toContain("時の歯車");
      expect(s.map.mapId).toBe("map_hall");
      expect(s.map.player).toMatchObject(START);
      // 時計守（7, 4）に話しかける（下から 3 歩上がって、上を向いて決定）
      seen = [];
      s = driveUntil(drive(s, ctx, [press("up")]).state, ctx, (x) => !x.map.player.moving, 60);
      s = driveUntil(drive(s, ctx, [press("up")]).state, ctx, (x) => !x.map.player.moving, 60);
      s = driveUntil(drive(s, ctx, [press("up")]).state, ctx, (x) => !x.map.player.moving, 60);
      s = drive(s, ctx, [press("ok"), ...idleFrames(1)]).state;
      s = settle(s, 1); // 「待ちかた」
      expect(said()).toContain("決定ボタン");
      expect(said()).toContain("つかまった 回数は \\V[var_caught]回");
      // 扉へ（時計守をよけて、左を回る）
      for (const m of ["left", "up", "up", "up", "right", "up"] as const) s = driveUntil(drive(s, ctx, [press(m)]).state, ctx, (x) => !x.map.player.moving, 60);
      s = driveUntil(s, ctx, (x) => !busy(x), 200);
      expect(s.map.mapId).toBe("map_r1");
      expect(s.map.player).toMatchObject(START);
    });
  });

  it("はじめから終わりまで：4 つの部屋の手順を順に打つと、一度もつかまらずに歯車を取って、タイトルへ戻る（同じ入力なら同じ結果）", () => {
    const run = (): { state: State; said: string } => {
      seen = [];
      const s0 = runReplay({ project: "fixtures/projects/v1/clock", seed: "clock", inputs: [], expect: {} }).state;
      let s = settle(driveUntil(s0, ctx, busy, 60));
      // ロビー：入り口（7, 8）から扉（7, 1）まで。時計守（7, 4）をよけて、左の列（6）を通る
      const lobby: Move[] = ["left", "up", "up", "up", "up", "up", "up", "right", "up"];
      for (const m of lobby) s = play(s, m);
      s = driveUntil(s, ctx, (x) => !busy(x), 200);
      expect(s.map.mapId).toBe("map_r1");
      for (const id of ROOMS) {
        expect(s.map.mapId).toBe(id);
        for (const m of solve(roomModel(id))!.moves) s = play(s, m);
        s = driveUntil(s, ctx, (x) => !busy(x) || x.message.open || x.scene.kind !== "map", 400);
      }
      s = settle(s);
      return { state: s, said: said() };
    };
    const a = run();
    expect(a.state.scene.kind).toBe("title");
    expect(a.said).toContain("時の歯車");
    expect(a.said).toContain("つかまった 回数：\\V[var_caught]回");
    expect(variable(a.state, "var_caught")).toBe(0);
    expect(run().state).toEqual(a.state);
  }, 60_000);
});
