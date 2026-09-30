/**
 * @rpg/render-canvas2d — Canvas2D Renderer アダプタ。`FrameSpec` を描く。
 *
 * 設計: docs/07-render.md
 * 未ロードの画像は、そのフレームでは描かずに非同期ロードを始め、ロードできた次のフレームから描く。
 */
import type { AssetId, AssetSource, FrameLayer, FrameSpec, ImageHandle, RGBA, Renderer, UiNode } from "@rpg/runtime";

export interface Canvas2dOptions {
  /** 拡大しても輪郭をぼかさない（`imageSmoothingEnabled = false`）。既定 true。 */
  pixelated?: boolean;
  /** 論理ピクセルあたりの実ピクセル数。既定 1（拡大は CSS で行う）。 */
  dpr?: number;
}

type Drawable = CanvasImageSource & { readonly width: number; readonly height: number };
type Cached = Drawable | "loading" | "failed";

const css = (c: RGBA): string =>
  `rgba(${Math.round(Math.min(255, Math.max(0, c.r)))},${Math.round(Math.min(255, Math.max(0, c.g)))},${Math.round(Math.min(255, Math.max(0, c.b)))},${Math.min(1, Math.max(0, c.a))})`;

const WINDOW_FILL = "rgba(16,16,64,0.88)";
const WINDOW_BORDER = "rgba(255,255,255,0.9)";
const DIM_FILL = "rgba(0,0,0,0.6)";
const CURSOR_FILL = "rgba(255,255,255,0.18)";

