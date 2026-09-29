/**
 * @rpg/render-null — Null Renderer アダプタ。何も描かず、受け取った `FrameSpec` を記録する（テスト用）。
 *
 * 設計: docs/07-render.md
 */
import type { AssetSource, FrameSpec, Renderer } from "@rpg/runtime";

export interface NullRenderer extends Renderer {
  /** `render` に渡された `FrameSpec`（古い順）。`dispose` 後の `render` は記録されない。 */
  readonly frames: FrameSpec[];
  /** `init` に渡された引数。 */
  readonly initOpts: { width: number; height: number; assets: AssetSource } | undefined;
  /** 現在の描画サイズ（`init` / `resize` で更新）。 */
  readonly size: { width: number; height: number };
  readonly disposed: boolean;
  last(): FrameSpec | undefined;
  clear(): void;
}

export function createNullRenderer(): NullRenderer {
  const frames: FrameSpec[] = [];
  let initOpts: NullRenderer["initOpts"];
  let size = { width: 0, height: 0 };
  let disposed = false;

  return {
    frames,
    get initOpts() {
      return initOpts;
    },
    get size() {
      return size;
    },
    get disposed() {
      return disposed;
    },
    init(opts) {
      if (!disposed) {
        initOpts = opts;
        size = { width: opts.width, height: opts.height };
      }
      return Promise.resolve();
    },
    render(frame) {
      if (!disposed) frames.push(frame);
    },
    resize(width, height) {
      if (!disposed) size = { width, height };
    },
    dispose() {
      disposed = true;
    },
    last: () => frames[frames.length - 1],
    clear() {
      frames.length = 0;
    },
  };
}
