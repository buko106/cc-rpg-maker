import { describe, expect, it } from "vitest";
import type { Character, EventRuntime, GameState } from "@rpg/core";
import { createRuntimeHarness, deepFreeze, expandInputs, summarizeFrame } from "@rpg/test-utils";
import type { RuntimeHarness } from "@rpg/test-utils";
import { projectFrame } from "./index.js";
import type { FrameLayer, FrameSpec } from "../index.js";
import type { UiNode } from "../frame-spec.js";

const HERO = "0123456789abcdef" as never; // minimal の hero.png（96x128 = 1 キャラ、32px）

const boot = (project = "minimal"): Promise<RuntimeHarness> => createRuntimeHarness({ project });
const view = (h: RuntimeHarness) => h.loaded.view;

const withMessage = (s: GameState, m: Partial<GameState["message"]>): GameState => ({ ...s, message: { ...s.message, open: true, owner: "i0", ...m } });
const withPlayer = (s: GameState, p: Partial<Character>): GameState => ({ ...s, map: { ...s.map, player: { ...s.map.player, ...p } } });
const spritesOf = (f: FrameSpec): Extract<FrameLayer, { kind: "sprites" }>[] => f.layers.filter((l): l is Extract<FrameLayer, { kind: "sprites" }> => l.kind === "sprites");

