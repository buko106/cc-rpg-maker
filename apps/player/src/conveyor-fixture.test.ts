import type { MapData } from "@rpg/schema";
import { drive, driveUntil, idleFrames, loadFixtureProject, press, runReplay } from "@rpg/test-utils";
import { describe, expect, it } from "vitest";
import { analyze, initial, play as modelPlay, reach, replay, roomOf, solve, variant } from "./conveyor-model.testkit.js";
import type { Dir, Move, Room, State as ModelState } from "./conveyor-model.testkit.js";

// 工場のベルトコンベアのデモ（fixtures/projects/v1/conveyor。tools/make-conveyor-demo.mjs が生成する）の約束ごと。
// 部屋の手順は、conveyor-model.testkit.ts の「規則のモデル」で最短を探して、実際のエンジンで 1 手ずつ再生して確かめる
// （モデルの位置とエンジンの位置・箱の位置・レバーと出荷口のスイッチが、毎手そろうこと）。
const { project, maps, ctx } = loadFixtureProject("conveyor");
type State = ReturnType<typeof runReplay>["state"];

const ROOMS = ["map_r1", "map_r2", "map_r3", "map_r4"];
const tileset = Object.values(project.tilesets)[0]!;
const mapOf = (id: string): MapData => maps[id as keyof typeof maps]!;
const roomModel = (id: string): Room => roomOf(maps as Record<string, MapData>, tileset, id);
const START = { x: 7, y: 8 };

const busy = (s: State): boolean =>
  s.map.player.moving || Object.values(s.map.events).some((e) => e.moving) || s.map.transfer !== undefined || s.interpreters.some((i) => i.mode === "normal") || s.message.open || s.scene.kind !== "map";
const flag = (s: State, id: string): boolean => s.switches[id as keyof State["switches"]] === true;

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

const GAME = { project: "fixtures/projects/v1/conveyor", seed: "conveyor", inputs: [], expect: {} };

/** ゲームのはじまり（ロビーで、あらすじが終わったところ）。 */
function lobby(): State {
  seen = [];
  const s0 = runReplay(GAME).state;
  return settle(driveUntil(s0, ctx, busy, 60));
}

/** 部屋のはじまりの場所に立った状態（ロビーから、本物の場所移動で入る）。 */
function enter(id: string): State {
  seen = [];
  const s = runReplay(GAME).state;
  const started = driveUntil(s, ctx, (x) => !busy(x), 200);
  const moved = { ...started, interpreters: [], message: { ...started.message, open: false }, map: { ...started.map, transfer: { to: id as never, x: START.x, y: START.y, dir: "up" as const, fade: "none" as const, requested: false } } };
  return driveUntil(drive(moved, ctx, idleFrames(3)).state, ctx, (x) => !busy(x), 200);
}

/** プレイヤーの 1 手を打って、みんなの動きが止まるまで進める。レバーは、向いてから決定ボタン。 */
function play(s: State, room: Room, move: Move): State {
  if (move.startsWith("pull")) {
    const lv = room.levers[Number(move.slice(4))]!;
    const dx = lv.x - s.map.player.x;
    const dy = lv.y - s.map.player.y;
    const dir: Dir = dx === 1 ? "right" : dx === -1 ? "left" : dy === 1 ? "down" : "up";
    const faced = drive(s, ctx, [press(dir), ...idleFrames(1)]).state;
    return settle(drive(faced, ctx, [press("ok"), ...idleFrames(2)]).state);
  }
  const moved = driveUntil(drive(s, ctx, [press(move as Dir)]).state, ctx, (x) => !busy(x), 800);
  // 出荷口とシャッターのしかけ（並列イベント）が、結果を出すまで
  return drive(moved, ctx, idleFrames(4)).state;
}

