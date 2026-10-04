// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { AssetSource, FrameSpec, ImageHandle } from "@rpg/runtime";
import { rendererContract } from "@rpg/test-utils";
import { createAsciiRenderer, createSampler, gridToText, isWide, rasterize } from "./index.js";
import type { ImageSampler } from "./index.js";

/** 単色の画像（`a` は 0〜255）。 */
const solid = (w: number, h: number, r: number, g: number, b: number, a = 255): ImageSampler => createSampler(w, h, Array.from({ length: w * h }, () => [r, g, b, a]).flat());
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const white = { r: 255, g: 255, b: 255, a: 1 };

const frame = (over: Partial<FrameSpec> = {}): FrameSpec => ({
  size: { width: 64, height: 32 },
  camera: { x: 0, y: 0 },
  layers: [],
  overlay: { fade: 0, tint: { r: 0, g: 0, b: 0, a: 0 }, shake: { dx: 0, dy: 0 } },
  ui: [],
  ...over,
});

const AAA = "aaaaaaaaaaaaaaaa" as never;
const BBB = "bbbbbbbbbbbbbbbb" as never;
const opts = (images: Record<string, ImageSampler>) => ({ cellW: 8, cellH: 16, sampler: (id: string) => images[id] });

function assetsOf(images: Record<string, ImageHandle>): AssetSource {
  return {
    loadImage: (id) => (images[id] === undefined ? Promise.reject(new Error("missing")) : Promise.resolve(images[id]!)),
    loadAudio: () => Promise.reject(new Error("n/a")),
    loadJson: () => Promise.reject(new Error("n/a")),
    has: (id) => Promise.resolve(id in images),
  };
}

rendererContract("ascii (jsdom)", () => createAsciiRenderer(document.createElement("div"), { sampleImage: () => Promise.resolve(solid(8, 8, 9, 9, 9)) }));

describe("createSampler", () => {
  it("矩形の平均色を返し、透明な部分は α で割り戻す", () => {
    // 左半分が不透明な赤、右半分が透明
    const px = [255, 0, 0, 255, 0, 0, 0, 0, 255, 0, 0, 255, 0, 0, 0, 0];
    const s = createSampler(2, 2, px);
    expect(s.avg(0, 0, 1, 2)).toEqual({ r: 255, g: 0, b: 0, a: 1 });
    expect(s.avg(0, 0, 2, 2)?.a).toBeCloseTo(0.5);
    expect(s.avg(0, 0, 2, 2)?.r).toBeCloseTo(255);
    expect(s.avg(1, 0, 1, 2)).toBeUndefined();
  });
});

