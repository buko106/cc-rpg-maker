import type { EventPage, MapEvent, SpeedRule } from "@rpg/schema";
import { loadFixtureProject } from "@rpg/test-utils";
import { describe, expect, it } from "vitest";
import { emptyInput, inputFrame } from "../input.js";
import type { Button } from "../input.js";
import { tileKey } from "../map/index.js";
import { fromSnapshot, toSnapshot } from "../snapshot.js";
import type { GameState } from "../state.js";
import { initialState, step } from "./index.js";

type Loaded = ReturnType<typeof loadFixtureProject>;
type Dir = "up" | "down" | "left" | "right";

const SAND = 4;
const ICE = 5;

interface Options {
  walkSpeed?: number;
  dash?: { bonus?: number } | true;
  speedRules?: SpeedRule[];
  mapWalkSpeed?: number;
  mapNoDash?: boolean;
  /** 砂地（`SAND`）のタイルの効果。置く場所は `sand`。 */
  terrain?: { speed?: number; noDash?: boolean };
  sand?: [number, number][];
  /** 氷にする (x, y)。 */
  ice?: [number, number][];
  events?: MapEvent[];
}

/** minimal（内側 x 1..8・y 1..6、プレイヤーは (2, 2)、下向き、速さ 4。イベントは置かない）に、速さの設定を足す。 */
function setup(o: Options = {}): Loaded {
  const loaded = loadFixtureProject("minimal");
  const system = loaded.project.system as Record<string, unknown>;
  if (o.walkSpeed !== undefined) system["walkSpeed"] = o.walkSpeed;
  if (o.dash !== undefined) system["dash"] = o.dash === true ? {} : o.dash;
  if (o.speedRules !== undefined) system["speedRules"] = o.speedRules;
  const map = loaded.maps["map_start" as never]! as unknown as Record<string, unknown> & { layers: { name: string; tiles: number[] }[]; width: number };
  if (o.mapWalkSpeed !== undefined) map["walkSpeed"] = o.mapWalkSpeed;
  if (o.mapNoDash !== undefined) map["noDash"] = o.mapNoDash;
  // minimal の NPC は (5, 2) で道をふさぐので、いったん取り除く
  map["events"] = Object.fromEntries((o.events ?? []).map((e) => [e.id, e]));
  const ground = map.layers.find((l) => l.name === "ground")!.tiles;
  const tileset = loaded.project.tilesets["ts_basic" as never]! as unknown as Record<string, unknown>;
  for (const [x, y] of o.sand ?? []) ground[y * map.width + x] = SAND;
  if (o.terrain !== undefined) tileset["terrain"] = { [String(SAND)]: o.terrain };
  for (const [x, y] of o.ice ?? []) ground[y * map.width + x] = ICE;
  if (o.ice !== undefined) tileset["ice"] = [ICE];
  return loaded;
}

const start = (l: Loaded): GameState => step(initialState(l.ctx, "s"), emptyInput(), l.ctx).state;
const at = (s: GameState): [number, number] => [s.map.player.x, s.map.player.y];

/** 押し始めのフレーム（`dash` なら Shift も押している）。 */
const push = (dir: Dir, dash: boolean): ReturnType<typeof inputFrame> => inputFrame(dash ? [dir, "shift"] : [dir], [dir]);

/** 1 歩（氷なら止まるまで）：押してから動きが止まるまでのフレーム数と、そのときの状態。 */
function walk(l: Loaded, s: GameState, dir: Dir, dash = false): { frames: number; state: GameState } {
  let cur = step(s, push(dir, dash), l.ctx).state;
  let frames = 1;
  while (cur.map.player.moving && frames < 1000) {
    cur = step(cur, emptyInput(), l.ctx).state;
    frames++;
  }
  return { frames, state: cur };
}
/** `n` 歩ぶん押しっぱなしにして歩く（毎フレーム方向キーを押している）。 */
function walkHeld(l: Loaded, s: GameState, dir: Dir, steps: number, dash: boolean): { frames: number; state: GameState } {
  const buttons: Button[] = dash ? [dir, "shift"] : [dir];
  let cur = step(s, inputFrame(buttons, [dir]), l.ctx).state;
  let frames = 1;
  const x0 = s.map.player.x;
  const y0 = s.map.player.y;
  while (Math.abs(cur.map.player.x - x0) + Math.abs(cur.map.player.y - y0) < steps || cur.map.player.moving) {
    cur = step(cur, inputFrame(buttons), l.ctx).state;
    if (++frames > 2000) throw new Error("歩き終わらない");
  }
  return { frames, state: cur };
}

