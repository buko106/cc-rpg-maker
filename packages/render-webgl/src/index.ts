/**
 * @rpg/render-webgl — WebGL Renderer アダプタ。`FrameSpec` を、Canvas2D レンダラと視覚的に同等に描く。
 *
 * 設計: docs/07-render.md
 * 何を描くか（矩形の並び）は `buildDrawList`（純粋な関数）が決め、ここは矩形をバッチにして GPU に渡すだけ。
 * 文字は 2D canvas で白く描いてテクスチャにし、頂点色で染める。WebGL が使えない環境では `init` が reject する。
 */
import type { AssetId, AssetSource, FrameSpec, ImageHandle, Renderer } from "@rpg/runtime";
import { buildDrawList, TEXT_PAD } from "./draw-list.js";
import type { DrawEnv, Quad, TextureRef } from "./draw-list.js";

export { buildDrawList, fontOf, solid, wrapText } from "./draw-list.js";
export type { DrawEnv, Quad, TextureRef } from "./draw-list.js";

/** 文字の測定と、白い文字のテクスチャ用ビットマップの作成（既定は 2D canvas。テストで差し替えられる）。 */
export interface TextSurface {
  measure(font: string, text: string): number;
  /**
   * `width × height`（論理ピクセル）の領域に、`text` を左上の余白 `TEXT_PAD` の位置から白で描いたビットマップ。
   * 実ピクセルは `scale` 倍（`dpr` が 2 のとき、文字が粗くならないよう 2 倍の解像度で描く）。
   */
  rasterize(text: string, font: string, width: number, height: number, scale: number): TexImageSource;
}

export interface WebglOptions {
  /** 拡大しても輪郭をぼかさない（テクスチャの補間を最近傍にする）。既定 true。 */
  pixelated?: boolean;
  /** 論理ピクセルあたりの実ピクセル数。既定 1（拡大は CSS で行う）。 */
  dpr?: number;
  /** 描いた内容を残す（`toDataURL` やピクセル比較用）。既定 false。 */
  preserveDrawingBuffer?: boolean;
  text?: TextSurface;
}

type Loaded = { bitmap: TexImageSource & { width: number; height: number }; texture: WebGLTexture | undefined };
type Cached = Loaded | "loading" | "failed";
type Texture = { texture: WebGLTexture; width: number; height: number };

const FLOATS_PER_VERTEX = 8;
const VERTICES_PER_QUAD = 6;
const MAX_QUADS = 2048;
const MAX_TEXT_TEXTURES = 512;

const VERTEX_SHADER = `
attribute vec2 a_pos;
attribute vec2 a_uv;
attribute vec4 a_color;
uniform vec2 u_res;
varying vec2 v_uv;
varying vec4 v_color;
void main() {
  gl_Position = vec4(a_pos.x / u_res.x * 2.0 - 1.0, 1.0 - a_pos.y / u_res.y * 2.0, 0.0, 1.0);
  v_uv = a_uv;
  v_color = a_color;
}`;

const FRAGMENT_SHADER = `
precision mediump float;
uniform sampler2D u_tex;
varying vec2 v_uv;
varying vec4 v_color;
void main() {
  gl_FragColor = texture2D(u_tex, v_uv) * v_color;
}`;

/** 既定の文字の描画面：2D canvas（`OffscreenCanvas` があればそれ、無ければ DOM の canvas）。 */
export function createCanvasTextSurface(): TextSurface {
  const make = (w: number, h: number): OffscreenCanvas | HTMLCanvasElement => {
    if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    return c;
  };
  let scratch: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;
  return {
    measure(font, text) {
      scratch ??= make(1, 1).getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
      if (scratch === null) return text.length * 8;
      scratch.font = font;
      return scratch.measureText(text).width;
    },
    rasterize(text, font, width, height, scale) {
      const canvas = make(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)));
      const c = canvas.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
      if (c !== null) {
        c.scale(scale, scale);
        c.font = font;
        c.textBaseline = "top";
        c.textAlign = "left";
        c.fillStyle = "#fff";
        c.fillText(text, TEXT_PAD, TEXT_PAD);
      }
      return canvas;
    },
  };
}

/** この環境で WebGL が使えるか（プレイヤーの `renderer: "auto"` が使う）。 */
export function isWebglAvailable(): boolean {
  try {
    if (typeof document === "undefined") return false;
    const canvas = document.createElement("canvas");
    return canvas.getContext("webgl2") !== null || canvas.getContext("webgl") !== null;
  } catch {
    return false;
  }
}

