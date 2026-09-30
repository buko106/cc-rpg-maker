import type { AssetSource, FrameSpec, ImageHandle } from "@rpg/runtime";
import { rendererContract, sampleFrame } from "@rpg/test-utils";
import { describe, expect, it } from "vitest";
import { createWebglRenderer, isWebglAvailable } from "./index.js";
import type { TextSurface } from "./index.js";

/** 呼び出しを記録するだけの WebGL コンテキスト（シェーダのコンパイルなどは常に成功する）。 */
function fakeGl(overrides: Record<string, unknown> = {}) {
  const calls: { name: string; args: unknown[] }[] = [];
  let id = 0;
  const gl = new Proxy(overrides, {
    get(target, key: string) {
      if (key in target) return target[key];
      if (/^[A-Z][A-Z0-9_]+$/.test(key)) return key.length; // GL 定数（値は何でもよい）
      if (key === "getShaderParameter" || key === "getProgramParameter") return () => true;
      if (key.startsWith("create") || key === "getUniformLocation") return () => ({ id: ++id, key });
      return (...args: unknown[]) => {
        calls.push({ name: key, args });
      };
    },
  }) as unknown as WebGLRenderingContext;
  return { gl, calls, count: (name: string) => calls.filter((c) => c.name === name).length };
}

function fakeCanvas(gl: WebGLRenderingContext | null) {
  const listeners = new Map<string, (e: unknown) => void>();
  const canvas = {
    width: 0,
    height: 0,
    getContext: (kind: string) => (kind === "webgl2" || kind === "webgl" ? gl : null),
    addEventListener: (type: string, fn: (e: unknown) => void) => void listeners.set(type, fn),
  } as unknown as HTMLCanvasElement;
  return { canvas, listeners };
}

const text: TextSurface = { measure: (_f, t) => [...t].length * 8, rasterize: () => ({ width: 1, height: 1 }) as unknown as TexImageSource };
const img = (width: number, height: number): ImageHandle => ({ width, height }) as unknown as ImageHandle;
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function assetsOf(images: Record<string, ImageHandle>): AssetSource {
  return {
    loadImage: (id) => (images[id] === undefined ? Promise.reject(new Error("missing")) : Promise.resolve(images[id]!)),
    loadAudio: () => Promise.reject(new Error("n/a")),
    loadJson: () => Promise.reject(new Error("n/a")),
    has: (id) => Promise.resolve(id in images),
  };
}

rendererContract("webgl (fake context)", () => createWebglRenderer(fakeCanvas(fakeGl().gl).canvas, { text }));

const frame = (over: Partial<FrameSpec> = {}): FrameSpec => ({
  size: { width: 64, height: 48 },
  camera: { x: 0, y: 0 },
  layers: [],
  overlay: { fade: 0, tint: { r: 0, g: 0, b: 0, a: 0 }, shake: { dx: 0, dy: 0 } },
  ui: [],
  ...over,
});

