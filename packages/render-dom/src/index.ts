/**
 * @rpg/render-dom — DOM/CSS Renderer アダプタ（実験用）。`FrameSpec` を `<div>` の木として描く。
 *
 * タイル・スプライトは `background-image` + `background-position` で画像を切り出し、UI は絶対配置の要素にする。
 * canvas2d / webgl とピクセル単位では一致しない（サブピクセル位置とフォントはブラウザ任せ）。
 * 要素はプールして使い回す。UI は前フレームと内容が同じなら触らない。
 */
import type { AssetId, AssetSource, FrameLayer, FrameSpec, ImageHandle, RGBA, Renderer, UiNode } from "@rpg/runtime";

export interface DomRendererOptions {
  /** 拡大しても輪郭をぼかさない（`image-rendering: pixelated`）。既定 true。 */
  pixelated?: boolean;
  /** 読み込んだ画像を CSS の `url(...)` に使える文字列にする。既定は `ImageBitmap` を blob URL にする。 */
  imageUrl?: (handle: ImageHandle) => Promise<string>;
}

interface Loaded {
  readonly url: string;
  readonly width: number;
  readonly height: number;
}
type Cached = Loaded | "loading" | "failed";

const num = (v: number): number => (Number.isFinite(v) ? v : 0);
const px = (v: number): string => `${Math.round(num(v) * 100) / 100}px`;

const rgba = (c: RGBA, alpha = c.a): string =>
  `rgba(${Math.round(Math.min(255, Math.max(0, num(c.r))))},${Math.round(Math.min(255, Math.max(0, num(c.g))))},${Math.round(Math.min(255, Math.max(0, num(c.b))))},${Math.min(1, Math.max(0, num(alpha)))})`;

const WINDOW_FILL = "rgba(16,16,64,0.88)";
const WINDOW_BORDER = "rgba(255,255,255,0.9)";
const DIM_FILL = "rgba(0,0,0,0.6)";
const CURSOR_FILL = "rgba(255,255,255,0.18)";

/** 既定の画像 → URL 変換。`ImageBitmap`（や `<img>`）を canvas に写して blob URL にする。 */
async function bitmapToUrl(handle: ImageHandle): Promise<string> {
  const src = handle as unknown as { src?: unknown; width: number; height: number };
  if (typeof src.src === "string") return src.src;
  const canvas = document.createElement("canvas");
  canvas.width = src.width;
  canvas.height = src.height;
  const ctx = canvas.getContext("2d");
  if (ctx === null) throw new Error("canvas 2d コンテキストを取得できない");
  ctx.drawImage(src as unknown as CanvasImageSource, 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve));
  if (blob === null) throw new Error("画像を変換できない");
  return URL.createObjectURL(blob);
}

