import type { FrameSpec } from "@rpg/runtime";
import { describe, expect, it } from "vitest";
import { buildDrawList, fontOf, TEXT_PAD, wrapText } from "./draw-list.js";
import type { DrawEnv, Quad } from "./draw-list.js";

const TILESET = "aaaaaaaaaaaaaaaa" as never;
const SPRITE = "bbbbbbbbbbbbbbbb" as never;
const UNLOADED = "cccccccccccccccc" as never;
const sizes: Record<string, { width: number; height: number }> = { [TILESET]: { width: 64, height: 32 }, [SPRITE]: { width: 96, height: 128 } };
const env: DrawEnv = {
  image: (id) => sizes[id],
  measure: (_font, text) => [...text].length * 10,
};
const white = { r: 255, g: 255, b: 255, a: 1 };
const frame = (over: Partial<FrameSpec> = {}): FrameSpec => ({
  size: { width: 64, height: 48 },
  camera: { x: 0, y: 0 },
  layers: [],
  overlay: { fade: 0, tint: { r: 0, g: 0, b: 0, a: 0 }, shake: { dx: 0, dy: 0 } },
  ui: [],
  ...over,
});
const solids = (quads: Quad[]): Quad[] => quads.filter((q) => q.tex.kind === "white");

describe("buildDrawList: レイヤ", () => {
  const tiles = (over: Partial<Extract<FrameSpec["layers"][number], { kind: "tiles" }>> = {}): FrameSpec["layers"][number] => ({
    kind: "tiles",
    tileset: TILESET,
    tileSize: 16,
    width: 4,
    height: 3,
    tiles: [1, 0, 5, 0, 0, 2, 0, 0, 0, 0, 0, 9],
    z: 0,
    ...over,
  });

  it("タイル：空タイル（0 以下）を飛ばし、タイルセット画像の該当セルのテクスチャ座標を使う", () => {
    const q = buildDrawList(frame({ layers: [tiles()] }), env);
    // タイルセットは 64×32（4 列 × 2 行）。id 1 → (1,0)、id 5 → (1,1)、id 2 → (2,0)。id 9 は sy + ts > height なので飛ばす
    expect(q.map((x) => [x.x, x.y, x.u0, x.v0])).toEqual([
      [0, 0, 16 / 64, 0],
      [32, 0, 16 / 64, 16 / 32],
      [16, 16, 32 / 64, 0],
    ]);
    expect(q.every((x) => x.w === 16 && x.h === 16 && x.a === 1)).toBe(true);
    expect(q[0]).toMatchObject({ u1: 32 / 64, v1: 16 / 32, tex: { kind: "asset", id: TILESET } });
  });

  it("タイル：カメラとシェイクのオフセットを掛け、見えている範囲だけを出す", () => {
    const wide = tiles({ width: 10, height: 1, tiles: Array.from({ length: 10 }, () => 1) });
    const q = buildDrawList(frame({ camera: { x: 40, y: 0 }, overlay: { fade: 0, tint: { r: 0, g: 0, b: 0, a: 0 }, shake: { dx: 3, dy: 0 } }, layers: [wide] }), env);
    // 画面は幅 64、offset = -40 + 3 = -37 → 見える x は 37..100 → タイル列 2..6
    expect(q.map((x) => x.x)).toEqual([2, 3, 4, 5, 6].map((c) => c * 16 - 37));
  });

  it("タイル：未ロード・タイルセット無し・タイルサイズ不正・配列が短い・列が 0 のときは何も出さない", () => {
    const cases = [
      tiles({ tileset: UNLOADED }),
      tiles({ tileset: null }),
      tiles({ tileSize: 0 }),
      tiles({ tileSize: -1 }),
      tiles({ tiles: [1] }),
      tiles({ tileSize: 128 }), // タイルセット画像より大きい → 列が 0
    ];
    for (const layer of cases) expect(buildDrawList(frame({ layers: [layer] }), env)).toEqual([]);
  });

  it("スプライト：位置にオフセットを掛け、flipX は u を入れ替え、alpha は頂点色の a に入る。未ロードは飛ばす", () => {
    const q = buildDrawList(
      frame({
        camera: { x: 10, y: 20 },
        layers: [
          {
            kind: "sprites",
            z: 0,
            sprites: [
              { asset: SPRITE, sx: 32, sy: 64, sw: 32, sh: 32, x: 100, y: 100 },
              { asset: SPRITE, sx: 32, sy: 64, sw: 32, sh: 32, x: 0, y: 0, flipX: true, alpha: 0.5 },
              { asset: UNLOADED, sx: 0, sy: 0, sw: 8, sh: 8, x: 0, y: 0 },
            ],
          },
        ],
      }),
      env,
    );
    expect(q).toHaveLength(2);
    expect(q[0]).toMatchObject({ x: 90, y: 80, w: 32, h: 32, u0: 32 / 96, u1: 64 / 96, v0: 64 / 128, v1: 96 / 128, a: 1 });
    expect(q[1]).toMatchObject({ u0: 64 / 96, u1: 32 / 96, a: 0.5 });
  });
});

