import type { MapData } from "@rpg/schema";
import { drive, driveUntil, idleFrames, loadFixtureProject, press, runReplay } from "@rpg/test-utils";
import { describe, expect, it } from "vitest";
import { initial, MOVES, play as play_, replay, roomOf, solve, solveCatch, withRoom } from "./onigokko-model.testkit.js";
import type { Move, Room, State as ModelState } from "./onigokko-model.testkit.js";

// からくり迷宮の鬼ごっこのデモ（fixtures/projects/v1/onigokko。tools/make-onigokko-demo.mjs が生成する）の約束ごと。
// 部屋の手順は、onigokko-model.testkit.ts の「規則のモデル」（chase / toward / away をエンジンと同じ規則で書き下したもの）で最短を探して、
// 実際のエンジンで 1 手ずつ再生して確かめる（プレイヤー・鬼・狐・岩の位置と、鍵のスイッチが、毎手そろうこと）。
const { project, maps, ctx } = loadFixtureProject("onigokko");
type State = ReturnType<typeof runReplay>["state"];

const ROOMS = ["map_r1", "map_r2", "map_r3", "map_r4"];
const tileset = Object.values(project.tilesets)[0]!;
const mapOf = (id: string): MapData => maps[id as keyof typeof maps]!;
const roomModel = (id: string): Room => roomOf(maps as Record<string, MapData>, tileset, id);
const START = { x: 7, y: 8 };
const NO_WAIT = MOVES.filter((m) => m !== "wait");

const busy = (s: State): boolean =>
  s.map.player.moving || Object.values(s.map.events).some((e) => e.moving) || s.map.transfer !== undefined || s.interpreters.some((i) => i.mode === "normal") || s.message.open || s.scene.kind !== "map";
const variable = (s: State, id: string): number => s.variables[id as keyof State["variables"]] ?? 0;
const switchOn = (s: State, id: string): boolean => s.switches[id as keyof State["switches"]] === true;

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

/** 新しいゲームを始めて、あらすじを読み終えた状態（玄関）。 */
function newGame(): State {
  seen = [];
  const s0 = runReplay({ project: "fixtures/projects/v1/onigokko", seed: "onigokko", inputs: [], expect: {} }).state;
  return settle(driveUntil(s0, ctx, busy, 60));
}

/** 部屋のはじまりの場所に立った状態（玄関から、本物の場所移動で入る）。 */
function enter(id: string): State {
  seen = [];
  const s = runReplay({ project: "fixtures/projects/v1/onigokko", seed: "onigokko", inputs: [], expect: {} }).state;
  const started = driveUntil(s, ctx, (x) => !busy(x), 200);
  const moved = { ...started, interpreters: [], message: { ...started.message, open: false }, map: { ...started.map, transfer: { to: id as never, x: START.x, y: START.y, dir: "up" as const, fade: "none" as const, requested: false } } };
  return driveUntil(drive(moved, ctx, idleFrames(3)).state, ctx, (x) => !busy(x), 200);
}

/**
 * プレイヤーの 1 手を打って、みんなの動きが止まるまで進める（狐をつかまえたときの文章は、決定で閉じる）。つかまったら、そこで止める。
 * 押したあと数フレームは待つ：足踏みの手は、プレイヤーが動かないので、鬼のルートが手を消化して歩き出すまで（1〜2 フレーム）は「動いていない」に見える。
 * その間に次の手を打つと、鬼は次の手のあとの位置を見て動く（人の操作ではまず起きない速さ。docs/03 のターン制の移動ルート）。
 */
function play(s: State, move: Move): State {
  const button = move === "wait" ? "ok" : move;
  const caught = variable(s, "var_caught");
  let next = driveUntil(drive(s, ctx, [press(button), ...idleFrames(3)]).state, ctx, (x) => !busy(x) || x.message.open, 400);
  for (let i = 0; i < 10 && next.message.open && variable(next, "var_caught") === caught; i++) {
    next = drive(next, ctx, idleFrames(2)).state;
    if (next.message.text !== "") seen.push(next.message.text);
    next = driveUntil(drive(next, ctx, [press("ok"), ...idleFrames(1)]).state, ctx, (x) => !busy(x) || x.message.open, 400);
  }
  return next;
}