export function createCanvas2dRenderer(canvas: HTMLCanvasElement, options: Canvas2dOptions = {}): Renderer {
  const pixelated = options.pixelated ?? true;
  const scale = options.dpr ?? 1;

  let ctx: CanvasRenderingContext2D | null = null;
  let assets: AssetSource | undefined;
  let disposed = false;
  const images = new Map<AssetId, Cached>();

  const resizeCanvas = (w: number, h: number): void => {
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
  };

  /** ロード済みなら画像を返す。未ロードなら非同期ロードを始めて `undefined`（そのフレームは描かない）。 */
  const image = (id: AssetId): Drawable | undefined => {
    const cached = images.get(id);
    if (cached === "loading" || cached === "failed") return undefined;
    if (cached !== undefined) return cached;
    if (assets === undefined) return undefined;
    images.set(id, "loading");
    assets.loadImage(id).then(
      (h: ImageHandle) => {
        if (!disposed) images.set(id, h as unknown as Drawable);
      },
      () => images.set(id, "failed"),
    );
    return undefined;
  };

  function drawTiles(c: CanvasRenderingContext2D, layer: Extract<FrameLayer, { kind: "tiles" }>, frame: FrameSpec, ox: number, oy: number): void {
    const { tileSize: ts, width, height, tiles } = layer;
    if (layer.tileset === null || !(ts > 0) || tiles.length < width * height) return;
    const img = image(layer.tileset);
    if (img === undefined) return;
    const cols = Math.floor(img.width / ts);
    if (cols <= 0) return;
    // 見えている範囲だけ
    const left = -ox;
    const top = -oy;
    const x0 = Math.max(0, Math.floor(left / ts));
    const x1 = Math.min(width - 1, Math.floor((left + frame.size.width - 1) / ts));
    const y0 = Math.max(0, Math.floor(top / ts));
    const y1 = Math.min(height - 1, Math.floor((top + frame.size.height - 1) / ts));
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const id = tiles[ty * width + tx] ?? 0;
        if (id <= 0) continue;
        const sx = (id % cols) * ts;
        const sy = Math.floor(id / cols) * ts;
        if (sy + ts > img.height) continue;
        c.drawImage(img, sx, sy, ts, ts, tx * ts + ox, ty * ts + oy, ts, ts);
      }
    }
  }

  function drawSprites(c: CanvasRenderingContext2D, layer: Extract<FrameLayer, { kind: "sprites" }>, ox: number, oy: number): void {
    for (const s of layer.sprites) {
      const img = image(s.asset);
      if (img === undefined) continue;
      const alpha = s.alpha ?? 1;
      if (alpha !== 1) c.globalAlpha = alpha;
      if (s.flipX === true) {
        c.save();
        c.translate(s.x + ox + s.sw, s.y + oy);
        c.scale(-1, 1);
        c.drawImage(img, s.sx, s.sy, s.sw, s.sh, 0, 0, s.sw, s.sh);
        c.restore();
      } else {
        c.drawImage(img, s.sx, s.sy, s.sw, s.sh, s.x + ox, s.y + oy, s.sw, s.sh);
      }
      if (alpha !== 1) c.globalAlpha = 1;
    }
  }

  /** `maxWidth` を超えないように 1 文字ずつ折り返す（日本語でも英語でも動く単純な方式）。 */
  function wrap(c: CanvasRenderingContext2D, text: string, maxWidth: number | undefined): string[] {
    if (maxWidth === undefined || !(maxWidth > 0)) return [text];
    const lines: string[] = [];
    let line = "";
    for (const ch of text) {
      if (line !== "" && c.measureText(line + ch).width > maxWidth) {
        lines.push(line);
        line = ch;
      } else {
        line += ch;
      }
    }
    lines.push(line);
    return lines;
  }

  function drawUi(c: CanvasRenderingContext2D, node: UiNode): void {
    switch (node.kind) {
      case "window":
        if (node.variant === "dim") {
          c.fillStyle = DIM_FILL;
          c.fillRect(node.x, node.y, node.w, node.h);
        } else {
          c.fillStyle = WINDOW_FILL;
          c.fillRect(node.x, node.y, node.w, node.h);
          c.strokeStyle = WINDOW_BORDER;
          c.lineWidth = 2;
          c.strokeRect(node.x + 1, node.y + 1, node.w - 2, node.h - 2);
        }
        for (const child of node.children) drawUi(c, child);
        break;
      case "text": {
        c.font = `${node.font.bold === true ? "bold " : ""}${node.font.size}px ${node.font.family}`;
        c.textBaseline = "top";
        if (node.runs !== undefined) {
          c.textAlign = "left";
          let x = node.x;
          for (const run of node.runs) {
            c.fillStyle = css(run.color);
            c.fillText(run.text, x, node.y);
            x += c.measureText(run.text).width;
          }
          break;
        }
        c.textAlign = node.align ?? "left";
        c.fillStyle = css(node.color);
        wrap(c, node.text, node.maxWidth).forEach((line, i) => c.fillText(line, node.x, node.y + i * node.font.size * 1.25));
        break;
      }
      case "gauge":
        c.fillStyle = "rgba(0,0,0,0.6)";
        c.fillRect(node.x, node.y, node.w, node.h);
        c.fillStyle = css(node.color);
        c.fillRect(node.x, node.y, node.w * Math.min(1, Math.max(0, node.ratio)), node.h);
        break;
      case "cursor":
        c.fillStyle = CURSOR_FILL;
        c.fillRect(node.x, node.y, node.w, node.h);
        c.strokeStyle = WINDOW_BORDER;
        c.lineWidth = 2;
        c.strokeRect(node.x, node.y, node.w, node.h);
        break;
      case "image": {
        const img = image(node.asset);
        if (img === undefined) break;
        const sw = node.sw ?? img.width;
        const sh = node.sh ?? img.height;
        c.drawImage(img, node.sx ?? 0, node.sy ?? 0, sw, sh, node.x, node.y, sw, sh);
        break;
      }
    }
  }

  function draw(c: CanvasRenderingContext2D, frame: FrameSpec): void {
    c.setTransform(scale, 0, 0, scale, 0, 0);
    c.globalAlpha = 1;
    c.imageSmoothingEnabled = !pixelated;
    c.fillStyle = "#000";
    c.fillRect(0, 0, frame.size.width, frame.size.height);

    const ox = -frame.camera.x + frame.overlay.shake.dx;
    const oy = -frame.camera.y + frame.overlay.shake.dy;
    for (const layer of frame.layers) {
      if (layer.kind === "tiles") drawTiles(c, layer, frame, ox, oy);
      else drawSprites(c, layer, ox, oy);
    }

    // overlay の順序: tint → flash → fade
    const { tint, flash, fade } = frame.overlay;
    const cover = (fill: string): void => {
      c.fillStyle = fill;
      c.fillRect(0, 0, frame.size.width, frame.size.height);
    };
    if (tint.a > 0) cover(css(tint));
    if (flash !== undefined && flash.alpha > 0) cover(css({ ...flash.color, a: flash.color.a * flash.alpha }));
    if (fade > 0) cover(`rgba(0,0,0,${Math.min(1, fade)})`);

    for (const node of frame.ui) drawUi(c, node);
  }

  return {
    init(opts) {
      if (disposed) return Promise.resolve();
      assets = opts.assets;
      resizeCanvas(opts.width, opts.height);
      ctx = canvas.getContext("2d");
      return ctx === null ? Promise.reject(new Error("canvas 2d コンテキストを取得できない")) : Promise.resolve();
    },
    render(frame) {
      if (disposed || ctx === null) return;
      try {
        draw(ctx, frame);
      } catch {
        // 不変条件: render は例外を投げない（不正な FrameSpec はそのフレームだけ諦める）
      }
    },
    resize(w, h) {
      if (disposed) return;
      resizeCanvas(w, h);
    },
    dispose() {
      disposed = true;
      ctx = null;
      assets = undefined;
      images.clear();
    },
  };
}
