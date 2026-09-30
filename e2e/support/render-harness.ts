/**
 * ブラウザ内で動くピクセル比較のハーネス（e2e/render.spec.ts が esbuild でバンドルしてページに流し込む）。
 * 同じ FrameSpec を Canvas2D レンダラと WebGL レンダラで描き、ピクセルの差を数える（docs/07-render.md 不変条件 4）。
 */
import { createCanvas2dRenderer } from "../../packages/render-canvas2d/src/index";
import { createWebglRenderer } from "../../packages/render-webgl/src/index";
import type { AssetSource, FrameSpec, ImageHandle, Renderer } from "../../packages/runtime/src/index";

const W = 320;
const H = 256;
const white = { r: 255, g: 255, b: 255, a: 1 };

/** 8 種類のタイル（16×16、4 列 × 2 行）。向きが分かるよう、色・対角線・数字を描く。 */
function tilesetCanvas(): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 32;
  const g = c.getContext("2d")!;
  for (let i = 0; i < 8; i++) {
    const x = (i % 4) * 16;
    const y = Math.floor(i / 4) * 16;
    g.fillStyle = `hsl(${i * 45}, 60%, ${35 + i * 4}%)`;
    g.fillRect(x, y, 16, 16);
    g.strokeStyle = "rgba(255,255,255,0.8)";
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + 16, y + 16);
    g.stroke();
    g.fillStyle = "#fff";
    g.font = "10px sans-serif";
    g.fillText(String(i), x + 9, y + 12);
  }
  return c;
}

/** 3 × 4 体のキャラクター（32×32）。左右で非対称にして反転を検出でき、縁に半透明のピクセルを持つ。 */
function spriteCanvas(): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = 96;
  c.height = 128;
  const g = c.getContext("2d")!;
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 3; col++) {
      const x = col * 32;
      const y = row * 32;
      g.fillStyle = `hsl(${row * 90 + col * 20}, 70%, 55%)`;
      g.fillRect(x + 6, y + 4, 20, 24);
      g.fillStyle = "#000";
      g.fillRect(x + 8, y + 8, 4, 4); // 左目だけ
      g.fillStyle = "rgba(255,255,255,0.5)";
      g.fillRect(x + 14, y + 6, 10, 3); // 半透明
      g.fillStyle = "rgba(255,0,0,0.35)";
      g.beginPath();
      g.arc(x + 22, y + 20, 5, 0, Math.PI * 2);
      g.fill();
    }
  }
  return c;
}

const ASSETS: Record<string, HTMLCanvasElement> = {
  aaaaaaaaaaaaaaaa: tilesetCanvas(),
  bbbbbbbbbbbbbbbb: spriteCanvas(),
};

async function assetSource(): Promise<AssetSource> {
  const bitmaps = new Map<string, ImageBitmap>();
  for (const [id, canvas] of Object.entries(ASSETS)) bitmaps.set(id, await createImageBitmap(canvas));
  return {
    loadImage: (id) => (bitmaps.has(id) ? Promise.resolve(bitmaps.get(id) as unknown as ImageHandle) : Promise.reject(new Error(`missing ${id}`))),
    loadAudio: () => Promise.reject(new Error("n/a")),
    loadJson: () => Promise.reject(new Error("n/a")),
    has: (id) => Promise.resolve(bitmaps.has(id)),
  };
}

const grid = (w: number, h: number, f: (x: number, y: number) => number): number[] => Array.from({ length: w * h }, (_, i) => f(i % w, Math.floor(i / w)));

const baseLayers: FrameSpec["layers"] = [
  { kind: "tiles", tileset: "aaaaaaaaaaaaaaaa" as never, tileSize: 16, width: 30, height: 24, tiles: grid(30, 24, (x, y) => ((x + y * 3) % 8 === 0 ? 0 : 1 + ((x * 5 + y * 7) % 7))), z: 0 },
  { kind: "tiles", tileset: "aaaaaaaaaaaaaaaa" as never, tileSize: 16, width: 30, height: 24, tiles: grid(30, 24, (x, y) => ((x * y) % 5 === 0 ? 3 : 0)), z: 1 },
  {
    kind: "sprites",
    z: 2,
    sprites: [
      { asset: "bbbbbbbbbbbbbbbb" as never, sx: 0, sy: 0, sw: 32, sh: 32, x: 40, y: 40 },
      { asset: "bbbbbbbbbbbbbbbb" as never, sx: 32, sy: 64, sw: 32, sh: 32, x: 100, y: 60, flipX: true },
      { asset: "bbbbbbbbbbbbbbbb" as never, sx: 64, sy: 96, sw: 32, sh: 32, x: 160, y: 90, alpha: 0.5 },
    ],
  },
];