describe("buildDrawList: overlay と UI", () => {
  it("overlay は 色調 → フラッシュ → 暗転 の順で、画面全体の単色。a が 0 のものは出さない", () => {
    const q = buildDrawList(
      frame({ overlay: { fade: 0.25, tint: { r: 0, g: 0, b: 255, a: 0.5 }, flash: { color: { r: 255, g: 255, b: 255, a: 1 }, alpha: 0.5 }, shake: { dx: 0, dy: 0 } } }),
      env,
    );
    expect(q.map((x) => [x.r, x.g, x.b, x.a])).toEqual([
      [0, 0, 1, 0.5],
      [1, 1, 1, 0.5],
      [0, 0, 0, 0.25],
    ]);
    expect(q.every((x) => x.x === 0 && x.y === 0 && x.w === 64 && x.h === 48)).toBe(true);
    expect(buildDrawList(frame(), env)).toEqual([]);
    expect(buildDrawList(frame({ overlay: { fade: 0, tint: { r: 0, g: 0, b: 0, a: 0 }, flash: { color: white, alpha: 0 }, shake: { dx: 0, dy: 0 } } }), env)).toEqual([]);
  });

  it("色は Canvas2D と同じく、r/g/b を整数に丸め、範囲に収める", () => {
    const [q] = buildDrawList(frame({ overlay: { fade: 0, tint: { r: 127.6, g: -5, b: 999, a: 2 }, shake: { dx: 0, dy: 0 } } }), env);
    expect([q!.r, q!.g, q!.b, q!.a]).toEqual([128 / 255, 0, 1, 1]);
  });

  it("window：塗り → 縁取り 4 枚（重ならない）→ 子。dim は塗りだけ", () => {
    const q = buildDrawList(frame({ ui: [{ kind: "window", x: 2, y: 4, w: 30, h: 20, children: [{ kind: "gauge", x: 4, y: 6, w: 10, h: 2, ratio: 0.5, color: white }] }] }), env);
    expect(q).toHaveLength(1 + 4 + 2);
    expect(q[0]).toMatchObject({ x: 2, y: 4, w: 30, h: 20 });
    const [top, bottom, left, right] = q.slice(1, 5);
    expect([top, bottom, left, right].map((b) => [b!.x, b!.y, b!.w, b!.h])).toEqual([
      [2, 4, 30, 2],
      [2, 22, 30, 2],
      [2, 6, 2, 16],
      [30, 6, 2, 16],
    ]);
    // 縁取りの面積の合計 = 外側 30×20 − 内側 26×16
    expect([top, bottom, left, right].reduce((sum, b) => sum + b!.w * b!.h, 0)).toBe(30 * 20 - 26 * 16);
    const dim = buildDrawList(frame({ ui: [{ kind: "window", x: 0, y: 0, w: 5, h: 5, variant: "dim", children: [] }] }), env);
    expect(dim).toHaveLength(1);
    expect(dim[0]?.a).toBeCloseTo(0.6);
  });

  it("gauge：背景 + 割合ぶんの塗り。割合は 0〜1 に収める", () => {
    const q = buildDrawList(frame({ ui: [{ kind: "gauge", x: 1, y: 2, w: 20, h: 3, ratio: 1.7, color: white }, { kind: "gauge", x: 1, y: 2, w: 20, h: 3, ratio: -1, color: white }] }), env);
    expect(q.map((x) => x.w)).toEqual([20, 20, 20, 0]);
  });

  it("cursor：塗り + 縁をまたぐ 2px の枠（外側 1px・内側 1px）", () => {
    const q = buildDrawList(frame({ ui: [{ kind: "cursor", x: 10, y: 10, w: 20, h: 8, blink: true }] }), env);
    expect(q).toHaveLength(5);
    expect(q[0]).toMatchObject({ x: 10, y: 10, w: 20, h: 8 });
    expect(q.slice(1).map((b) => [b.x, b.y, b.w, b.h])).toEqual([
      [9, 9, 22, 2],
      [9, 17, 22, 2],
      [9, 11, 2, 6],
      [29, 11, 2, 6],
    ]);
  });

  it("image：切り出しの指定がなければ画像全体。未ロードは飛ばす", () => {
    const q = buildDrawList(
      frame({ ui: [{ kind: "image", x: 5, y: 6, asset: SPRITE }, { kind: "image", x: 0, y: 0, asset: SPRITE, sx: 32, sy: 0, sw: 32, sh: 64 }, { kind: "image", x: 0, y: 0, asset: UNLOADED }] }),
      env,
    );
    expect(q).toHaveLength(2);
    expect(q[0]).toMatchObject({ x: 5, y: 6, w: 96, h: 128, u0: 0, v1: 1 });
    expect(q[1]).toMatchObject({ w: 32, h: 64, u0: 32 / 96, u1: 64 / 96, v1: 64 / 128 });
  });
});