describe("createWebglRenderer", () => {
  it("init：canvas を size × dpr にし、WebGL2 を優先して取得する。取得できなければ reject", async () => {
    const { gl } = fakeGl();
    const asked: string[] = [];
    const canvas = { width: 0, height: 0, addEventListener() {}, getContext: (k: string) => (asked.push(k), k === "webgl" ? gl : null) } as unknown as HTMLCanvasElement;
    const r = createWebglRenderer(canvas, { dpr: 2, text });
    await r.init({ width: 160, height: 120, assets: assetsOf({}) });
    expect(asked).toEqual(["webgl2", "webgl"]);
    expect([canvas.width, canvas.height]).toEqual([320, 240]);
    r.resize(10, 5);
    expect([canvas.width, canvas.height]).toEqual([20, 10]);
    await expect(createWebglRenderer(fakeCanvas(null).canvas, { text }).init({ width: 1, height: 1, assets: assetsOf({}) })).rejects.toThrow(/WebGL/);
  });

  it("init：シェーダのコンパイルやリンクに失敗したら reject（原因つき）", async () => {
    const bad = fakeGl({ getShaderParameter: () => false, getShaderInfoLog: () => "構文エラー" });
    await expect(createWebglRenderer(fakeCanvas(bad.gl).canvas, { text }).init({ width: 1, height: 1, assets: assetsOf({}) })).rejects.toThrow(/構文エラー/);
    const noLink = fakeGl({ getProgramParameter: () => false, getProgramInfoLog: () => "リンクできない" });
    await expect(createWebglRenderer(fakeCanvas(noLink.gl).canvas, { text }).init({ width: 1, height: 1, assets: assetsOf({}) })).rejects.toThrow(/リンク/);
  });

  it("render：まず全体を黒で消し、同じテクスチャの矩形は 1 回の drawArrays にまとめる", async () => {
    const g = fakeGl();
    const r = createWebglRenderer(fakeCanvas(g.gl).canvas, { text });
    await r.init({ width: 64, height: 48, assets: assetsOf({}) });
    r.render(
      frame({
        overlay: { fade: 0.5, tint: { r: 0, g: 0, b: 255, a: 0.5 }, shake: { dx: 0, dy: 0 } },
        ui: [{ kind: "gauge", x: 0, y: 0, w: 10, h: 2, ratio: 0.5, color: { r: 255, g: 255, b: 255, a: 1 } }],
      }),
    );
    expect(g.calls.find((c) => c.name === "clear")).toBeDefined();
    expect(g.count("drawArrays")).toBe(1); // 単色の矩形 4 枚（色調・暗転・ゲージ背景・ゲージ）が 1 回の描画
    const draw = g.calls.find((c) => c.name === "drawArrays")!;
    expect(draw.args[2]).toBe(4 * 6);
    const uploaded = g.calls.find((c) => c.name === "bufferData")!.args[1] as Float32Array;
    expect(uploaded).toHaveLength(4 * 6 * 8);
    // 最初の矩形は色調：頂点色（各頂点の 5〜8 番目）が (0,0,1,0.5)
    expect(Array.from(uploaded.slice(4, 8))).toEqual([0, 0, 1, 0.5]);
  });

  it("render：テクスチャが変わるたびに描画を分け、ロード済みの画像のテクスチャは 1 度だけ作る", async () => {
    const g = fakeGl();
    const r = createWebglRenderer(fakeCanvas(g.gl).canvas, { text });
    const tileset = "aaaaaaaaaaaaaaaa";
    await r.init({ width: 64, height: 48, assets: assetsOf({ [tileset]: img(64, 32) }) });
    const f = frame({
      layers: [{ kind: "tiles", tileset: tileset as never, tileSize: 16, width: 2, height: 1, tiles: [1, 2], z: 0 }],
      ui: [{ kind: "gauge", x: 0, y: 0, w: 10, h: 2, ratio: 1, color: { r: 1, g: 1, b: 1, a: 1 } }],
    });
    r.render(f); // 未ロード：タイルは描かず、ロードを始める
    expect(g.count("drawArrays")).toBe(1); // ゲージ（単色）だけ
    await flush();
    r.render(f);
    r.render(f);
    // ロード後の 1 フレームは、タイル（画像）→ ゲージ（単色）の 2 回。2 フレーム目以降もテクスチャは作り直さない
    expect(g.count("drawArrays")).toBe(1 + 2 + 2);
    const textureCreates = g.count("createTexture");
    r.render(f);
    expect(g.count("createTexture")).toBe(textureCreates);
  });

  it("文字：テクスチャは（フォント, 文字列）ごとに 1 つ作って使い回す。色が違っても同じテクスチャ", async () => {
    const g = fakeGl();
    let rasterized = 0;
    const r = createWebglRenderer(fakeCanvas(g.gl).canvas, { text: { ...text, rasterize: () => (rasterized++, { width: 1, height: 1 } as unknown as TexImageSource) } });
    await r.init({ width: 64, height: 48, assets: assetsOf({}) });
    const font = { family: "sans-serif", size: 12 };
    const t = (color: { r: number; g: number; b: number; a: number }) => frame({ ui: [{ kind: "text", x: 0, y: 0, text: "こんにちは", font, color }] });
    r.render(t({ r: 255, g: 255, b: 255, a: 1 }));
    r.render(t({ r: 255, g: 0, b: 0, a: 1 }));
    r.render(frame({ ui: [{ kind: "text", x: 0, y: 0, text: "別の文字", font, color: { r: 0, g: 0, b: 0, a: 1 } }] }));
    expect(rasterized).toBe(2);
  });

  it("[inv-1] 文字のビットマップを作れない（DOM が無い等）ときも、render は例外を出さず、そのフレームを諦める", async () => {
    const g = fakeGl();
    const r = createWebglRenderer(fakeCanvas(g.gl).canvas, {
      text: {
        ...text,
        rasterize: () => {
          throw new Error("canvas が無い");
        },
      },
    });
    await r.init({ width: 64, height: 48, assets: assetsOf({}) });
    expect(() => r.render(frame({ ui: [{ kind: "text", x: 0, y: 0, text: "x", font: { family: "a", size: 8 }, color: { r: 0, g: 0, b: 0, a: 1 } }] }))).not.toThrow();
  });

  it("コンテキストが失われている間は描かず、復帰したら（テクスチャを作り直して）また描く", async () => {
    const g = fakeGl();
    const { canvas, listeners } = fakeCanvas(g.gl);
    const r = createWebglRenderer(canvas, { text });
    await r.init({ width: 64, height: 48, assets: assetsOf({}) });
    let prevented = false;
    listeners.get("webglcontextlost")!({ preventDefault: () => (prevented = true) });
    expect(prevented).toBe(true);
    const before = g.count("clear");
    r.render(frame());
    expect(g.count("clear")).toBe(before);
    listeners.get("webglcontextrestored")!({});
    r.render(frame());
    expect(g.count("clear")).toBe(before + 1);
  });

  it("dispose：確保したものを解放し、以後の render / resize は何もしない", async () => {
    const g = fakeGl();
    const { canvas } = fakeCanvas(g.gl);
    const r = createWebglRenderer(canvas, { text });
    await r.init({ width: 64, height: 48, assets: assetsOf({}) });
    r.render(frame({ ui: [{ kind: "text", x: 0, y: 0, text: "x", font: { family: "a", size: 8 }, color: { r: 0, g: 0, b: 0, a: 1 } }] }));
    r.dispose();
    expect(g.count("deleteTexture")).toBeGreaterThanOrEqual(2); // 白 + 文字
    expect(g.count("deleteProgram")).toBe(1);
    expect(g.count("deleteBuffer")).toBe(1);
    const clears = g.count("clear");
    r.render(frame());
    r.resize(1, 1);
    expect(g.count("clear")).toBe(clears);
    expect(canvas.width).toBe(64);
    await expect(r.init({ width: 1, height: 1, assets: assetsOf({}) })).resolves.toBeUndefined();
  });

  it("矩形が多くてバッファに入りきらなくても、分けて描く", async () => {
    const g = fakeGl();
    const r = createWebglRenderer(fakeCanvas(g.gl).canvas, { text });
    await r.init({ width: 64, height: 48, assets: assetsOf({}) });
    const many = Array.from({ length: 5000 }, (_, i) => ({ kind: "gauge" as const, x: i % 60, y: 0, w: 2, h: 2, ratio: 1, color: { r: 1, g: 1, b: 1, a: 1 } }));
    r.render(frame({ ui: many }));
    expect(g.count("drawArrays")).toBe(Math.ceil((5000 * 2) / 2048)); // ゲージ 1 個 = 矩形 2 枚
  });

  it("sampleFrame（全種類のノード）を、実際のバッファ操作つきで描ける", async () => {
    const g = fakeGl();
    const r = createWebglRenderer(fakeCanvas(g.gl).canvas, { text });
    await r.init({ width: 64, height: 48, assets: assetsOf({}) });
    expect(() => r.render(sampleFrame())).not.toThrow();
    expect(g.count("drawArrays")).toBeGreaterThan(0);
  });
});

describe("isWebglAvailable", () => {
  it("DOM が無い環境（Node）では false", () => {
    expect(isWebglAvailable()).toBe(false);
  });
});