const hungry = (value: boolean): SpeedRule => ({ when: [{ kind: "switch", id: "hungry" as never, value }], speed: -1 });
const withSwitch = (s: GameState, id: string, value: boolean): GameState => ({ ...s, switches: { ...s.switches, [id]: value } });

describe("歩く速さ：設定が無いとき", () => {
  it("従来どおり 16 フレーム/タイル。状態に何も足さない。Shift を押しても変わらない", () => {
    const l = setup();
    const s = start(l);
    const plain = walk(l, s, "right");
    expect(plain.frames).toBe(16);
    expect(plain.state.map.moveSpeed).toBeUndefined();
    expect(plain.state.map.player.speed).toBe(4);
    expect(walk(l, s, "right", true).frames).toBe(16);
  });
});

describe("歩く速さ：基準（システム・マップ）", () => {
  it("system.walkSpeed：最初から、その速さで歩く", () => {
    const l = setup({ walkSpeed: 3 });
    const s = start(l);
    expect(s.map.player.speed).toBe(3);
    expect(walk(l, s, "right").frames).toBe(32);
    const fast = setup({ walkSpeed: 5 });
    expect(walk(fast, start(fast), "right").frames).toBe(8);
  });

  it("MapData.walkSpeed は system.walkSpeed より優先される", () => {
    const l = setup({ walkSpeed: 5, mapWalkSpeed: 2 });
    const s = start(l);
    expect(s.map.player.speed).toBe(2);
    expect(walk(l, s, "right").frames).toBe(64);
  });

  it("マップに入るたびに、そのマップの既定の速さになる（どちらも無ければ、いまの速さのまま）", () => {
    const transfer = (s: GameState): GameState => ({ ...s, map: { ...s.map, transfer: { to: "map_start" as never, x: 3, y: 3, dir: "down", fade: "none", requested: false } } });
    const l = setup({ mapWalkSpeed: 2 });
    const s = { ...start(l), map: { ...start(l).map, player: { ...start(l).map.player, speed: 6 as const } } };
    expect(step(transfer(s), emptyInput(), l.ctx).state.map.player.speed).toBe(2);

    const none = setup();
    const kept = { ...start(none), map: { ...start(none).map, player: { ...start(none).map.player, speed: 5 as const } } };
    expect(step(transfer(kept), emptyInput(), none.ctx).state.map.player.speed).toBe(5);
  });
});

describe("歩く速さ：走る", () => {
  it("system.dash があれば、Shift を押しながら歩くと 1 段階速くなる（基準の speed は変わらない）", () => {
    const l = setup({ dash: true });
    const s = start(l);
    const run = walk(l, s, "right", true);
    expect(run.frames).toBe(8);
    expect(run.state.map.player.speed).toBe(4);
    expect(walk(l, s, "right", false).frames).toBe(16);
  });

  it("歩いている間だけ moveSpeed が付き、歩き終えると消える", () => {
    const l = setup({ dash: true });
    const s = step(start(l), push("right", true), l.ctx).state;
    expect(s.map.player.moving).toBe(true);
    expect(s.map.moveSpeed).toBe(5);
    expect(walk(l, start(l), "right", true).state.map.moveSpeed).toBeUndefined();
  });

  it("system.dash.bonus：上乗せする段階を変えられる。速さは 6 が上限", () => {
    const l = setup({ dash: { bonus: 2 } });
    expect(walk(l, start(l), "right", true).frames).toBe(4);
    const top = setup({ dash: true, walkSpeed: 6 });
    const run = walk(top, start(top), "right", true);
    expect(run.frames).toBe(4);
    expect(run.state.map.moveSpeed).toBeUndefined(); // 基準と同じ（6）なので足さない
  });

  it("方向キーを押さずに Shift だけでは動かない", () => {
    const l = setup({ dash: true });
    const s = step(start(l), inputFrame(["shift"], ["shift"]), l.ctx).state;
    expect(at(s)).toEqual([2, 2]);
    expect(s.map.player.moving).toBe(false);
  });

  it("押しっぱなしの間は、毎歩 Shift を見る（離せば次の 1 歩から歩きに戻る）", () => {
    const l = setup({ dash: true });
    const s = start(l);
    expect(walkHeld(l, s, "right", 4, true).frames).toBe(32);
    expect(walkHeld(l, s, "right", 4, false).frames).toBe(64);
    // 2 歩走ってから離す：8 + 8 + 16 + 16
    let cur = step(s, inputFrame(["right", "shift"], ["right", "shift"]), l.ctx).state;
    let frames = 1;
    while (at(cur)[0] < 6 || cur.map.player.moving) {
      const dashing = at(cur)[0] < 4;
      cur = step(cur, inputFrame(dashing ? ["right", "shift"] : ["right"]), l.ctx).state;
      frames++;
    }
    expect(frames).toBe(8 + 8 + 16 + 16);
  });

  it("system.dash が無ければ、Shift を押しても走れない", () => {
    const l = setup({ walkSpeed: 4 });
    expect(walk(l, start(l), "right", true).frames).toBe(16);
  });

  it("マップの noDash：そのマップでは走れない", () => {
    const l = setup({ dash: true, mapNoDash: true });
    expect(walk(l, start(l), "right", true).frames).toBe(16);
  });

  it("スイッチや変数で走れなくできる（走れない状態では、走る操作は無視する）", () => {
    const rules: SpeedRule[] = [{ when: [{ kind: "switch", id: "tired" as never, value: true }], noDash: true }];
    const l = setup({ dash: true, speedRules: rules });
    const s = start(l);
    expect(walk(l, withSwitch(s, "tired", false), "right", true).frames).toBe(8);
    expect(walk(l, withSwitch(s, "tired", true), "right", true).frames).toBe(16);
    expect(walk(l, withSwitch(s, "tired", true), "right", false).frames).toBe(16); // 歩く速さは変わらない
  });

  it("氷の上では、走って入った速さのまま止まるまで滑る", () => {
    const l = setup({ dash: true, ice: [[3, 2], [4, 2], [5, 2]] });
    // (3,2)〜(5,2) が氷：最初の 1 歩 + 氷を出るまでの滑り = (3,2)(4,2)(5,2)(6,2) の 4 タイル
    const run = walk(l, start(l), "right", true);
    expect(at(run.state)).toEqual([6, 2]);
    expect(run.frames).toBe(4 * 8);
    expect(run.state.map.moveSpeed).toBeUndefined();
    expect(walk(l, start(l), "right", false).frames).toBe(4 * 16);
  });
});