/** エンジンの状態から、モデルの状態と同じ形の数字を取り出す（位置・向き・持っている鍵）。消えた狐は数えない。 */
function snapshot(s: State, room: Room) {
  const k = (e: { x: number; y: number }): number => e.y * room.w + e.x;
  const keys = room.switches.reduce((bits, id, i) => (switchOn(s, id) ? bits | (1 << i) : bits), 0);
  return {
    player: k(s.map.player),
    rocks: room.rocks.map((r) => k(s.map.events[r.id as never]!)),
    movers: room.movers.flatMap((m) => {
      const ev = s.map.events[m.id as never]!;
      return ev.pageIndex === null ? [] : [[k(ev), ev.direction]];
    }),
    keys,
  };
}
/** モデルの状態を、`snapshot` と同じ形にする。 */
function expected(room: Room, m: ModelState) {
  return { player: m.player, rocks: m.rocks, movers: m.movers.filter((_, i) => room.movers[i]!.role === "catch" || (m.keys & (1 << room.movers[i]!.key!)) === 0), keys: m.keys };
}

/** 柱（物のレイヤ）を取り除いた部屋のモデル。 */
function withoutPillars(id: string): Room {
  const map = mapOf(id);
  const bare: MapData = { ...map, layers: map.layers.map((l, i) => (i === 0 ? l : { ...l, tiles: l.tiles.map(() => 0) })) };
  return roomOf({ ...(maps as Record<string, MapData>), [id]: bare }, tileset, id);
}