const noOverlay: FrameSpec["overlay"] = { fade: 0, tint: { r: 0, g: 0, b: 0, a: 0 }, shake: { dx: 0, dy: 0 } };

const messageWindow: FrameSpec["ui"] = [
  {
    kind: "window",
    x: 4,
    y: 170,
    w: W - 8,
    h: 82,
    variant: "normal",
    children: [
      { kind: "text", x: 14, y: 180, text: "こんにちは！これは WebGL と Canvas2D の見た目を比べるためのメッセージです。", font: { family: "sans-serif", size: 16 }, color: white, maxWidth: 290 },
      { kind: "text", x: 14, y: 226, text: "赤と青の文字", font: { family: "sans-serif", size: 16 }, color: white, runs: [{ text: "赤い", color: { r: 255, g: 120, b: 76, a: 1 } }, { text: "と青い", color: { r: 32, g: 160, b: 214, a: 1 } }] },
    ],
  },
];

const menuUi: FrameSpec["ui"] = [
  { kind: "window", x: 0, y: 0, w: W, h: H, variant: "dim", children: [] },
  {
    kind: "window",
    x: 8,
    y: 8,
    w: 120,
    h: 110,
    children: [
      { kind: "text", x: 20, y: 18, text: "アイテム", font: { family: "sans-serif", size: 16 }, color: white },
      { kind: "text", x: 20, y: 42, text: "ステータス", font: { family: "sans-serif", size: 16, bold: true }, color: { r: 255, g: 255, b: 160, a: 1 } },
      { kind: "text", x: 68, y: 66, text: "中央", font: { family: "sans-serif", size: 14 }, color: white, align: "center" },
      { kind: "text", x: 116, y: 88, text: "右寄せ", font: { family: "sans-serif", size: 14 }, color: white, align: "right" },
      { kind: "cursor", x: 12, y: 16, w: 112, h: 24, blink: false },
    ],
  },
  {
    kind: "window",
    x: 140,
    y: 8,
    w: 170,
    h: 90,
    children: [
      { kind: "text", x: 150, y: 14, text: "勇者  Lv3", font: { family: "sans-serif", size: 16 }, color: white },
      { kind: "text", x: 150, y: 36, text: "HP 80/100", font: { family: "sans-serif", size: 12 }, color: white },
      { kind: "gauge", x: 150, y: 52, w: 150, h: 6, ratio: 0.8, color: { r: 102, g: 204, b: 64, a: 1 } },
      { kind: "gauge", x: 150, y: 66, w: 150, h: 6, ratio: 0.3, color: { r: 32, g: 160, b: 214, a: 1 } },
      { kind: "image", x: 270, y: 20, asset: "bbbbbbbbbbbbbbbb" as never, sx: 0, sy: 0, sw: 32, sh: 32 },
    ],
  },
];

export const SCENARIOS: Record<string, FrameSpec> = {
  map: { size: { width: W, height: H }, camera: { x: 37, y: 21 }, layers: baseLayers, overlay: noOverlay, ui: [] },
  shake: { size: { width: W, height: H }, camera: { x: 16, y: 16 }, layers: baseLayers, overlay: { ...noOverlay, shake: { dx: 3, dy: -2 } }, ui: [] },
  overlay: {
    size: { width: W, height: H },
    camera: { x: 0, y: 0 },
    layers: baseLayers,
    overlay: { fade: 0.3, tint: { r: 0, g: 40, b: 120, a: 0.35 }, flash: { color: { r: 255, g: 255, b: 200, a: 1 }, alpha: 0.4 }, shake: { dx: 0, dy: 0 } },
    ui: [],
  },
  message: { size: { width: W, height: H }, camera: { x: 64, y: 32 }, layers: baseLayers, overlay: noOverlay, ui: messageWindow },
  menu: { size: { width: W, height: H }, camera: { x: 0, y: 0 }, layers: baseLayers, overlay: noOverlay, ui: menuUi },
  title: {
    size: { width: W, height: H },
    camera: { x: 0, y: 0 },
    layers: [],
    overlay: noOverlay,
    ui: [
      { kind: "text", x: W / 2, y: 60, text: "わたしのゲーム", font: { family: "sans-serif", size: 28, bold: true }, color: white, align: "center" },
      { kind: "window", x: 110, y: 150, w: 100, h: 60, children: [{ kind: "text", x: 128, y: 162, text: "ニューゲーム", font: { family: "sans-serif", size: 14 }, color: white }, { kind: "cursor", x: 114, y: 160, w: 92, h: 22, blink: true }] },
    ],
  },
  everything: { size: { width: W, height: H }, camera: { x: 21, y: 9 }, layers: baseLayers, overlay: { fade: 0.15, tint: { r: 60, g: 0, b: 0, a: 0.2 }, shake: { dx: 1, dy: 2 } }, ui: [...messageWindow, ...menuUi.slice(1, 2)] },
};

