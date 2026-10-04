/**
 * @rpg/render-ascii — ASCII アート Renderer アダプタ（実験用）。`FrameSpec` を等幅文字のマス目で描く。
 *
 * 画像はマスごとの平均色と明るさ（`.:-=+*#%@`）に、UI の文字はそのまま文字にする。マス目への落とし込みは `raster.ts`（DOM 非依存）。
 */
import type { AssetId, AssetSource, FrameSpec, ImageHandle, Renderer } from "@rpg/runtime";
import { createSampler, gridToText, isWide, rasterize } from "./raster.js";
import type { Grid, ImageSampler, RGB } from "./raster.js";

export { createSampler, gridToText, isWide, rasterize } from "./raster.js";
export type { Cell, Grid, ImageSampler, RasterOptions, RGB } from "./raster.js";

export interface AsciiRendererOptions {
  /** 1 マスの大きさ（ゲームのピクセル）。既定は 8 × 16（等幅文字の縦横比に合わせる）。 */
  cellW?: number;
  cellH?: number;
  /** 読み込んだ画像を平均色が取れる形にする。既定は canvas の `getImageData`。 */
  sampleImage?: (handle: ImageHandle) => Promise<ImageSampler>;
}

/** 直近に描いた文字（色なし）を読める Renderer。 */
export interface AsciiRenderer extends Renderer {
  text(): string;
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

const css = (c: RGB): string => `rgb(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])})`;

export function createAsciiRenderer(root: HTMLElement, options: AsciiRendererOptions = {}): AsciiRenderer {
  const cellW = options.cellW ?? 8;
  const cellH = options.cellH ?? 16;
  const sampleImage = options.sampleImage ?? canvasSampler;

  let assets: AssetSource | undefined;
  let disposed = false;
  let lastKey = "";
  let lastText = "";
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

  const style = (): void => {
    // 等幅フォントの字幅はおよそ 0.6em。マスの幅に合わせる
    root.style.cssText = `background:#000;color:#ccc;overflow:hidden;white-space:pre;font:${Math.round((cellW / 0.6) * 100) / 100}px/${cellH}px ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;user-select:none`;
    root.dataset["renderer"] = "ascii";
  };

  function show(g: Grid): void {
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
        const bg = c.bg === undefined ? "" : css(c.bg);
        const wide = c.ch !== "" && isWide(c.ch);
        // 全角文字は 2 マス分の幅の箱に入れる（等幅フォントの字幅とずれないように）
        if (wide) {
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
    root.replaceChildren(...rows);
  }

  return {
    init(opts) {
      if (disposed) return Promise.resolve();
      assets = opts.assets;
      style();
      root.style.width = `${opts.width}px`;
      root.style.height = `${opts.height}px`;
      return Promise.resolve();
    },
    render(frame: FrameSpec) {
      if (disposed) return;
      try {
        const g = rasterize(frame, { cellW, cellH, sampler });
        // 前のフレームと同じなら DOM を触らない
        const key = g.cells.map((c) => `${c.ch}|${c.fg?.map(Math.round).join(",") ?? ""}|${c.bg?.map(Math.round).join(",") ?? ""}|${c.tail ? 1 : 0}`).join("\n") + `#${g.cols}`;
        if (key === lastKey) return;
        lastKey = key;
        lastText = gridToText(g);
        show(g);
      } catch {
        // 不変条件: render は例外を投げない（不正な FrameSpec はそのフレームだけ諦める）
      }
    },
    resize(w, h) {
      if (disposed) return;
      root.style.width = `${w}px`;
      root.style.height = `${h}px`;
      lastKey = "";
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      root.replaceChildren();
      images.clear();
      assets = undefined;
    },
    text: () => lastText,
  };
}