describe("projectFrame（マップシーン）", () => {
  it("[snapshot] minimal の初期状態", async () => {
    const h = await boot();
    expect(summarizeFrame(projectFrame(h.runtime.getState(), view(h)))).toMatchSnapshot();
  });

  it("[snapshot] transfer-demo の初期状態", async () => {
    const h = await boot("transfer-demo");
    expect(summarizeFrame(projectFrame(h.runtime.getState(), view(h)))).toMatchSnapshot();
  });

  it("[snapshot] 会話中（メッセージウィンドウ表示中）は UI ノードだけを見る", async () => {
    const h = await boot();
    h.play(...expandInputs([{ hold: "right", frames: 100 }, { press: "ok" }, { wait: 1 }]));
    const frame = projectFrame(h.runtime.getState(), view(h));
    expect({ camera: frame.camera, ui: frame.ui }).toMatchSnapshot();
  });

  it("[inv-3] project は純粋：同じ state から deep-equal な FrameSpec。state は変更されない", async () => {
    const h = await boot();
    const state = deepFreeze(withMessage(h.runtime.getState(), { text: "\\C[2]赤\\C[0]と\\V[var_talk_count]" }));
    const a = projectFrame(state, view(h));
    const b = projectFrame(state, view(h));
    expect(a).toEqual(b);
    expect(JSON.parse(JSON.stringify(a))).toEqual(a); // JSON 化しても同じ（純データ）
  });

  it("タイルレイヤは MapData の layers をそのまま（tileset 画像が無ければ null）、z は 0 から", async () => {
    const h = await boot();
    const frame = projectFrame(h.runtime.getState(), view(h));
    const tiles = frame.layers.filter((l) => l.kind === "tiles");
    expect(tiles).toHaveLength(2);
    expect(tiles.map((l) => l.z)).toEqual([0, 1]);
    expect(tiles[0]).toMatchObject({ tileset: null, tileSize: 32, width: 10, height: 8 });
    expect((tiles[0] as unknown as { tiles: number[] }).tiles).toHaveLength(80);
  });

  it("ChangeMapTile で書き換えたタイルを描く（MapData は変えない）", async () => {
    const h = await boot();
    const s0 = h.runtime.getState();
    const changed = { ...s0, mapTiles: { [s0.map.mapId]: { "1:3,2": 5 } } } as GameState;
    const tiles = projectFrame(changed, view(h)).layers.filter((l) => l.kind === "tiles") as unknown as { tiles: number[] }[];
    expect(tiles[1]!.tiles[2 * 10 + 3]).toBe(5);
    expect(tiles[0]!.tiles[2 * 10 + 3]).toBe(1);
    expect(view(h).map(s0.map.mapId)!.layers[1]!.tiles[2 * 10 + 3]).not.toBe(5);
  });

  it("イベントのスプライトはシートの規約（3 パターン × 4 方向、コマ = tileSize）で切り出す", async () => {
    const h = await boot();
    const [layer] = spritesOf(projectFrame(h.runtime.getState(), view(h)));
    // ev_npc: (5,2)、向き = 下（row 0）、止まっているので中央パターン
    expect(layer?.sprites).toEqual([{ asset: HERO, sx: 32, sy: 0, sw: 32, sh: 32, x: 160, y: 64 }]);
  });

  it("プレイヤー：向きで行、歩行中は前半・後半でパターンが替わる。座標は realX/realY から", async () => {
    const h = await boot();
    const s0 = h.runtime.getState();
    const player = (p: Partial<Character>): FrameSpec => projectFrame(withPlayer(s0, { graphic: { asset: HERO, index: 0 }, ...p }), view(h));
    const me = (f: FrameSpec) => spritesOf(f)[0]!.sprites.at(-1)!; // 同じ高さなら後ろ（手前）に描く

    expect(me(player({ direction: "left" }))).toMatchObject({ sx: 32, sy: 32 });
    expect(me(player({ direction: "right" }))).toMatchObject({ sy: 64 });
    expect(me(player({ direction: "up" }))).toMatchObject({ sy: 96 });
    // 歩行中：目的地 (x=3) までの残りが半分以上 → パターン 0、半分未満 → 2
    expect(me(player({ x: 3, realX: 2.25, y: 2, realY: 2, moving: true }))).toMatchObject({ sx: 0, x: 72, y: 64 });
    expect(me(player({ x: 3, realX: 2.75, y: 2, realY: 2, moving: true }))).toMatchObject({ sx: 64, x: 88 });
  });

  it("スプライトは y ソート（下にいるものが手前）で、同じ高さならプレイヤーが最後", async () => {
    const h = await boot();
    const s0 = h.runtime.getState();
    const npc = s0.map.events["ev_npc" as never] as EventRuntime;
    const mk = (id: string, y: number, priority: EventRuntime["priority"] = "same"): [string, EventRuntime] => [id, { ...npc, id: id as never, x: 1, y, realX: 1, realY: y, priority }];
    const state: GameState = {
      ...withPlayer(s0, { graphic: { asset: HERO, index: 0 }, x: 4, y: 3, realX: 4, realY: 3 }),
      map: {
        ...s0.map,
        player: { ...s0.map.player, graphic: { asset: HERO, index: 0 }, x: 4, y: 3, realX: 4, realY: 3 },
        events: Object.fromEntries([mk("b_low", 5), mk("a_high", 1), mk("c_same_as_player", 3), mk("d_below", 6, "below"), mk("e_above", 0, "above")]) as never,
      },
    };
    const layers = spritesOf(projectFrame(state, view(h)));
    expect(layers.map((l) => l.z)).toEqual([100, 200, 300]); // below, same, above
    expect(layers[1]!.sprites.map((s) => [s.x, s.y])).toEqual([
      [32, 32], // a_high (y=1)
      [32, 96], // c_same_as_player (y=3)
      [128, 96], // player (y=3) — 同じ高さでは最後
      [32, 160], // b_low (y=5)
    ]);
  });

  it("ページが無効なイベントとグラフィックの無いキャラクターは描かない", async () => {
    const h = await boot();
    const s0 = h.runtime.getState();
    const npc = s0.map.events["ev_npc" as never] as EventRuntime;
    const inactive: GameState = { ...s0, map: { ...s0.map, events: { ev_npc: { ...npc, pageIndex: null } } as never } };
    expect(spritesOf(projectFrame(inactive, view(h)))).toEqual([]);
    const { graphic: _graphic, ...noGraphic } = npc;
    expect(spritesOf(projectFrame({ ...s0, map: { ...s0.map, events: { ev_npc: noGraphic } as never } }, view(h)))).toEqual([]);
  });

  it("シートが複数キャラなら index でブロックを選ぶ", async () => {
    const h = await boot();
    const s0 = h.runtime.getState();
    // hero.png は幅 96（1 ブロック）なので、index 1 は次の行のブロックへ折り返す
    const f = projectFrame(withPlayer(s0, { graphic: { asset: HERO, index: 1 } }), view(h));
    expect(spritesOf(f)[0]!.sprites.at(-1)).toMatchObject({ sx: 32, sy: 128 });
  });

  it("カメラはタイル単位からピクセルに変換して丸める", async () => {
    const h = await boot();
    const s0 = h.runtime.getState();
    const f = projectFrame({ ...s0, map: { ...s0.map, camera: { x: 1.26, y: 0.5 } } }, view(h));
    expect(f.camera).toEqual({ x: 40, y: 16 });
    expect(f.size).toEqual({ width: 320, height: 256 });
  });

  it("マップが未ロード（場所移動待ち）なら描画するレイヤは無い", async () => {
    const h = await boot();
    const s0 = h.runtime.getState();
    const f = projectFrame({ ...s0, map: { ...s0.map, mapId: "unloaded" as never } }, view(h));
    expect(f.layers).toEqual([]);
  });

  it("戦闘の状態（battle）が無いのにシーンだけ戦闘のときは、マップの上に何も足さない（落ちない）", async () => {
    const h = await boot();
    const f = projectFrame({ ...h.runtime.getState(), scene: { kind: "battle" } }, view(h));
    expect(f.layers.length).toBeGreaterThan(0);
    expect(f.ui).toEqual([]);
  });
});