export function createDomRenderer(root: HTMLElement, options: DomRendererOptions = {}): Renderer {
  const pixelated = options.pixelated ?? true;
  const toUrl = options.imageUrl ?? bitmapToUrl;

  let assets: AssetSource | undefined;
  let disposed = false;
  let world: HTMLElement | undefined;
  let overlayEls: HTMLElement[] = [];
  let uiEl: HTMLElement | undefined;
  let uiKey = "";
  const images = new Map<AssetId, Cached>();
  const created: string[] = [];
  /** 要素に最後に設定した `cssText`。同じなら DOM を触らない。 */
  const lastCss = new WeakMap<HTMLElement, string>();
  /** 親要素ごとのプール（子の div）。 */
  const pools = new WeakMap<HTMLElement, HTMLElement[]>();

  const setCss = (el: HTMLElement, css: string): void => {
    if (lastCss.get(el) === css) return;
    lastCss.set(el, css);
    el.style.cssText = css;
  };

  const div = (): HTMLElement => document.createElement("div");

  /** `parent` の `n` 個の子を（無ければ作って）返し、余りは隠す。 */
  const pool = (parent: HTMLElement, n: number): HTMLElement[] => {
    let list = pools.get(parent);
    if (list === undefined) {
      list = [];
      pools.set(parent, list);
    }
    while (list.length < n) {
      const el = div();
      list.push(el);
      parent.append(el);
    }
    for (let i = n; i < list.length; i++) setCss(list[i]!, "display:none");
    return list;
  };

  const image = (id: AssetId): Loaded | undefined => {
    const cached = images.get(id);
    if (cached === "loading" || cached === "failed") return undefined;
    if (cached !== undefined) return cached;
    if (assets === undefined) return undefined;
    images.set(id, "loading");
    assets.loadImage(id).then(
      async (h) => {
        try {
          const size = h as unknown as { width: number; height: number };
          const url = await toUrl(h);
          if (disposed) {
            if (url.startsWith("blob:")) URL.revokeObjectURL(url);
            return;
          }
          if (url.startsWith("blob:")) created.push(url);
          images.set(id, { url, width: size.width, height: size.height });
        } catch {
          images.set(id, "failed");
        }
      },
      () => images.set(id, "failed"),
    );
    return undefined;
  };

  const base = (): string => (pixelated ? "position:absolute;image-rendering:pixelated;" : "position:absolute;");
  const bg = (img: Loaded, sx: number, sy: number): string => `background:url("${img.url}") ${px(-sx)} ${px(-sy)} no-repeat;`;

  function drawTiles(layer: Extract<FrameLayer, { kind: "tiles" }>, frame: FrameSpec, ox: number, oy: number, host: HTMLElement): void {
    const { tileSize: ts, width, height, tiles } = layer;
    if (layer.tileset === null || !(ts > 0) || tiles.length < width * height) return void pool(host, 0);
    const img = image(layer.tileset);
    if (img === undefined) return void pool(host, 0);
    const cols = Math.floor(img.width / ts);
    if (cols <= 0) return void pool(host, 0);
    const x0 = Math.max(0, Math.floor(-ox / ts));
    const x1 = Math.min(width - 1, Math.floor((-ox + frame.size.width - 1) / ts));
    const y0 = Math.max(0, Math.floor(-oy / ts));
    const y1 = Math.min(height - 1, Math.floor((-oy + frame.size.height - 1) / ts));
    const cells: string[] = [];
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const id = tiles[ty * width + tx] ?? 0;
        if (id <= 0) continue;
        const sx = (id % cols) * ts;
        const sy = Math.floor(id / cols) * ts;
        if (sy + ts > img.height) continue;
        cells.push(`${base()}left:${px(tx * ts)};top:${px(ty * ts)};width:${px(ts)};height:${px(ts)};${bg(img, sx, sy)}`);
      }
    }
    const els = pool(host, cells.length);
    cells.forEach((css, i) => setCss(els[i]!, css));
  }

  function drawSprites(layer: Extract<FrameLayer, { kind: "sprites" }>, host: HTMLElement): void {
    const items: string[] = [];
    for (const s of layer.sprites) {
      const img = image(s.asset);
      if (img === undefined) continue;
      const flip = s.flipX === true ? "transform:scaleX(-1);" : "";
      const alpha = s.alpha === undefined || s.alpha === 1 ? "" : `opacity:${Math.min(1, Math.max(0, num(s.alpha)))};`;
      items.push(`${base()}left:${px(s.x)};top:${px(s.y)};width:${px(s.sw)};height:${px(s.sh)};${bg(img, s.sx, s.sy)}${flip}${alpha}`);
    }
    const els = pool(host, items.length);
    items.forEach((css, i) => setCss(els[i]!, css));
  }

  /** 画面座標の UI を `host` の子として作る。`window` の `children` も画面座標なので、入れ子にせず並べる。 */
  function buildUi(host: HTMLElement, nodes: readonly UiNode[]): void {
    host.replaceChildren();
    const add = (node: UiNode): void => {
      switch (node.kind) {
        case "window": {
          const el = div();
          el.setAttribute("role", "group");
          el.style.cssText =
            node.variant === "dim"
              ? `position:absolute;left:${px(node.x)};top:${px(node.y)};width:${px(node.w)};height:${px(node.h)};background:${DIM_FILL}`
              : `position:absolute;box-sizing:border-box;left:${px(node.x)};top:${px(node.y)};width:${px(node.w)};height:${px(node.h)};background:${WINDOW_FILL};border:2px solid ${WINDOW_BORDER}`;
          host.append(el);
          for (const child of node.children) add(child);
          break;
        }
        case "text": {
          const el = div();
          const align = node.align ?? "left";
          const shift = align === "center" ? "transform:translateX(-50%);" : align === "right" ? "transform:translateX(-100%);" : "";
          const wrap = node.maxWidth !== undefined && node.maxWidth > 0 ? `width:${px(node.maxWidth)};white-space:normal;overflow-wrap:anywhere;` : "white-space:pre;";
          el.style.cssText = `position:absolute;left:${px(node.x)};top:${px(node.y)};font:${node.font.bold === true ? "bold " : ""}${num(node.font.size)}px/1.25 ${node.font.family};color:${rgba(node.color)};text-align:${align};${shift}${wrap}`;
          if (node.runs !== undefined) {
            el.style.whiteSpace = "pre";
            for (const run of node.runs) {
              const span = document.createElement("span");
              span.style.color = rgba(run.color);
              span.textContent = run.text;
              el.append(span);
            }
          } else {
            el.textContent = node.text;
          }
          host.append(el);
          break;
        }
        case "gauge": {
          const el = div();
          el.setAttribute("role", "progressbar");
          el.setAttribute("aria-valuenow", String(Math.round(Math.min(1, Math.max(0, num(node.ratio))) * 100)));
          el.style.cssText = `position:absolute;left:${px(node.x)};top:${px(node.y)};width:${px(node.w)};height:${px(node.h)};background:rgba(0,0,0,0.6)`;
          const fill = div();
          fill.style.cssText = `width:${Math.min(1, Math.max(0, num(node.ratio))) * 100}%;height:100%;background:${rgba(node.color)}`;
          el.append(fill);
          host.append(el);
          break;
        }
        case "cursor": {
          const el = div();
          el.dataset["cursor"] = "";
          el.style.cssText = `position:absolute;box-sizing:border-box;left:${px(node.x)};top:${px(node.y)};width:${px(node.w)};height:${px(node.h)};background:${CURSOR_FILL};border:2px solid ${WINDOW_BORDER}`;
          host.append(el);
          break;
        }
        case "image": {
          const img = image(node.asset);
          if (img === undefined) break;
          const sw = node.sw ?? img.width;
          const sh = node.sh ?? img.height;
          const s = node.scale ?? 1;
          const el = div();
          const alpha = node.alpha === undefined || node.alpha >= 1 ? "" : `opacity:${Math.max(0, num(node.alpha))};`;
          const origin = node.origin === "center" ? `left:${px(node.x - (sw * s) / 2)};top:${px(node.y - (sh * s) / 2)};` : `left:${px(node.x)};top:${px(node.y)};`;
          el.style.cssText = `${base()}${origin}width:${px(sw)};height:${px(sh)};${bg(img, node.sx ?? 0, node.sy ?? 0)}transform:scale(${s});transform-origin:0 0;${alpha}`;
          host.append(el);
          break;
        }
      }
    };
    for (const n of nodes) add(n);
  }

  /** UI が参照する画像のうち、まだ読み込み済みでないものの数（読み込めたら作り直すための鍵に混ぜる）。 */
  const readyKey = (nodes: readonly UiNode[]): string => {
    let k = "";
    const walk = (n: UiNode): void => {
      if (n.kind === "image") k += typeof images.get(n.asset) === "object" ? "1" : "0";
      if (n.kind === "window") n.children.forEach(walk);
    };
    nodes.forEach(walk);
    return k;
  };

  function mount(width: number, height: number): void {
    root.replaceChildren();
    root.dataset["renderer"] = "dom";
    root.style.cssText = `position:relative;overflow:hidden;background:#000;width:${px(width)};height:${px(height)};user-select:none`;
    world = div();
    world.style.cssText = "position:absolute;left:0;top:0";
    uiEl = div();
    uiEl.setAttribute("aria-live", "polite");
    uiEl.style.cssText = "position:absolute;left:0;top:0";
    overlayEls = [div(), div(), div()];
    for (const o of overlayEls) setCss(o, "display:none");
    root.append(world, ...overlayEls, uiEl);
    uiKey = "";
  }

  function draw(frame: FrameSpec): void {
    if (world === undefined || uiEl === undefined) return;
    const { width, height } = frame.size;
    setCss(root, `position:relative;overflow:hidden;background:#000;width:${px(width)};height:${px(height)};user-select:none`);
    const ox = -frame.camera.x + frame.overlay.shake.dx;
    const oy = -frame.camera.y + frame.overlay.shake.dy;
    setCss(world, `position:absolute;left:0;top:0;transform:translate(${px(ox)},${px(oy)})`);

    const layerEls = pool(world, frame.layers.length);
    frame.layers.forEach((layer, i) => {
      const host = layerEls[i]!;
      setCss(host, "position:absolute;left:0;top:0");
      if (layer.kind === "tiles") drawTiles(layer, frame, ox, oy, host);
      else drawSprites(layer, host);
    });

    // overlay の順序: tint → flash → fade
    const cover = (el: HTMLElement, color: string | undefined): void => setCss(el, color === undefined ? "display:none" : `position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;background:${color}`);
    const { tint, flash, fade, fadeColor } = frame.overlay;
    cover(overlayEls[0]!, tint.a > 0 ? rgba(tint) : undefined);
    cover(overlayEls[1]!, flash !== undefined && flash.alpha > 0 ? rgba(flash.color, flash.color.a * flash.alpha) : undefined);
    cover(overlayEls[2]!, fade > 0 ? rgba(fadeColor ?? { r: 0, g: 0, b: 0, a: 1 }, Math.min(1, fade)) : undefined);

    const key = JSON.stringify(frame.ui) + readyKey(frame.ui);
    if (key !== uiKey) {
      uiKey = key;
      buildUi(uiEl, frame.ui);
    }
  }

  return {
    init(opts) {
      if (disposed) return Promise.resolve();
      assets = opts.assets;
      mount(opts.width, opts.height);
      return Promise.resolve();
    },
    render(frame) {
      if (disposed) return;
      try {
        draw(frame);
      } catch {
        // 不変条件: render は例外を投げない（不正な FrameSpec はそのフレームだけ諦める）
      }
    },
    resize(w, h) {
      if (disposed) return;
      setCss(root, `position:relative;overflow:hidden;background:#000;width:${px(w)};height:${px(h)};user-select:none`);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      root.replaceChildren();
      for (const u of created) URL.revokeObjectURL(u);
      created.length = 0;
      images.clear();
      assets = undefined;
    },
  };
}
