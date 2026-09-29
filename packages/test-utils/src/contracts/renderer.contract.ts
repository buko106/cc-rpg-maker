import { describe, expect, it } from "vitest";
import type { AssetSource, FrameSpec, Renderer } from "@rpg/runtime";
import { deepFreeze } from "../harness/freeze.js";
import type { ContractFactory } from "./contract.js";

/** どのアセットも「無い」ことにする AssetSource。レンダラの未ロード時の挙動を確かめるのに使う。 */
export const missingAssets: AssetSource = {
  loadImage: (id) => Promise.reject(new Error(`missing asset ${id}`)),
  loadAudio: (id) => Promise.reject(new Error(`missing asset ${id}`)),
  loadJson: (id) => Promise.reject(new Error(`missing asset ${id}`)),
  has: () => Promise.resolve(false),
};

const white = { r: 255, g: 255, b: 255, a: 1 };

/** 全種類のノードを 1 つずつ含む FrameSpec（アセットは存在しない ID）。 */
export function sampleFrame(): FrameSpec {
  return {
    size: { width: 64, height: 48 },
    camera: { x: 8, y: 4 },
    layers: [
      { kind: "tiles", tileset: "aaaaaaaaaaaaaaaa" as never, tileSize: 16, width: 4, height: 3, tiles: [1, 0, 2, 0, 0, 3, 0, 0, 1, 1, 1, 1], z: 0 },
      { kind: "tiles", tileset: null, tileSize: 16, width: 1, height: 1, tiles: [1], z: 1 },
      { kind: "sprites", sprites: [{ asset: "bbbbbbbbbbbbbbbb" as never, sx: 0, sy: 0, sw: 16, sh: 16, x: 16, y: 16, alpha: 0.5, flipX: true }], z: 2 },
    ],
    overlay: { fade: 0.25, tint: { r: 0, g: 0, b: 64, a: 0.2 }, flash: { color: white, alpha: 0.5 }, shake: { dx: 2, dy: -1 } },
    ui: [
      {
        kind: "window",
        x: 2,
        y: 2,
        w: 60,
        h: 30,
        children: [
          { kind: "text", x: 4, y: 4, text: "こんにちは", font: { family: "sans-serif", size: 12 }, color: white, maxWidth: 40 },
          { kind: "text", x: 4, y: 18, text: "ab", font: { family: "sans-serif", size: 12 }, color: white, runs: [{ text: "a", color: white }, { text: "b", color: white }] },
          { kind: "gauge", x: 4, y: 26, w: 20, h: 3, ratio: 0.5, color: white },
          { kind: "cursor", x: 30, y: 4, w: 10, h: 10, blink: true },
          { kind: "image", x: 40, y: 4, asset: "cccccccccccccccc" as never, sx: 0, sy: 0, sw: 8, sh: 8 },
        ],
      },
    ],
  };
}

/** 壊れた値（NaN・負のサイズ・短すぎるタイル配列）を含む FrameSpec。 */
function brokenFrame(): FrameSpec {
  const f = sampleFrame();
  return {
    ...f,
    camera: { x: Number.NaN, y: Number.POSITIVE_INFINITY },
    layers: [{ kind: "tiles", tileset: "aaaaaaaaaaaaaaaa" as never, tileSize: -1, width: 100, height: 100, tiles: [1], z: 0 }, ...f.layers],
  };
}

/**
 * Renderer の契約スイート。すべての Renderer アダプタが通さなければならない（docs/07-render.md の不変条件）。
 * 不変条件 4（canvas2d と webgl の同一性）はピクセル比較なので、ブラウザの E2E で検証する。
 * `make` は `init` 前の Renderer を返す。
 */
export function rendererContract(name: string, make: ContractFactory<Renderer>, opts: { assets?: AssetSource } = {}): void {
  const assets = opts.assets ?? missingAssets;
  const init = async (): Promise<Renderer> => {
    const r = await make();
    await r.init({ width: 64, height: 48, assets });
    return r;
  };

  describe(`Renderer contract: ${name}`, () => {
    it("[inv-1] init → render → resize → render → dispose → render は例外を出さない", async () => {
      const r = await init();
      expect(() => r.render(sampleFrame())).not.toThrow();
      expect(() => r.resize(128, 96)).not.toThrow();
      expect(() => r.render(sampleFrame())).not.toThrow();
      expect(() => r.dispose()).not.toThrow();
      expect(() => r.render(sampleFrame())).not.toThrow();
    });

    it("[inv-1] 未ロードのアセット・不正な座標があっても render は例外を出さない", async () => {
      const r = await init();
      for (let i = 0; i < 3; i++) expect(() => r.render(brokenFrame())).not.toThrow();
      // 非同期ロードの失敗が完了した後の次のフレームでも
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(() => r.render(sampleFrame())).not.toThrow();
      r.dispose();
    });

    it("[inv-2] render は FrameSpec を変更しない", async () => {
      const r = await init();
      const frame = deepFreeze(sampleFrame());
      const before = JSON.stringify(frame);
      expect(() => r.render(frame)).not.toThrow();
      expect(JSON.stringify(frame)).toBe(before);
      r.dispose();
    });

    it("[inv-3] dispose は繰り返し呼んでもよい", async () => {
      const r = await init();
      r.dispose();
      expect(() => r.dispose()).not.toThrow();
      expect(() => r.resize(10, 10)).not.toThrow();
    });
  });
}