/** エンジンの状態から、モデルの状態と同じ形の数字を取り出す。 */
function snapshot(s: State, room: Room): ModelState {
  const k = (e: { x: number; y: number }): number => e.y * room.w + e.x;
  const keys = Object.keys(mapOf(room.id).events)
    .filter((id) => id.startsWith("ev_lever"))
    .map((id) => id.slice("ev_lever_".length));
  let mask = 0;
  keys.forEach((key, i) => {
    if (flag(s, `sw_lever_${room.id}_${key}`)) mask |= 1 << i;
  });
  let latch = 0;
  room.docks.forEach((_, i) => {
    if (flag(s, `sw_dock_${room.id}_${i + 1}`)) latch |= 1 << i;
  });
  return {
    player: k(s.map.player),
    boxes: room.boxes.map((b, i) => (flag(s, `sw_gone_${room.id}_${i + 1}`) ? -1 : k(s.map.events[b.id as never]!))),
    mask,
    latch,
  };
}

describe("fixtures/projects/v1/conveyor（工場のベルトコンベア）", () => {
  it("部屋は 5 つ（ロビー + 4 つの部屋）。部屋はどれもちょうど 1 画面で、ベルトの向きは tileset.conveyor の表にある", () => {
    expect(Object.keys(maps).sort()).toEqual(["map_hall", ...ROOMS].sort());
    for (const id of Object.keys(maps)) expect([mapOf(id).width, mapOf(id).height]).toEqual([15, 11]);
    expect(tileset.conveyor).toEqual({ "5": "right", "6": "left", "7": "down", "8": "up" });
    expect(project.system.dash).toBeUndefined();
  });

  it("レバーの 2 つのページは、引く前のタイルと引いたあとのタイルを入れ替え合う（モデルが読むのは 0 番目のページ）", () => {
    for (const id of ROOMS) {
      for (const ev of Object.values(mapOf(id).events).filter((e) => e.id.startsWith("ev_lever"))) {
        const changes = (p: number) => ev.pages[p]!.commands.filter((c) => c.code === "ChangeMapTile").map((c) => c.params as { x: number; y: number; width: number; height: number; tile: number });
        const cells = (p: number) => changes(p).flatMap((c) => Array.from({ length: c.width * c.height }, (_, i) => ({ k: (c.y + Math.floor(i / c.width)) * 15 + c.x + (i % c.width), tile: c.tile })));
        const on = cells(0);
        const off = cells(1);
        expect(on.map((c) => c.k).sort()).toEqual(off.map((c) => c.k).sort());
        const original = mapOf(id).layers[0]!.tiles;
        for (const c of off) expect(original[c.k]).toBe(c.tile);
        for (const c of on) expect(original[c.k]).not.toBe(c.tile);
      }
    }
  });

  describe.each(ROOMS)("%s", (id) => {
    const room = roomModel(id);
    const solution = solve(room);

    it("最短の手順で出口へ着ける", () => {
      expect(solution).toBeDefined();
      expect(replay(room, solution!.moves).ok).toBe(true);
    });

    it("手順を実際のエンジンで 1 手ずつ再生すると、プレイヤー・箱・レバー・出荷口が毎手モデルと一致し、最後に出口へ着く", () => {
      let s = enter(id);
      const first = initial(room);
      expect(snapshot(s, room)).toEqual(first);
      const model = replay(room, solution!.moves).states;
      const last = solution!.moves.length - 1;
      solution!.moves.forEach((move, i) => {
        s = play(s, room, move);
        if (i === last) return;
        expect(snapshot(s, room), `${i + 1} 手目（${move}）`).toEqual(model[i]);
      });
      // 最後の手で出口に着いて、次の部屋へ（最後の部屋は、金のネジを出荷台に置いてタイトルへ）
      const next = ROOMS[ROOMS.indexOf(id) + 1];
      if (next === undefined) {
        s = settle(s);
        expect(said()).toContain("金のネジ");
        expect(s.scene.kind).toBe("title");
      } else expect(s.map.mapId).toBe(next);
    }, 120_000);
  });

  describe("しかけが必須であること（その版では解けない）", () => {
    it("第一工区：奈落の橋はベルトだけなので、ベルトに乗れないと解けない（ベルトが運ばなければ 9 手で行けるが、運ぶと 15 手）", () => {
      const room = roomModel("map_r1");
      expect(solve(variant(room, { walk: false }))).toBeUndefined();
      expect(solve(variant(room, { carryPlayer: false }))!.moves.length).toBeLessThan(solve(room)!.moves.length);
    });

    it.each(["map_r2", "map_r3", "map_r4"])("%s：ベルトが箱を運ばないと解けない", (id) => {
      expect(solve(variant(roomModel(id), { carryBoxes: false }))).toBeUndefined();
    });

    it.each(["map_r3", "map_r4"])("%s：レバーを引けないと解けない", (id) => {
      expect(solve(variant(roomModel(id), { pull: false }))).toBeUndefined();
    });

    it("手数は、だんだん増える：15〜40 手", () => {
      const lengths = ROOMS.map((id) => solve(roomModel(id))!.moves.length);
      for (const n of lengths) {
        expect(n).toBeGreaterThanOrEqual(15);
        expect(n).toBeLessThanOrEqual(40);
      }
      expect(lengths[0]).toBeLessThan(lengths[1]!);
      expect(lengths[1]).toBeLessThanOrEqual(lengths[2]!);
      expect(lengths[2]).toBeLessThanOrEqual(lengths[3]!);
    });
  });

  describe("詰みと、入口の階段でのやり直し", () => {
    const analyses = new Map(ROOMS.map((id) => [id, analyze(roomModel(id))] as const));

    it("第一工区は詰まない。箱のある部屋には、箱を出荷口に届けられない位置（詰み）があるが、どの状態からも入口へ戻れる", () => {
      const r1 = analyses.get("map_r1")!;
      expect(r1.stuck).toBe(0);
      for (const id of ROOMS) {
        const a = analyses.get(id)!;
        expect(a, `${id} の状態を調べきれた`).toBeDefined();
        expect(a.cutOff, `${id}：入口へ戻れない状態`).toBe(0);
        if (id !== "map_r1") {
          expect(a.stuck, `${id}：詰みがある`).toBeGreaterThan(0);
          expect(a.trap).toBeDefined();
        }
      }
    }, 120_000);

    it.each(["map_r2", "map_r3", "map_r4"])("%s：詰みへ入ったあと、入口の階段で「やりなおす」と、箱もレバーもスイッチも最初に戻り、もう一度解ける", (id) => {
      const room = roomModel(id);
      const trap = analyses.get(id)!.trap!;
      let s = enter(id);
      let model = initial(room);
      for (const m of trap) {
        s = play(s, room, m);
        model = modelPlay(room, model, m)!.state;
      }
      expect(snapshot(s, room)).toEqual(model);
      // 詰んでいる（出口へ行く手順が無い）
      expect(solve(room, { from: model })).toBeUndefined();
      // 入口へ戻る
      const home = START.y * room.w + START.x;
      for (const m of reach(room, (x) => x.player === home, { from: model })!) {
        s = play(s, room, m);
        model = modelPlay(room, model, m)!.state;
      }
      expect(s.map.player).toMatchObject(START);
      seen = [];
      s = untilChoices(drive(s, ctx, [press("down"), ...idleFrames(1)]).state);
      expect(s.message.choices).toEqual(["この 工区を はじめから やりなおす", "ヒントを 読む", "やめる"]);
      s = settle(s, 0);
      expect(s.map.mapId).toBe(id);
      expect(s.map.player).toMatchObject(START);
      expect(snapshot(s, room)).toEqual(initial(room));
      // タイルも、レバーを引く前に戻っている（ChangeMapTile は部屋を出入りしても残るので、やり直しで書き戻している）
      const tiles = (s.mapTiles?.[id as never] ?? {}) as Record<string, number>;
      for (const [k, tile] of Object.entries(tiles)) {
        const [layer, xy] = k.split(":");
        const [x, y] = xy!.split(",").map(Number);
        expect(mapOf(id).layers[Number(layer)]!.tiles[y! * 15 + x!], `タイル ${k}`).toBe(tile);
      }
      // もう一度、最短の手順で解ける
      const again = solve(room)!.moves;
      for (const m of again) s = play(s, room, m);
      s = settle(s);
      if (id === "map_r4") expect(s.scene.kind).toBe("title");
      else expect(s.map.mapId).not.toBe(id);
    }, 120_000);

    it("ヒントを選ぶと、その工区のヒントが読める。やめるとそのまま", () => {
      seen = [];
      let s = untilChoices(drive(enter("map_r3"), ctx, [press("down"), ...idleFrames(1)]).state);
      s = settle(s, 1);
      expect(said()).toContain("出荷口は 左右に");
      s = untilChoices(drive(s, ctx, [press("down"), ...idleFrames(1)]).state);
      s = settle(s, 2);
      expect(s.map.mapId).toBe("map_r3");
    });

    it("第一工区の階段からは、ロビーへ もどることもできる", () => {
      const s = untilChoices(drive(enter("map_r1"), ctx, [press("down"), ...idleFrames(1)]).state);
      expect(s.message.choices).toEqual(["ロビーへ もどる", "この 工区を はじめから やりなおす", "ヒントを 読む", "やめる"]);
      const home = settle(s, 0);
      expect(home.map.mapId).toBe("map_hall");
      expect([home.map.player.x, home.map.player.y]).toEqual([7, 2]);
    });
  });

  describe("ロビー", () => {
    it("はじめにあらすじ。整備士に話しかけると遊び方を教えてくれる。足元のベルトで運ばれ、奥の扉から第一工区へ", () => {
      let s = lobby();
      expect(said()).toContain("金のネジ");
      expect(s.map.mapId).toBe("map_hall");
      expect(s.map.player).toMatchObject(START);
      // 整備士（7, 4）に話しかける（上へ 3 歩あがって、上を向いて決定）
      seen = [];
      for (let i = 0; i < 3; i++) s = driveUntil(drive(s, ctx, [press("up")]).state, ctx, (x) => !x.map.player.moving, 60);
      s = drive(s, ctx, [press("ok"), ...idleFrames(1)]).state;
      s = settle(s, 1); // 「木箱」
      expect(said()).toContain("木箱");
      // 練習用のベルト（3, 6）〜（5, 6）：左から乗ると、右の端まで運ばれて (6, 6) で止まる
      s = { ...s, map: { ...s.map, player: { ...s.map.player, x: 2, y: 6, realX: 2, realY: 6, direction: "right" } } };
      s = driveUntil(drive(s, ctx, [press("right")]).state, ctx, (x) => !busy(x), 200);
      expect([s.map.player.x, s.map.player.y]).toEqual([6, 6]);
      // 扉へ（整備士をよけて、左を回る）
      s = { ...s, map: { ...s.map, player: { ...s.map.player, x: 7, y: 8, realX: 7, realY: 8 } } };
      for (const m of ["left", "up", "up", "up", "up", "up", "up", "right", "up"] as const) s = driveUntil(drive(s, ctx, [press(m)]).state, ctx, (x) => !x.map.player.moving, 60);
      s = driveUntil(s, ctx, (x) => !busy(x), 200);
      expect(s.map.mapId).toBe("map_r1");
      expect(s.map.player).toMatchObject(START);
    });
  });

  it("はじめから終わりまで：4 つの部屋の手順を順に打つと、金のネジを出荷してタイトルへ戻る（同じ入力なら同じ結果）", () => {
    const run = (): { state: State; said: string } => {
      let s = lobby();
      const path: Move[] = ["left", "up", "up", "up", "up", "up", "up", "right", "up"];
      const hall = { w: 15, levers: [] } as unknown as Room;
      for (const m of path) s = play(s, hall, m);
      s = driveUntil(s, ctx, (x) => !busy(x), 200);
      for (const id of ROOMS) {
        expect(s.map.mapId).toBe(id);
        const room = roomModel(id);
        for (const m of solve(room)!.moves) s = play(s, room, m);
        s = driveUntil(s, ctx, (x) => !busy(x) || x.message.open || x.scene.kind !== "map", 400);
      }
      s = settle(s);
      return { state: s, said: said() };
    };
    const a = run();
    expect(a.state.scene.kind).toBe("title");
    expect(a.said).toContain("金のネジ");
    expect(run().state).toEqual(a.state);
  }, 240_000);
});