export interface CompareResult {
  total: number;
  /** どれかのチャンネルが `threshold` より大きく違うピクセルの数 */
  differing: number;
  ratio: number;
  maxDiff: number;
  /** 描画結果（デバッグ用）：Canvas2D / WebGL / 差 */
  images: { canvas2d: string; webgl: string; diff: string };
}

async function render(kind: "canvas2d" | "webgl", frame: FrameSpec, dpr: number, pixelated: boolean): Promise<HTMLCanvasElement> {
  const canvas = document.createElement("canvas");
  document.body.append(canvas);
  const assets = await assetSource();
  const renderer: Renderer = kind === "canvas2d" ? createCanvas2dRenderer(canvas, { pixelated, dpr }) : createWebglRenderer(canvas, { pixelated, dpr, preserveDrawingBuffer: true });
  await renderer.init({ width: frame.size.width, height: frame.size.height, assets });
  renderer.render(frame); // 画像は未ロードなので、ここではロードを始めるだけ
  await new Promise((r) => setTimeout(r, 20));
  renderer.render(frame);
  return canvas;
}

function pixels(canvas: HTMLCanvasElement): ImageData {
  const scratch = document.createElement("canvas");
  scratch.width = canvas.width;
  scratch.height = canvas.height;
  const g = scratch.getContext("2d")!;
  g.drawImage(canvas, 0, 0);
  return g.getImageData(0, 0, canvas.width, canvas.height);
}

/** 1 つのシーンを両方のレンダラで描いて比べる。 */
export async function compare(name: string, opts: { dpr?: number; pixelated?: boolean; threshold?: number } = {}): Promise<CompareResult> {
  const frame = SCENARIOS[name];
  if (frame === undefined) throw new Error(`unknown scenario ${name}`);
  const dpr = opts.dpr ?? 1;
  const threshold = opts.threshold ?? 8;
  const a = await render("canvas2d", frame, dpr, opts.pixelated ?? true);
  const b = await render("webgl", frame, dpr, opts.pixelated ?? true);
  const pa = pixels(a);
  const pb = pixels(b);
  if (pa.width !== pb.width || pa.height !== pb.height) throw new Error("サイズが違う");
  const diff = new ImageData(pa.width, pa.height);
  let differing = 0;
  let maxDiff = 0;
  for (let i = 0; i < pa.data.length; i += 4) {
    const d = Math.max(Math.abs(pa.data[i]! - pb.data[i]!), Math.abs(pa.data[i + 1]! - pb.data[i + 1]!), Math.abs(pa.data[i + 2]! - pb.data[i + 2]!));
    maxDiff = Math.max(maxDiff, d);
    if (d > threshold) differing++;
    diff.data[i] = Math.min(255, d * 8);
    diff.data[i + 1] = 0;
    diff.data[i + 2] = 0;
    diff.data[i + 3] = 255;
  }
  const diffCanvas = document.createElement("canvas");
  diffCanvas.width = pa.width;
  diffCanvas.height = pa.height;
  diffCanvas.getContext("2d")!.putImageData(diff, 0, 0);
  const total = pa.width * pa.height;
  return { total, differing, ratio: differing / total, maxDiff, images: { canvas2d: a.toDataURL(), webgl: b.toDataURL(), diff: diffCanvas.toDataURL() } };
}

/** 描画されたものが真っ黒ではないこと（両方が空で「一致」してしまうのを防ぐ）。 */
export async function litRatio(name: string, kind: "canvas2d" | "webgl"): Promise<number> {
  const canvas = await render(kind, SCENARIOS[name]!, 1, true);
  const p = pixels(canvas);
  let lit = 0;
  for (let i = 0; i < p.data.length; i += 4) if (p.data[i]! + p.data[i + 1]! + p.data[i + 2]! > 40) lit++;
  return lit / (p.width * p.height);
}

(window as unknown as { __harness: unknown }).__harness = { compare, litRatio, scenarios: Object.keys(SCENARIOS) };
