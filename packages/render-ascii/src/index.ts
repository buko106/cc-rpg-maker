/**
 * @rpg/render-ascii — ASCII アート Renderer アダプタ（実験用）。`FrameSpec` を等幅文字のマス目で描く。
 *
 * 画像はマスごとの平均色と明るさ（`.:-=+*#%@`）に、UI の文字はそのまま文字にする。マス目への落とし込みは `raster.ts`（DOM 非依存）。
 */
import type { AssetId, AssetSource, FrameSpec, ImageHandle, Renderer } from "@rpg/runtime";
import { createSampler, gridToText, isWide, rasterize } from "./raster.js";
import type { Grid, ImageSampler, RGB } from "./raster.js";

export { createSampler, gridToText, isWide, rasterize } from "./raster.js";
export type { Cell, Grid, ImageSampler, RasterOptions, Rasterized, RGB } from "./raster.js";

export interface AsciiRendererOptions {
  /** UI の 1 マスの大きさ（ゲームのピクセル）。既定は 8 × 16（等幅文字の縦横比に合わせる）。 */
  cellW?: number;
  cellH?: number;
  /** 絵（地形・キャラ）の細かさ。UI の 1 マスを縦横 `res` 分割する。既定 3。 */
  res?: number;
  /** 読み込んだ画像を平均色が取れる形にする。既定は canvas の `getImageData`。 */
  sampleImage?: (handle: ImageHandle) => Promise<ImageSampler>;
}

/** 直近に描いた文字（色なし）を読める Renderer。 */
export interface AsciiRenderer extends Renderer {
  /** 絵の層の文字。 */
  text(): string;
  /** UI の層の文字（メニュー・メッセージなど）。 */
  uiText(): string;
}

type Cached = ImageSampler | "loading" | "failed";

async function canvasSampler(handle: ImageHandle): Promise<ImageSampler> {
  const src = handle as unknown as { width: number; height: number };
  const canvas = document.createElement("canvas");
  canvas.width = src.width;
  canvas.height = src.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (ctx === null) throw new Error("canvas 2d コンテキストを取得できない");
  ctx.drawImage(src as unknown as CanvasImageSource, 0, 0);
  return createSampler(src.width, src.height, ctx.getImageData(0, 0, src.width, src.height).data);
}

const css = (c: RGB, a = 1): string => (a >= 1 ? `rgb(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])})` : `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${Math.round(a * 100) / 100})`);