describe("fixtures/projects/v1/onigokko（からくり迷宮の鬼ごっこ）", () => {
  it("部屋は 5 つ（玄関 + 4 つの部屋）。部屋はどれも 1 画面で、鬼と狐の移動ルートはすべてターン制（random は使わない）", () => {
    expect(Object.keys(maps).sort()).toEqual(["map_hall", ...ROOMS].sort());
    for (const id of Object.keys(maps)) expect([mapOf(id).width, mapOf(id).height]).toEqual([15, 11]);
    for (const id of ROOMS) {
      const room = roomModel(id);
      const resets = room.switches;
      for (const ev of Object.values(mapOf(id).events)) {
        const first = ev.pages[0]!;
        if (ev.id.startsWith("ev_oni_")) {
          expect(first).toMatchObject({ trigger: "eventTouch", priority: "same", moveRoute: { repeat: true, pace: "playerStep" } });
          // つかまると、部屋の鍵のスイッチを戻して、同じ部屋の入口へ
          expect(first.commands.at(-1)).toMatchObject({ code: "TransferPlayer", params: { mapId: id, ...START } });
          if (resets.length > 0) expect(first.commands.at(-2)).toMatchObject({ code: "ControlSwitches", params: { ids: resets, value: false } });
        }
        if (ev.id.startsWith("ev_fox_")) expect(first).toMatchObject({ trigger: "touch", priority: "same", moveRoute: { repeat: true, pace: "playerStep" } });
        for (const step of first.moveRoute?.steps ?? []) expect(step).not.toMatchObject({ kind: "move", dir: "random" });
      }
    }
    // 鬼の種類：追い鬼（chase）・つっこみ鬼（toward）・見回り鬼（4 方向）・からくり狐（away）が、どれも出てくる
    const dirs = new Set(ROOMS.flatMap((id) => roomModel(id).movers.flatMap((m) => m.acts.filter((a) => a !== undefined))));
    expect([...dirs].sort()).toEqual(expect.arrayContaining(["away", "chase", "left", "right", "toward"]));
  });

  describe.each(ROOMS)("%s", (id) => {
    const room = roomModel(id);
    const solution = solve(room);

    it("最短の手順でぬけられる", () => {
      expect(solution).toBeDefined();
      expect(replay(room, solution!.moves).ok).toBe(true);
    });

    it("手順を実際のエンジンで 1 手ずつ再生すると、プレイヤー・鬼・狐・岩の位置と鍵が毎手モデルと一致し、一度もつかまらずに出口へ着く", () => {
      let s = enter(id);
      expect(snapshot(s, room)).toEqual({ ...snapshot(s, room), player: initial(room).player, rocks: initial(room).rocks, keys: 0 });
      const model = replay(room, solution!.moves).states;
      const last = solution!.moves.length - 1;
      solution!.moves.forEach((move, i) => {
        s = play(s, move);
        expect(variable(s, "var_caught"), `${i + 1} 手目（${move}）でつかまった`).toBe(0);
        if (i === last) return;
        expect(snapshot(s, room), `${i + 1} 手目（${move}）`).toEqual(expected(room, model[i]!));
      });
      // 最後の手で出口に着いて、次の部屋へ（最後の部屋は、金の鈴を取ってタイトルへ）
      const next = ROOMS[ROOMS.indexOf(id) + 1];
      if (next === undefined) {
        s = settle(s);
        expect(said()).toContain("金の鈴");
        expect(s.scene.kind).toBe("title");
      } else expect(s.map.mapId).toBe(next);
    });
  });

  describe("でたらめな手順でも、エンジンとモデルが毎手そろう（追う・近づく・逃げるの向きの決め方を、最短の手順以外の場面でも確かめる）", () => {
    /** 決まった種の擬似乱数（LCG）。 */
    const lcg = (seed: number) => {
      let x = seed >>> 0;
      return (n: number): number => ((x = (Math.imul(x, 1664525) + 1013904223) >>> 0) % n);
    };
    it.each(ROOMS.flatMap((id) => [1, 2, 3].map((seed) => [id, seed] as const)))("%s（種 %d）", (id, seed) => {
      const room = roomModel(id);
      const rnd = lcg(seed * 7919 + id.length);
      let s = enter(id);
      let m = initial(room);
      for (let i = 0; i < 60; i++) {
        // つかまらない手から選ぶ（どの手でもつかまるときだけ、つかまる手を打つ）
        const safe = MOVES.filter((mv) => play_(room, m, mv)?.caught === false);
        const legal = safe.length > 0 ? safe : MOVES.filter((mv) => play_(room, m, mv) !== undefined);
        const move = legal[rnd(legal.length)]!;
        const o = play_(room, m, move)!;
        s = play(s, move);
        if (o.caught) {
          expect(variable(s, "var_caught"), `${i + 1} 手目（${move}）でつかまるはず`).toBe(1);
          return;
        }
        expect(variable(s, "var_caught"), `${i + 1} 手目（${move}）`).toBe(0);
        if (o.done) return;
        m = o.state;
        expect(snapshot(s, room), `${i + 1} 手目（${move}）`).toEqual(expected(room, m));
      }
    });
  });

  describe("仕掛けが必須（ソルバで確かめる）", () => {
    it("一の間：柱が無いと、つっこみ鬼から逃げきれない（柱のかげに引っかけて抜ける）", () => {
      expect(solve(roomModel("map_r1"))).toBeDefined();
      expect(solve(withoutPillars("map_r1"))).toBeUndefined();
    });

    it("二の間：足踏み（決定ボタン）を禁止すると解けない（見回り鬼の間合いは、歩くだけでは偶数手ずつしかずらせない）", () => {
      const room = roomModel("map_r2");
      expect(solve(room)!.moves).toContain("wait");
      expect(solve(room, { moves: NO_WAIT })).toBeUndefined();
    });

    it("三の間：岩が無いと解けない（追い鬼を岩で閉じこめないと、鍵の袋小路で追いつかれる）", () => {
      const room = roomModel("map_r3");
      expect(solve(withRoom(room, { rocks: [] }))).toBeUndefined();
      // 最初の 3 手で岩を押しこんで、追い鬼の囲いの出口をふさぐ
      const after = replay(room, solve(room)!.moves.slice(0, 3)).states.at(-1)!;
      expect(after.rocks).not.toEqual(initial(room).rocks);
    });

    it("四の間：岩が無くても、足踏みを禁止しても解けない", () => {
      const room = roomModel("map_r4");
      expect(solve(withRoom(room, { rocks: [] }))).toBeUndefined();
      expect(solve(room, { moves: NO_WAIT })).toBeUndefined();
    });

    it("扉は鍵を取るまで開かない：鍵（狐）を取らずには出口へ着けない", () => {
      for (const id of ROOMS) {
        const room = roomModel(id);
        const noKeys = withRoom(room, { keys: [], movers: room.movers.filter((m) => m.role === "catch") });
        expect(solve(noKeys), id).toBeUndefined();
      }
    });

    it("手順は 15〜40 手で、部屋が進むほど長い（同じでもよい）", () => {
      const lengths = ROOMS.map((id) => solve(roomModel(id))!.moves.length);
      for (const n of lengths) expect(n).toBeGreaterThanOrEqual(15);
      for (const n of lengths) expect(n).toBeLessThanOrEqual(40);
      expect([...lengths].sort((a, b) => a - b)).toEqual(lengths);
    });
  });

  describe("つかまる", () => {
    /** 手順を実際のエンジンで打って、つかまったところ（イベントが始まったところ）の状態。 */
    function caughtBy(id: string, moves: Move[]): State {
      let s = enter(id);
      for (const m of moves) s = play(s, m);
      return s;
    }

    it.each(ROOMS)("%s：鬼が歩いてきて触れると、つかまって部屋のはじまりへ戻される（鬼も岩も最初の位置から、手数も数え直し）", (id) => {
      const room = roomModel(id);
      const moves = solveCatch(room, "touch");
      expect(moves, "鬼に触れられる手順がある").toBeDefined();
      let s = caughtBy(id, moves!);
      expect(s.message.open || s.interpreters.some((i) => i.mode === "normal")).toBe(true);
      s = settle(s);
      expect(said()).toContain("つかまった");
      expect(variable(s, "var_caught")).toBe(1);
      expect(s.map.mapId).toBe(id);
      expect(s.map.player).toMatchObject(START);
      expect(snapshot(s, room)).toEqual(expected(room, initial(room)));
      expect(s.map.turns ?? 0).toBe(0);
    });

    it("自分から鬼にぶつかっても、つかまる", () => {
      const room = ROOMS.map(roomModel).find((r) => solveCatch(r, "bump") !== undefined);
      expect(room, "ぶつかってつかまる部屋がある").toBeDefined();
      let s = caughtBy(room!.id, solveCatch(room!, "bump")!);
      s = settle(s);
      expect(said()).toContain("つかまった");
      expect(variable(s, "var_caught")).toBe(1);
      expect(s.map.player).toMatchObject(START);
    });

    it("鍵を取ったあとでつかまると、鍵は床に戻り、扉は閉じる（一の間）", () => {
      const room = roomModel("map_r1");
      const moves = solve(room)!.moves;
      // 鍵を取るまでの手順
      const upto = replay(room, moves).states.findIndex((st) => st.keys !== 0) + 1;
      const toKey = moves.slice(0, upto);
      const after = replay(room, toKey).states.at(-1)!;
      expect(after.keys).not.toBe(0);
      const caught = solveCatch(room, "touch", { from: after });
      expect(caught).toBeDefined();
      let s = enter("map_r1");
      for (const m of toKey) s = play(s, m);
      expect(switchOn(s, room.switches[0]!)).toBe(true);
      expect(s.map.events["ev_door_1" as never]!.pageIndex).toBeNull();
      for (const m of caught!) s = play(s, m);
      s = settle(s);
      expect(said()).toContain("つかまった");
      expect(switchOn(s, room.switches[0]!)).toBe(false);
      expect(s.map.events["ev_door_1" as never]!.pageIndex).toBe(0);
      expect(s.map.events["ev_key_1" as never]!.pageIndex).toBe(0);
    });

    it("三の間：岩で追い鬼を閉じこめたら、もう触れられない。階段でやりなおすと、岩も追い鬼ももとの場所に戻る", () => {
      const room = roomModel("map_r3");
      const sealed = solve(room)!.moves.slice(0, 3);
      const after = replay(room, sealed).states.at(-1)!;
      expect(solveCatch(room, "touch", { from: after })).toBeUndefined();
      let s = enter("map_r3");
      for (const m of sealed) s = play(s, m);
      expect(snapshot(s, room).rocks).toEqual(after.rocks);
      // 岩を押した (5, 7) から、はじまりの場所へ戻って、階段にぶつかる
      for (const m of ["down", "right", "right"] as const) s = play(s, m);
      expect(s.map.player).toMatchObject(START);
      s = untilChoices(drive(s, ctx, [press("down"), ...idleFrames(1)]).state);
      s = settle(s, 0);
      expect(s.map.player).toMatchObject(START);
      expect(snapshot(s, room)).toEqual(expected(room, initial(room)));
    });
  });

  describe("からくり狐", () => {
    it("四の間：狐は逃げる。隅に追いつめてぶつかると、銀の鍵をくれて消え、銀の扉が開く（手には数えない）", () => {
      const room = roomModel("map_r4");
      const moves = solve(room)!.moves;
      const states = replay(room, moves).states;
      const grab = states.findIndex((st) => st.keys !== 0);
      let s = enter("map_r4");
      for (const m of moves.slice(0, grab)) s = play(s, m);
      const turns = s.map.turns;
      expect(s.map.events["ev_fox_f" as never]!.pageIndex).toBe(0);
      seen = [];
      s = play(s, moves[grab]!);
      expect(said()).toContain("からくり狐を つかまえた");
      expect(s.map.turns).toBe(turns);
      expect(s.map.events["ev_fox_f" as never]!.pageIndex).toBeNull();
      expect(s.map.events["ev_door_1" as never]!.pageIndex).toBeNull();
    });
  });

  describe("入口の階段", () => {
    const bump = (id: string): State => untilChoices(drive(enter(id), ctx, [press("down"), ...idleFrames(1)]).state);

    it("一の間：階段にぶつかると、玄関へ もどる／やりなおす／やめる を選べる", () => {
      const s = bump("map_r1");
      expect(s.message.choices).toEqual(["玄関へ もどる", "この 部屋を はじめから やりなおす", "やめる"]);
      const home = settle(s, 0);
      expect(home.map.mapId).toBe("map_hall");
      expect([home.map.player.x, home.map.player.y]).toEqual([7, 2]);
    });

    it("やりなおすを選ぶと、鍵を取っていても、はじまりの場所へ戻る（鬼・鍵・扉も最初から）", () => {
      const room = roomModel("map_r2");
      const moves = solve(room)!.moves;
      const upto = replay(room, moves).states.findIndex((st) => st.keys !== 0) + 1;
      let s = enter("map_r2");
      for (const m of moves.slice(0, upto)) s = play(s, m);
      expect(switchOn(s, room.switches[0]!)).toBe(true);
      // 鍵（左下の隅）から、階段の横まで戻って、階段にぶつかる
      const back = replay(room, [...moves.slice(0, upto), "right", "right", "right", "right", "right", "right"]);
      expect(back.ok, "鍵から階段の前まで、つかまらずに戻れる").toBe(true);
      for (const m of ["right", "right", "right", "right", "right", "right"] as const) s = play(s, m);
      s = untilChoices(drive(s, ctx, [press("down"), ...idleFrames(1)]).state);
      expect(s.message.choices).toEqual(["この 部屋を はじめから やりなおす", "やめる"]);
      s = settle(s, 0);
      expect(s.map.mapId).toBe("map_r2");
      expect(s.map.player).toMatchObject(START);
      expect(snapshot(s, room)).toEqual(expected(room, initial(room)));
      expect(switchOn(s, room.switches[0]!)).toBe(false);
    });

    it("やめると、そのまま", () => {
      const s = bump("map_r3");
      const cancelled = settle(s, 1);
      expect(cancelled.map.mapId).toBe("map_r3");
      expect(cancelled.map.player).toMatchObject(START);
    });
  });

  describe("玄関", () => {
    it("はじめに あらすじ、からくり師に話しかけると 遊び方を教えてくれる。奥の戸から一の間へ", () => {
      let s = newGame();
      expect(said()).toContain("金の鈴");
      expect(s.map.mapId).toBe("map_hall");
      expect(s.map.player).toMatchObject(START);
      // からくり師（7, 4）に話しかける（下から 3 歩上がって、上を向いて決定）
      seen = [];
      for (let i = 0; i < 3; i++) s = driveUntil(drive(s, ctx, [press("up")]).state, ctx, (x) => !x.map.player.moving, 60);
      s = drive(s, ctx, [press("ok"), ...idleFrames(1)]).state;
      s = settle(s, 1); // 「鬼の 種類」
      expect(said()).toContain("追い鬼");
      expect(said()).toContain("からくり狐");
      expect(said()).toContain("つかまった 回数は \\V[var_caught]回");
      // 戸へ（からくり師をよけて、左を回る）
      for (const m of ["left", "up", "up", "up", "right", "up"] as const) s = driveUntil(drive(s, ctx, [press(m)]).state, ctx, (x) => !x.map.player.moving, 60);
      s = driveUntil(s, ctx, (x) => !busy(x), 200);
      expect(s.map.mapId).toBe("map_r1");
      expect(s.map.player).toMatchObject(START);
    });
  });

  it("はじめから終わりまで：4 つの部屋の手順を順に打つと、一度もつかまらずに金の鈴を取って、タイトルへ戻る（同じ入力なら同じ結果）", () => {
    const run = (): { state: State; said: string } => {
      let s = newGame();
      // 玄関：入り口（7, 8）から戸（7, 1）まで。からくり師（7, 4）をよけて、左の列（6）を通る
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
    expect(a.said).toContain("金の鈴");
    expect(a.said).toContain("つかまった 回数：\\V[var_caught]回");
    expect(variable(a.state, "var_caught")).toBe(0);
    expect(run().state).toEqual(a.state);
  }, 60_000);
});