describe("歩く速さ：足元のタイル（Tileset.terrain）", () => {
  it("足元が砂の間は遅く歩く。歩き出すときに立っているタイルで決まる", () => {
    const l = setup({ terrain: { speed: -1 }, sand: [[3, 2], [4, 2]] });
    const s = start(l); // (2,2) は砂ではない
    const first = walk(l, s, "right"); // 砂へ入る 1 歩は、足元が砂でないので歩きの速さ
    expect(first.frames).toBe(16);
    const second = walk(l, first.state, "right"); // 砂から砂へ
    expect(at(second.state)).toEqual([4, 2]);
    expect(second.frames).toBe(32);
    const third = walk(l, second.state, "right"); // 砂から砂でない所へ出る 1 歩も、足元は砂
    expect(third.frames).toBe(32);
    expect(walk(l, third.state, "right").frames).toBe(16); // もう砂ではない
  });

  it("砂の上では走れない（noDash）が、歩く速さは変わらない", () => {
    const l = setup({ dash: true, terrain: { noDash: true }, sand: [[2, 2]] });
    const s = start(l);
    expect(walk(l, s, "right", true).frames).toBe(16);
    expect(walk(l, walk(l, s, "right").state, "right", true).frames).toBe(8);
  });

  it("砂の上で走ると、遅くなった分と走る分が打ち消し合う", () => {
    const l = setup({ dash: true, terrain: { speed: -1 }, sand: [[2, 2]] });
    expect(walk(l, start(l), "right", true).frames).toBe(16);
    expect(walk(l, start(l), "right", false).frames).toBe(32);
  });

  it("どのレイヤにあっても効き、同じタイルが重なっても 1 回だけ数える", () => {
    const l = setup({ terrain: { speed: -1 } });
    const map = l.maps["map_start" as never]! as unknown as { layers: { name: string; tiles: number[] }[]; width: number };
    const ground = map.layers.find((x) => x.name === "ground")!;
    const walls = map.layers.find((x) => x.name === "walls")!;
    walls.tiles[2 * map.width + 2] = SAND; // 上のレイヤの砂
    expect(walk(l, start(l), "right").frames).toBe(32);
    ground.tiles[2 * map.width + 2] = SAND; // 下のレイヤにも同じ砂
    expect(walk(l, start(l), "right").frames).toBe(32);
  });

  it("ChangeMapTile で書き換えた足元のタイルを見る", () => {
    const l = setup({ terrain: { speed: -1 } });
    const s = start(l);
    const changed: GameState = { ...s, mapTiles: { ["map_start" as never]: { [tileKey(0, 2, 2)]: SAND } } };
    expect(walk(l, changed, "right").frames).toBe(32);
  });
});