export function createWebglRenderer(canvas: HTMLCanvasElement, options: WebglOptions = {}): Renderer {
  const pixelated = options.pixelated ?? true;
  const scale = options.dpr ?? 1;
  const text = options.text ?? createCanvasTextSurface();

  let gl: WebGLRenderingContext | WebGL2RenderingContext | null = null;
  let program: WebGLProgram | null = null;
  let buffer: WebGLBuffer | null = null;
  let white: WebGLTexture | null = null;
  let uRes: WebGLUniformLocation | null = null;
  let assets: AssetSource | undefined;
  let disposed = false;
  let lost = false;
  const images = new Map<AssetId, Cached>();
  const texts = new Map<string, Texture>();
  const vertices = new Float32Array(MAX_QUADS * VERTICES_PER_QUAD * FLOATS_PER_VERTEX);

  const resizeCanvas = (w: number, h: number): void => {
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
  };

  function compile(context: WebGLRenderingContext, type: number, source: string): WebGLShader {
    const shader = context.createShader(type);
    if (shader === null) throw new Error("シェーダを作れない");
    context.shaderSource(shader, source);
    context.compileShader(shader);
    if (context.getShaderParameter(shader, context.COMPILE_STATUS) !== true) throw new Error(`シェーダのコンパイルに失敗: ${context.getShaderInfoLog(shader) ?? ""}`);
    return shader;
  }

  function texture(context: WebGLRenderingContext, source: TexImageSource | { data: Uint8Array }): WebGLTexture {
    const t = context.createTexture();
    if (t === null) throw new Error("テクスチャを作れない");
    context.bindTexture(context.TEXTURE_2D, t);
    context.pixelStorei(context.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    if ("data" in source) context.texImage2D(context.TEXTURE_2D, 0, context.RGBA, 1, 1, 0, context.RGBA, context.UNSIGNED_BYTE, source.data);
    else context.texImage2D(context.TEXTURE_2D, 0, context.RGBA, context.RGBA, context.UNSIGNED_BYTE, source);
    const filter = pixelated ? context.NEAREST : context.LINEAR;
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, filter);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, filter);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_S, context.CLAMP_TO_EDGE);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_T, context.CLAMP_TO_EDGE);
    return t;
  }

  /** プログラム・バッファ・白いテクスチャを作る（コンテキストの復帰時にも呼ぶ）。 */
  function setup(context: WebGLRenderingContext): void {
    const p = context.createProgram();
    if (p === null) throw new Error("プログラムを作れない");
    context.attachShader(p, compile(context, context.VERTEX_SHADER, VERTEX_SHADER));
    context.attachShader(p, compile(context, context.FRAGMENT_SHADER, FRAGMENT_SHADER));
    context.bindAttribLocation(p, 0, "a_pos");
    context.bindAttribLocation(p, 1, "a_uv");
    context.bindAttribLocation(p, 2, "a_color");
    context.linkProgram(p);
    if (context.getProgramParameter(p, context.LINK_STATUS) !== true) throw new Error(`プログラムのリンクに失敗: ${context.getProgramInfoLog(p) ?? ""}`);
    program = p;
    uRes = context.getUniformLocation(p, "u_res");
    buffer = context.createBuffer();
    white = texture(context, { data: new Uint8Array([255, 255, 255, 255]) });
    for (const cached of images.values()) if (typeof cached === "object") cached.texture = undefined;
    texts.clear();
  }

  /** ロード済みなら画像。未ロードなら非同期ロードを始めて `undefined`（そのフレームは描かない）。 */
  function image(id: AssetId): Loaded | undefined {
    const cached = images.get(id);
    if (cached === "loading" || cached === "failed") return undefined;
    if (cached !== undefined) return cached;
    if (assets === undefined) return undefined;
    images.set(id, "loading");
    assets.loadImage(id).then(
      (h: ImageHandle) => {
        if (!disposed) images.set(id, { bitmap: h as unknown as Loaded["bitmap"], texture: undefined });
      },
      () => images.set(id, "failed"),
    );
    return undefined;
  }

  const env: DrawEnv = {
    image(id) {
      const img = image(id);
      return img === undefined ? undefined : { width: img.bitmap.width, height: img.bitmap.height };
    },
    measure: (font, s) => text.measure(font, s),
  };

  function resolve(context: WebGLRenderingContext, ref: TextureRef): WebGLTexture | null {
    switch (ref.kind) {
      case "white":
        return white;
      case "asset": {
        const img = image(ref.id);
        if (img === undefined) return null;
        img.texture ??= texture(context, img.bitmap);
        return img.texture;
      }
      case "text": {
        const key = `${ref.font}|${ref.text}`;
        let t = texts.get(key);
        if (t === undefined) {
          if (texts.size >= MAX_TEXT_TEXTURES) {
            for (const old of texts.values()) context.deleteTexture(old.texture);
            texts.clear();
          }
          t = { texture: texture(context, text.rasterize(ref.text, ref.font, ref.width, ref.height, scale)), width: ref.width, height: ref.height };
          texts.set(key, t);
        }
        return t.texture;
      }
    }
  }

  function draw(context: WebGLRenderingContext, frame: FrameSpec): void {
    if (program === null || buffer === null) return;
    context.viewport(0, 0, canvas.width, canvas.height);
    context.clearColor(0, 0, 0, 1);
    context.clear(context.COLOR_BUFFER_BIT);
    const quads = buildDrawList(frame, env);
    if (quads.length === 0) return;

    context.useProgram(program);
    context.uniform2f(uRes, frame.size.width, frame.size.height);
    context.enable(context.BLEND);
    context.blendFuncSeparate(context.SRC_ALPHA, context.ONE_MINUS_SRC_ALPHA, context.ONE, context.ONE_MINUS_SRC_ALPHA);
    context.disable(context.DEPTH_TEST);
    context.bindBuffer(context.ARRAY_BUFFER, buffer);
    const stride = FLOATS_PER_VERTEX * 4;
    context.enableVertexAttribArray(0);
    context.vertexAttribPointer(0, 2, context.FLOAT, false, stride, 0);
    context.enableVertexAttribArray(1);
    context.vertexAttribPointer(1, 2, context.FLOAT, false, stride, 8);
    context.enableVertexAttribArray(2);
    context.vertexAttribPointer(2, 4, context.FLOAT, false, stride, 16);
    context.activeTexture(context.TEXTURE0);

    let count = 0;
    let current: WebGLTexture | null = null;
    const flush = (): void => {
      if (count === 0 || current === null) return;
      context.bindTexture(context.TEXTURE_2D, current);
      context.bufferData(context.ARRAY_BUFFER, vertices.subarray(0, count * VERTICES_PER_QUAD * FLOATS_PER_VERTEX), context.DYNAMIC_DRAW);
      context.drawArrays(context.TRIANGLES, 0, count * VERTICES_PER_QUAD);
      count = 0;
    };
    const push = (q: Quad): void => {
      const x1 = q.x + q.w;
      const y1 = q.y + q.h;
      const corners: readonly [number, number, number, number][] = [
        [q.x, q.y, q.u0, q.v0],
        [x1, q.y, q.u1, q.v0],
        [q.x, y1, q.u0, q.v1],
        [q.x, y1, q.u0, q.v1],
        [x1, q.y, q.u1, q.v0],
        [x1, y1, q.u1, q.v1],
      ];
      let o = count * VERTICES_PER_QUAD * FLOATS_PER_VERTEX;
      for (const [x, y, u, v] of corners) {
        vertices[o++] = x;
        vertices[o++] = y;
        vertices[o++] = u;
        vertices[o++] = v;
        vertices[o++] = q.r;
        vertices[o++] = q.g;
        vertices[o++] = q.b;
        vertices[o++] = q.a;
      }
      count++;
    };

    for (const q of quads) {
      const t = resolve(context, q.tex);
      if (t === null) continue;
      if (t !== current || count >= MAX_QUADS) {
        flush();
        current = t;
      }
      push(q);
    }
    flush();
  }

  return {
    init(opts) {
      if (disposed) return Promise.resolve();
      assets = opts.assets;
      resizeCanvas(opts.width, opts.height);
      const attributes: WebGLContextAttributes = { alpha: false, antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: options.preserveDrawingBuffer ?? false };
      gl = (canvas.getContext("webgl2", attributes) ?? canvas.getContext("webgl", attributes)) as WebGLRenderingContext | null;
      if (gl === null) return Promise.reject(new Error("WebGL コンテキストを取得できない"));
      canvas.addEventListener("webglcontextlost", (e) => {
        e.preventDefault();
        lost = true;
      });
      canvas.addEventListener("webglcontextrestored", () => {
        if (disposed || gl === null) return;
        try {
          setup(gl);
          lost = false;
        } catch {
          // 復帰に失敗したら描かないまま（render は例外を投げない）
        }
      });
      try {
        setup(gl);
      } catch (e) {
        gl = null;
        return Promise.reject(e instanceof Error ? e : new Error(String(e)));
      }
      return Promise.resolve();
    },
    render(frame) {
      if (disposed || gl === null || lost) return;
      try {
        draw(gl, frame);
      } catch {
        // 不変条件: render は例外を投げない（不正な FrameSpec はそのフレームだけ諦める）
      }
    },
    resize(w, h) {
      if (disposed) return;
      resizeCanvas(w, h);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      const context = gl;
      if (context !== null) {
        try {
          for (const t of texts.values()) context.deleteTexture(t.texture);
          for (const cached of images.values()) if (typeof cached === "object" && cached.texture !== undefined) context.deleteTexture(cached.texture);
          if (white !== null) context.deleteTexture(white);
          if (buffer !== null) context.deleteBuffer(buffer);
          if (program !== null) context.deleteProgram(program);
        } catch {
          // すでにコンテキストが失われている場合など
        }
      }
      texts.clear();
      images.clear();
      gl = null;
      assets = undefined;
    },
  };
}