describe("buildDrawList: 文字", () => {
  const font = { family: "sans-serif", size: 16 };
  const text = (over: Partial<Extract<FrameSpec["ui"][number], { kind: "text" }>>): FrameSpec["ui"][number] => ({ kind: "text", x: 100, y: 10, text: "abc", font, color: white, ...over });

  it("1 行の文字：余白つきの矩形 1 枚。空文字は出さない。fontOf は太字を反映する", () => {
    const [q] = buildDrawList(frame({ ui: [text({})] }), env);
    expect(q).toMatchObject({ x: 100 - TEXT_PAD, y: 10 - TEXT_PAD, w: 30 + 2 * TEXT_PAD, h: 20 + 2 * TEXT_PAD, tex: { kind: "text", text: "abc", font: "16px sans-serif" } });
    expect(buildDrawList(frame({ ui: [text({ text: "" })] }), env)).toEqual([]);
    expect(fontOf({ family: "serif", size: 20, bold: true })).toBe("bold 20px serif");
  });

  it("align：center は幅の半分、right は幅ぶん左へ寄せる", () => {
    const xs = (align: "left" | "center" | "right") => buildDrawList(frame({ ui: [text({ align })] }), env)[0]!.x + TEXT_PAD;
    expect([xs("left"), xs("center"), xs("right")]).toEqual([100, 85, 70]);
  });

  it("maxWidth で 1 文字ずつ折り返し、行間は 1.25 倍", () => {
    const q = buildDrawList(frame({ ui: [text({ text: "あいうえお", maxWidth: 25 })] }), env);
    expect(q.map((x) => (x.tex.kind === "text" ? x.tex.text : ""))).toEqual(["あい", "うえ", "お"]);
    expect(q.map((x) => x.y + TEXT_PAD)).toEqual([10, 30, 50]);
    expect(wrapText(env, "x", "abc", undefined)).toEqual(["abc"]);
    expect(wrapText(env, "x", "abc", 0)).toEqual(["abc"]);
    expect(wrapText(env, "x", "", 10)).toEqual([""]);
  });

  it("runs：折り返さず、幅ぶんずつ右へ並べ、色は run ごと", () => {
    const red = { r: 255, g: 0, b: 0, a: 1 };
    const q = buildDrawList(frame({ ui: [text({ text: "ab", runs: [{ text: "a", color: red }, { text: "bc", color: white }], maxWidth: 1 })] }), env);
    expect(q.map((x) => [x.x + TEXT_PAD, x.r])).toEqual([
      [100, 1],
      [110, 1],
    ]);
    expect(q.map((x) => x.g)).toEqual([0, 1]);
  });

  it("描く順は UI の並びのとおり（前のものの上に重なる）", () => {
    const q = buildDrawList(frame({ ui: [{ kind: "window", x: 0, y: 0, w: 40, h: 20, children: [text({ x: 4, y: 4 })] }, { kind: "cursor", x: 0, y: 0, w: 5, h: 5, blink: false }] }), env);
    const kinds = q.map((x) => x.tex.kind);
    expect(kinds.indexOf("text")).toBeGreaterThan(4); // 窓の塗りと縁取りのあと
    expect(kinds.lastIndexOf("text")).toBeLessThan(kinds.length - 5); // カーソル（塗り + 枠 4）より前
    expect(solids(q).length).toBe(q.length - 1);
  });
});