describe("歩く速さ：状態（system.speedRules）", () => {
  it("スイッチ：空腹のとき遅くなる", () => {
    const l = setup({ speedRules: [hungry(true)] });
    const s = start(l);
    expect(walk(l, withSwitch(s, "hungry", false), "right").frames).toBe(16);
    expect(walk(l, withSwitch(s, "hungry", true), "right").frames).toBe(32);
  });

  it("変数：満腹度が 10 以下のとき遅くなる。所持品・パーティにも条件を置ける", () => {
    const rules: SpeedRule[] = [
      { when: [{ kind: "variable", id: "food" as never, op: "<=", value: 10 }], speed: -1 },
      { when: [{ kind: "item", id: "item_boots" as never }], speed: 1 },
    ];
    const l = setup({ speedRules: rules });
    const s = start(l);
    const food = (n: number): GameState => ({ ...s, variables: { ...s.variables, ["food" as never]: n } });
    expect(walk(l, food(11), "right").frames).toBe(16);
    expect(walk(l, food(10), "right").frames).toBe(32);
    const boots = { ...food(11), party: { ...s.party, items: { ...s.party.items, ["item_boots" as never]: 1 } } };
    expect(walk(l, boots, "right").frames).toBe(8); // 持っていると速い
    expect(walk(l, { ...boots, variables: { ["food" as never]: 3 } }, "right").frames).toBe(16); // 空腹 −1 + ブーツ +1
  });

  it("条件がすべて成り立ったときだけ効く。複数のルールは足し合わせ、速さは 1〜6 に収める", () => {
    const rules: SpeedRule[] = [
      { when: [{ kind: "switch", id: "a" as never, value: true }, { kind: "switch", id: "b" as never, value: true }], speed: -1 },
      { when: [{ kind: "switch", id: "a" as never, value: true }], speed: -1 },
      { when: [], speed: 0 },
    ];
    const l = setup({ speedRules: rules });
    const s = start(l);
    expect(walk(l, withSwitch(s, "a", true), "right").frames).toBe(32); // 2 つ目だけ
    expect(walk(l, withSwitch(withSwitch(s, "a", true), "b", true), "right").frames).toBe(64); // −1 −1
    const slow = setup({ speedRules: [{ when: [], speed: -5 }] });
    const floor = walk(slow, start(slow), "right");
    expect(floor.frames).toBe(128); // 1 が下限
  });

  it("when が空のルールは、いつでも効く", () => {
    const l = setup({ speedRules: [{ when: [], speed: 1 }] });
    expect(walk(l, start(l), "right").frames).toBe(8);
  });
});

describe("歩く速さ：岩を押すとき・セーブ", () => {
  const rockPage = (): EventPage => ({
    conditions: [],
    trigger: "action",
    through: false,
    priority: "same",
    pushable: true,
    graphic: { asset: "a" as never, index: 0, direction: "down" },
    commands: [],
  });
  const rock: MapEvent = { id: "rock" as never, name: "rock", x: 3, y: 2, pages: [rockPage()] };

  it("岩はプレイヤーと同じ速さで動く（走っても遅くても離れない）", () => {
    const l = setup({ dash: true, events: [rock] });
    const run = walk(l, start(l), "right", true);
    expect(at(run.state)).toEqual([3, 2]);
    expect(run.state.map.events["rock" as never]).toMatchObject({ x: 4, y: 2, moving: false });
    expect(run.frames).toBe(8);

    const slow = setup({ speedRules: [{ when: [], speed: -1 }], events: [rock] });
    const s = step(start(slow), push("right", false), slow.ctx).state;
    expect(s.map.events["rock" as never]!.speed).toBe(3);
    expect(s.map.moveSpeed).toBe(3);
  });

  it("歩いている途中のセーブには moveSpeed を含めない（読み込んだ状態と、保存した状態が一致する）", () => {
    const l = setup({ dash: true });
    const s = step(start(l), push("right", true), l.ctx).state;
    expect(s.map.moveSpeed).toBe(5);
    const snap = toSnapshot(s, { projectId: "minimal", projectHash: "h", savedAt: "2026-01-01T00:00:00Z" });
    expect(snap.state.map).not.toHaveProperty("moveSpeed");
    const loaded = fromSnapshot(snap, l.ctx);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.value.map.moveSpeed).toBeUndefined();
  });

  it("同じ入力なら同じ状態になる（決定論）", () => {
    const l = setup({ dash: true, terrain: { speed: -1 }, sand: [[3, 2]], speedRules: [hungry(true)] });
    const run = (): GameState => {
      let s = withSwitch(start(l), "hungry", true);
      for (const [dir, dash] of [["right", true], ["right", false], ["down", true]] as const) s = walk(l, s, dir, dash).state;
      return s;
    };
    expect(run()).toEqual(run());
  });
});