export function createAsciiRenderer(root: HTMLElement, options: AsciiRendererOptions = {}): AsciiRenderer {
  const cellW = options.cellW ?? 8;
  const cellH = options.cellH ?? 16;
  const res = Math.max(1, Math.floor(options.res ?? 3));
  const sampleImage = options.sampleImage ?? canvasSampler;

  let assets: AssetSource | undefined;
  let disposed = false;
  let width = 0;
  let height = 0;
  let worldEl: HTMLElement | undefined;
  let uiEl: HTMLElement | undefined;
  let worldKey = "";
  let uiKey = "";
  let worldText = "";
  let uiText = "";
  const images = new Map<AssetId, Cached>();

  const sampler = (id: AssetId): ImageSampler | undefined => {
    const cached = images.get(id);
    if (cached === "loading" || cached === "failed") return undefined;
    if (cached !== undefined) return cached;
    if (assets === undefined) return undefined;
    images.set(id, "loading");
    assets.loadImage(id).then(
      (h) =>
        sampleImage(h).then(
          (s) => {
            if (!disposed) images.set(id, s);
          },
          () => images.set(id, "failed"),
        ),
      () => images.set(id, "failed"),
    );
    return undefined;
  };

  // 等幅フォントの字幅はおよそ 0.6em。マスの幅に合わせる
  const font = `${Math.round((cellW / 0.6) * 100) / 100}px/${cellH}px ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace`;

  function mount(): void {
    root.replaceChildren();
    root.dataset["renderer"] = "ascii";
    root.style.cssText = `position:relative;overflow:hidden;background:#000;color:#ccc;white-space:pre;user-select:none;width:${width}px;height:${height}px`;
    // 絵の層は `res` 倍の大きさで文字を並べて、1/res に縮める（小さすぎる文字サイズをブラウザに丸められないように）
    worldEl = document.createElement("div");
    worldEl.style.cssText = `position:absolute;left:0;top:0;width:${width * res}px;height:${height * res}px;transform:scale(${1 / res});transform-origin:0 0;font:${font}`;
    uiEl = document.createElement("div");
    uiEl.style.cssText = `position:absolute;left:0;top:0;width:${width}px;height:${height}px;pointer-events:none;font:${font}`;
    root.append(worldEl, uiEl);
    worldKey = "";
    uiKey = "";
  }

  const keyOf = (g: Grid): string => g.cells.map((c) => `${c.ch}|${c.fg?.map(Math.round).join(",") ?? ""}|${c.bg?.map(Math.round).join(",") ?? ""}|${c.bgA ?? 1}|${c.tail ? 1 : 0}`).join("\n") + `#${g.cols}`;

  function show(host: HTMLElement, g: Grid): void {
    const rows: HTMLElement[] = [];
    for (let y = 0; y < g.rows; y++) {
      const row = document.createElement("div");
      row.style.height = `${cellH}px`;
      let run: { fg: string; bg: string; text: string } | undefined;
      const flush = (): void => {
        if (run === undefined) return;
        const span = document.createElement("span");
        span.textContent = run.text;
        if (run.fg !== "") span.style.color = run.fg;
        if (run.bg !== "") span.style.background = run.bg;
        row.append(span);
        run = undefined;
      };
      for (let x = 0; x < g.cols; x++) {
        const c = g.cells[y * g.cols + x]!;
        if (c.tail) continue;
        const fg = c.fg === undefined ? "" : css(c.fg);
        const bg = c.bg === undefined ? "" : css(c.bg, c.bgA ?? 1);
        // 全角文字は 2 マス分の幅の箱に入れる（等幅フォントの字幅とずれないように）
        if (c.ch !== "" && isWide(c.ch)) {
          flush();
          const span = document.createElement("span");
          span.textContent = c.ch;
          span.style.cssText = `display:inline-block;width:${cellW * 2}px;overflow:hidden;${fg === "" ? "" : `color:${fg};`}${bg === "" ? "" : `background:${bg};`}`;
          row.append(span);
          continue;
        }
        if (run === undefined || run.fg !== fg || run.bg !== bg) {
          flush();
          run = { fg, bg, text: "" };
        }
        run.text += c.ch === "" ? " " : c.ch;
      }
      flush();
      rows.push(row);
    }
    host.replaceChildren(...rows);
  }

  return {
    init(opts) {
      if (disposed) return Promise.resolve();
      assets = opts.assets;
      width = opts.width;
      height = opts.height;
      mount();
      return Promise.resolve();
    },
    render(frame: FrameSpec) {
      if (disposed || worldEl === undefined || uiEl === undefined) return;
      try {
        const { world, ui } = rasterize(frame, { cellW, cellH, res, sampler });
        // 前のフレームと同じなら DOM を触らない
        const wk = keyOf(world);
        if (wk !== worldKey) {
          worldKey = wk;
          worldText = gridToText(world);
          show(worldEl, world);
        }
        const uk = keyOf(ui);
        if (uk !== uiKey) {
          uiKey = uk;
          uiText = gridToText(ui);
          show(uiEl, ui);
        }
      } catch {
        // 不変条件: render は例外を投げない（不正な FrameSpec はそのフレームだけ諦める）
      }
    },
    resize(w, h) {
      if (disposed) return;
      width = w;
      height = h;
      mount();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      root.replaceChildren();
      images.clear();
      assets = undefined;
    },
    text: () => worldText,
    uiText: () => uiText,
  };
}