describe("rasterize", () => {
  it("明るいタイルほど濃い文字になり、空タイルと未ロードは描かない", () => {
    const f = frame({
      layers: [
        { kind: "tiles", tileset: AAA, tileSize: 16, width: 4, height: 1, tiles: [1, 2, 0, 3], z: 0 },
        { kind: "tiles", tileset: BBB, tileSize: 16, width: 1, height: 1, tiles: [1], z: 1 },
      ],
    });
    // タイルセットは 4 セル（暗・中・明）。16x16 のタイル 1 つがマス 2 つ(横)×1(縦)
    const px: number[] = [];
    for (let y = 0; y < 16; y++) for (let x = 0; x < 64; x++) px.push(...(x < 16 ? [10, 10, 10, 255] : x < 32 ? [128, 128, 128, 255] : x < 48 ? [255, 255, 255, 255] : [0, 0, 0, 0]));
    const g = rasterize(f, opts({ aaaaaaaaaaaaaaaa: createSampler(64, 16, px) }));
    const text = gridToText(g).split("\n")[0]!;
    // セルは左から 暗(0)・中(1)・明(2)・透明(3)。id 0 は空、透明な絵のタイル(3)は描かれない
    expect(text).toBe("++@@");
  });

  it("スプライトは flipX で左右が入れ替わり、半透明の α を反映する", () => {
    // 左半分が白、右半分が黒の 16x16
    const px: number[] = [];
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) px.push(...(x < 8 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
    const sheet = createSampler(16, 16, px);
    const draw = (extra: object): string => gridToText(rasterize(frame({ layers: [{ kind: "sprites", z: 0, sprites: [{ asset: AAA, sx: 0, sy: 0, sw: 16, sh: 16, x: 0, y: 0, ...extra }] }] }), opts({ aaaaaaaaaaaaaaaa: sheet }))).split("\n")[0]!;
    expect(draw({})).toBe("@a");
    expect(draw({ flipX: true })).toBe("a@");
    expect(draw({ alpha: 0.1 })).toBe("");
  });

  it("UI の文字はそのまま出て、全角は 2 マスを使い、maxWidth で折り返す", () => {
    const g = rasterize(frame({ ui: [{ kind: "text", x: 8, y: 0, text: "あaい", font: { family: "x", size: 12 }, color: white }] }), opts({}));
    expect(gridToText(g).split("\n")[0]).toBe(" あaい");
    expect(isWide("あ")).toBe(true);
    expect(isWide("a")).toBe(false);
    const wrapped = rasterize(frame({ size: { width: 64, height: 64 }, ui: [{ kind: "text", x: 0, y: 0, text: "abcdef", font: { family: "x", size: 12 }, color: white, maxWidth: 24 }] }), opts({}));
    expect(gridToText(wrapped).split("\n").slice(0, 2)).toEqual(["abc", "def"]);
    // align: 中央と右
    const right = rasterize(frame({ ui: [{ kind: "text", x: 64, y: 0, text: "ab", font: { family: "x", size: 12 }, color: white, align: "right" }] }), opts({}));
    expect(gridToText(right).split("\n")[0]).toBe("      ab");
  });

  it("window は背景を塗り、gauge は # と . の割合で出す", () => {
    const g = rasterize(
      frame({
        ui: [
          { kind: "window", x: 0, y: 0, w: 32, h: 32, children: [{ kind: "gauge", x: 8, y: 0, w: 16, h: 16, ratio: 0.5, color: white }] },
        ],
      }),
      opts({}),
    );
    expect(g.cells[0]!.bg).toBeDefined();
    expect(gridToText(g).split("\n")[0]).toBe(" #.");
  });

  it("overlay の fade で全体が暗くなる", () => {
    const f = frame({
      layers: [{ kind: "tiles", tileset: AAA, tileSize: 16, width: 1, height: 1, tiles: [0], z: 0 }],
      overlay: { fade: 1, tint: { r: 0, g: 0, b: 0, a: 0 }, shake: { dx: 0, dy: 0 } },
    });
    const g = rasterize(f, opts({}));
    expect(g.cells.every((c) => c.bg?.every((v) => v === 0) === true)).toBe(true);
  });

  it("壊れた値（NaN・短いタイル配列）でも例外を出さない", () => {
    const f = frame({
      camera: { x: Number.NaN, y: 0 },
      layers: [{ kind: "tiles", tileset: AAA, tileSize: 16, width: 9, height: 9, tiles: [1], z: 0 }],
      ui: [{ kind: "text", x: Number.NaN, y: -5, text: "x", font: { family: "x", size: Number.NaN }, color: white }],
    });
    expect(() => rasterize(f, opts({ aaaaaaaaaaaaaaaa: solid(16, 16, 1, 1, 1) }))).not.toThrow();
  });
});

describe("createAsciiRenderer", () => {
  it("未ロードの画像は描かず、ロード後の次のフレームから描く。text() で文字だけ読める", async () => {
    const root = document.createElement("div");
    const r = createAsciiRenderer(root, { sampleImage: () => Promise.resolve(solid(32, 16, 255, 255, 255)) });
    await r.init({ width: 64, height: 32, assets: assetsOf({ aaaaaaaaaaaaaaaa: { width: 32, height: 16 } as unknown as ImageHandle }) });
    const f = frame({ layers: [{ kind: "tiles", tileset: AAA, tileSize: 16, width: 1, height: 1, tiles: [1], z: 0 }] });
    r.render(f);
    expect(r.text().trim()).toBe("");
    await flush();
    r.render(f);
    expect(r.text().split("\n")[0]).toBe("@@");
    expect(root.dataset["renderer"]).toBe("ascii");
    expect(root.textContent).toContain("@@");
    r.dispose();
    expect(root.childElementCount).toBe(0);
  });

  it("同じ内容なら DOM を作り直さない", async () => {
    const root = document.createElement("div");
    const r = createAsciiRenderer(root);
    await r.init({ width: 64, height: 32, assets: assetsOf({}) });
    const f = frame({ ui: [{ kind: "text", x: 0, y: 0, text: "hi", font: { family: "x", size: 12 }, color: white }] });
    r.render(f);
    const first = root.firstElementChild;
    r.render(frame({ ui: [...f.ui] }));
    expect(root.firstElementChild).toBe(first);
  });
});