describe("projectFrame（メッセージ）", () => {
  const ui = async (m: Partial<GameState["message"]>, patch?: (s: GameState) => GameState): Promise<readonly UiNode[]> => {
    const h = await boot();
    const s = withMessage(patch ? patch(h.runtime.getState()) : h.runtime.getState(), m);
    return projectFrame(s, view(h)).ui;
  };
  const texts = (nodes: readonly UiNode[]): UiNode[] => (nodes[0]?.kind === "window" ? [...nodes[0].children] : [...nodes]);

  it("閉じていれば何も出さない", async () => {
    const h = await boot();
    expect(projectFrame(h.runtime.getState(), view(h)).ui).toEqual([]);
  });

  it("位置：top / middle / bottom（画面 320x256、ウィンドウの高さ 108）", async () => {
    const pos = async (position: "top" | "middle" | "bottom") => {
      const [w] = await ui({ text: "x", position });
      return w?.kind === "window" ? [w.x, w.y, w.w, w.h] : undefined;
    };
    expect(await pos("top")).toEqual([4, 4, 312, 108]);
    expect(await pos("middle")).toEqual([4, 74, 312, 108]);
    expect(await pos("bottom")).toEqual([4, 144, 312, 108]);
  });

  it("背景：window は枠付き、dim は dim バリアント、transparent は文字だけ", async () => {
    const [w1] = await ui({ text: "a", background: "window" });
    const [w2] = await ui({ text: "a", background: "dim" });
    const rest = await ui({ text: "a", background: "transparent" });
    expect(w1).toMatchObject({ kind: "window", variant: "normal" });
    expect(w2).toMatchObject({ kind: "window", variant: "dim" });
    expect(rest.map((n) => n.kind)).toEqual(["text"]);
  });

  it("制御文字を展開する：\\V[var] と \\N[actor] と \\C[n]（色替えのある行は runs）", async () => {
    const nodes = texts(await ui({ text: "\\N[actor_hero]は\\C[2]赤\\C[0]い\n会話 \\V[var_talk_count] 回" }, (s) => ({ ...s, variables: { var_talk_count: 3 } as never })));
    expect(nodes).toHaveLength(2);
    expect(nodes[0]).toMatchObject({ kind: "text", text: "勇者は赤い", runs: [{ text: "勇者は" }, { text: "赤", color: { r: 255, g: 120, b: 76 } }, { text: "い" }] });
    expect(nodes[1]).toMatchObject({ kind: "text", text: "会話 3 回" });
    expect(nodes[1]).not.toHaveProperty("runs");
  });

  it("表示は 4 行まで。空行は詰めず行位置を保つ", async () => {
    const nodes = texts(await ui({ text: "1\n\n3\n4\n5\n6" }));
    expect(nodes.map((n) => (n.kind === "text" ? [n.text, n.y] : null))).toEqual([
      ["1", 154],
      ["3", 198],
      ["4", 220],
    ]);
  });

  it("顔グラフィックがあれば画像を置き、文字を右へずらす", async () => {
    const nodes = texts(await ui({ text: "hi", face: { asset: HERO } }));
    expect(nodes[0]).toMatchObject({ kind: "image", asset: HERO, x: 14, y: 154, sw: 72, sh: 72 });
    expect(nodes[1]).toMatchObject({ kind: "text", x: 96 });
  });
});
