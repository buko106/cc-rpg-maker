import { describe, expect, it } from "vitest";
import type { AssetSource, FrameSpec, ImageHandle } from "@rpg/runtime";
import { rendererContract, sampleFrame } from "@rpg/test-utils";
import { createCanvas2dRenderer } from "./index.js";

/** 呼び出しを記録するだけの CanvasRenderingContext2D。 */
function mockContext() {
  const calls: string[] = [];
  const fmt = (v: unknown): string => (typeof v === "number" ? String(Math.round(v * 100) / 100) : typeof v === "object" ? "img" : String(v));
  const record =
    (name: string) =>
    (...args: unknown[]): void => {
      calls.push(`${name}(${args.map(fmt).join(",")})`);
    };
  const props: Record<string, unknown> = {};
  const ctx = new Proxy(props, {
    get(target, key: string) {
      if (key === "measureText") return (t: string) => ({ width: [...t].length * 10 });
      if (key in target) return target[key];
      return record(key);
    },
    set(target, key: string, value) {
      target[key] = value;
      if (key === "fillStyle" || key === "font" || key === "globalAlpha") calls.push(`${key}=${String(value)}`);
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, calls, props };
}

function mockCanvas(ctx: CanvasRenderingContext2D | null = mockContext().ctx) {
  return { width: 0, height: 0, getContext: () => ctx } as unknown as HTMLCanvasElement;
}

const img = (width: number, height: number): ImageHandle => ({ width, height }) as unknown as ImageHandle;

/** 画像を読み込むたびに解決する AssetSource。`loads` にロード要求の ID を積む。 */
function assetsOf(images: Record<string, ImageHandle>) {
  const loads: string[] = [];
  const source: AssetSource = {
    loadImage: (id) => {
      loads.push(id);
      const h = images[id];
      return h === undefined ? Promise.reject(new Error("missing")) : Promise.resolve(h);
    },
    loadAudio: () => Promise.reject(new Error("n/a")),
    loadJson: () => Promise.reject(new Error("n/a")),
    has: (id) => Promise.resolve(id in images),
  };
  return { source, loads };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

rendererContract("canvas2d (mock context)", () => createCanvas2dRenderer(mockCanvas()));

const frame = (over: Partial<FrameSpec> = {}): FrameSpec => ({
  size: { width: 64, height: 48 },
  camera: { x: 0, y: 0 },
  layers: [],
  overlay: { fade: 0, tint: { r: 0, g: 0, b: 0, a: 0 }, shake: { dx: 0, dy: 0 } },
  ui: [],
  ...over,
});

describe("createCanvas2dRenderer", () => {
  it("init で canvas のサイズを決める（dpr 倍）。コンテキストが取れなければ reject", async () => {
    const canvas = mockCanvas();
    const r = createCanvas2dRenderer(canvas, { dpr: 2 });
    await r.init({ width: 64, height: 48, assets: assetsOf({}).source });
    expect([canvas.width, canvas.height]).toEqual([128, 96]);
    r.resize(10, 10);
    expect([canvas.width, canvas.height]).toEqual([20, 20]);

    const noCtx = createCanvas2dRenderer(mockCanvas(null));
    await expect(noCtx.init({ width: 1, height: 1, assets: assetsOf({}).source })).rejects.toThrow(/2d/);
  });

  it("未ロードの画像はそのフレームでは描かず、ロード後の次のフレームから描く", async () => {
    const { ctx, calls } = mockContext();
    const { source, loads } = assetsOf({ aaaaaaaaaaaaaaaa: img(64, 64) });
    const r = createCanvas2dRenderer(mockCanvas(ctx));
    await r.init({ width: 64, height: 48, assets: source });
    const f = frame({ layers: [{ kind: "tiles", tileset: "aaaaaaaaaaaaaaaa" as never, tileSize: 16, width: 2, height: 1, tiles: [1, 2], z: 0 }] });

    r.render(f);
    expect(calls.filter((c) => c.startsWith("drawImage"))).toEqual([]);
    r.render(f); // ロード中は二重にロードを始めない
    expect(loads).toEqual(["aaaaaaaaaaaaaaaa"]);
    await flush();
    calls.length = 0;
    r.render(f);
    // 64px 幅・16px タイル → 4 列。タイル 1 = (16,0)、タイル 2 = (32,0)
    expect(calls.filter((c) => c.startsWith("drawImage"))).toEqual(["drawImage(img,16,0,16,16,0,0,16,16)", "drawImage(img,32,0,16,16,16,0,16,16)"]);
  });

  it("ロードに失敗した画像は諦めて描かず、再試行もしない", async () => {
    const { ctx, calls } = mockContext();
    const { source, loads } = assetsOf({});
    const r = createCanvas2dRenderer(mockCanvas(ctx));
    await r.init({ width: 64, height: 48, assets: source });
    const f = frame({ layers: [{ kind: "sprites", sprites: [{ asset: "bbbbbbbbbbbbbbbb" as never, sx: 0, sy: 0, sw: 8, sh: 8, x: 0, y: 0 }], z: 0 }] });
    r.render(f);
    await flush();
    r.render(f);
    r.render(f);
    expect(loads).toEqual(["bbbbbbbbbbbbbbbb"]);
    expect(calls.filter((c) => c.startsWith("drawImage"))).toEqual([]);
  });

  it("タイルは見えている範囲だけ描き、空（0）と画像の範囲外は飛ばす", async () => {
    const { ctx, calls } = mockContext();
    const { source } = assetsOf({ aaaaaaaaaaaaaaaa: img(32, 32) }); // 2x2 セル
    const r = createCanvas2dRenderer(mockCanvas(ctx));
    await r.init({ width: 32, height: 16, assets: source });
    // 8x1 タイルのマップ。画面は 2 タイル分、カメラは x=32（タイル 2〜3 が見える）
    const f = frame({
      size: { width: 32, height: 16 },
      camera: { x: 32, y: 0 },
      layers: [{ kind: "tiles", tileset: "aaaaaaaaaaaaaaaa" as never, tileSize: 16, width: 8, height: 1, tiles: [1, 1, 1, 0, 1, 1, 1, 9], z: 0 }],
    });
    r.render(f);
    await flush();
    calls.length = 0;
    r.render(f);
    // タイル 2 → (16,0)→画面 x=0。タイル 3 は空。タイル 4 は画面外（範囲は 2〜3 のみ）
    expect(calls.filter((c) => c.startsWith("drawImage"))).toEqual(["drawImage(img,16,0,16,16,0,0,16,16)"]);
  });

  it("スプライトはカメラとシェイクぶんずらして描く。flipX は反転", async () => {
    const { ctx, calls } = mockContext();
    const { source } = assetsOf({ bbbbbbbbbbbbbbbb: img(32, 32) });
    const r = createCanvas2dRenderer(mockCanvas(ctx));
    await r.init({ width: 64, height: 48, assets: source });
    const sprite = { asset: "bbbbbbbbbbbbbbbb" as never, sx: 0, sy: 0, sw: 16, sh: 16, x: 20, y: 30 };
    const f = frame({
      camera: { x: 10, y: 5 },
      overlay: { fade: 0, tint: { r: 0, g: 0, b: 0, a: 0 }, shake: { dx: 3, dy: 0 } },
      layers: [{ kind: "sprites", sprites: [sprite, { ...sprite, flipX: true, alpha: 0.5 }], z: 0 }],
    });
    r.render(f);
    await flush();
    calls.length = 0;
    r.render(f);
    const draws = calls.filter((c) => c.startsWith("drawImage") || c.startsWith("translate") || c.startsWith("scale") || c.startsWith("globalAlpha"));
    expect(draws).toEqual([
      "globalAlpha=1", // 毎フレームの初期化
      "drawImage(img,0,0,16,16,13,25,16,16)",
      "globalAlpha=0.5",
      "translate(29,25)",
      "scale(-1,1)",
      "drawImage(img,0,0,16,16,0,0,16,16)",
      "globalAlpha=1",
    ]);
  });

  it("overlay は tint → flash → fade の順に重ねる", async () => {
    const { ctx, calls } = mockContext();
    const r = createCanvas2dRenderer(mockCanvas(ctx));
    await r.init({ width: 64, height: 48, assets: assetsOf({}).source });
    calls.length = 0;
    r.render(
      frame({ overlay: { fade: 0.5, tint: { r: 1, g: 2, b: 3, a: 0.4 }, flash: { color: { r: 255, g: 255, b: 255, a: 1 }, alpha: 0.5 }, shake: { dx: 0, dy: 0 } } }),
    );
    expect(calls.filter((c) => c.startsWith("fillStyle="))).toEqual(["fillStyle=#000", "fillStyle=rgba(1,2,3,0.4)", "fillStyle=rgba(255,255,255,0.5)", "fillStyle=rgba(0,0,0,0.5)"]);
  });

  it("暗転の色（fadeColor）が白なら、白で覆う", async () => {
    const { ctx, calls } = mockContext();
    const r = createCanvas2dRenderer(mockCanvas(ctx));
    await r.init({ width: 64, height: 48, assets: assetsOf({}).source });
    calls.length = 0;
    r.render(frame({ overlay: { fade: 0.5, fadeColor: { r: 255, g: 255, b: 255, a: 1 }, tint: { r: 0, g: 0, b: 0, a: 0 }, shake: { dx: 0, dy: 0 } } }));
    expect(calls.filter((c) => c.startsWith("fillStyle="))).toEqual(["fillStyle=#000", "fillStyle=rgba(255,255,255,0.5)"]);
  });

  it("テキストは maxWidth で折り返し、runs は色ごとに続けて描く", async () => {
    const { ctx, calls } = mockContext();
    const r = createCanvas2dRenderer(mockCanvas(ctx));
    await r.init({ width: 64, height: 48, assets: assetsOf({}).source });
    calls.length = 0;
    const white = { r: 255, g: 255, b: 255, a: 1 };
    const red = { r: 255, g: 0, b: 0, a: 1 };
    r.render(
      frame({
        ui: [
          { kind: "text", x: 2, y: 4, text: "あいうえお", font: { family: "sans-serif", size: 10, bold: true }, color: white, maxWidth: 25 },
          { kind: "text", x: 2, y: 30, text: "ab", font: { family: "sans-serif", size: 10 }, color: white, runs: [{ text: "a", color: white }, { text: "b", color: red }] },
        ],
      }),
    );
    // 1 文字 10px（mock）。maxWidth 25 → 2 文字ずつ。行間は size * 1.25
    expect(calls.filter((c) => c.startsWith("fillText"))).toEqual([
      "fillText(あい,2,4)",
      "fillText(うえ,2,16.5)",
      "fillText(お,2,29)",
      "fillText(a,2,30)",
      "fillText(b,12,30)",
    ]);
    expect(calls).toContain("font=bold 10px sans-serif");
  });

  it("ウィンドウ・ゲージ・カーソル・画像 UI を描く", async () => {
    const { ctx, calls } = mockContext();
    const { source } = assetsOf({ cccccccccccccccc: img(16, 16) });
    const r = createCanvas2dRenderer(mockCanvas(ctx));
    await r.init({ width: 64, height: 48, assets: source });
    const ui = frame({ ui: [{ kind: "window", x: 1, y: 2, w: 30, h: 20, variant: "dim", children: [{ kind: "image", x: 5, y: 6, asset: "cccccccccccccccc" as never }] }, { kind: "gauge", x: 0, y: 40, w: 20, h: 4, ratio: 2, color: { r: 0, g: 255, b: 0, a: 1 } }, { kind: "cursor", x: 3, y: 3, w: 8, h: 8, blink: false }] });
    r.render(ui);
    await flush();
    calls.length = 0;
    r.render(ui);
    expect(calls).toContain("fillRect(1,2,30,20)");
    expect(calls).toContain("drawImage(img,0,0,16,16,5,6,16,16)");
    expect(calls).toContain("fillRect(0,40,20,4)"); // ratio は 1 に丸められる
    expect(calls).toContain("fillRect(3,3,8,8)"); // カーソルは半透明の塗り + 枠
    expect(calls).toContain("strokeRect(3,3,8,8)");
  });

  it("[inv-3] dispose 後の render は何も描かない", async () => {
    const { ctx, calls } = mockContext();
    const r = createCanvas2dRenderer(mockCanvas(ctx));
    await r.init({ width: 64, height: 48, assets: assetsOf({}).source });
    r.dispose();
    calls.length = 0;
    r.render(sampleFrame());
    expect(calls).toEqual([]);
  });

  it("[inv-1] 描画中に例外が起きても render は投げない", async () => {
    const { ctx } = mockContext();
    (ctx as unknown as { fillRect: () => never }).fillRect = () => {
      throw new Error("boom");
    };
    const r = createCanvas2dRenderer(mockCanvas(ctx));
    await r.init({ width: 64, height: 48, assets: assetsOf({}).source });
    expect(() => r.render(frame())).not.toThrow();
  });
});
