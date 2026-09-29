import type { FrameSpec } from "../frame-spec.js";
import type { AssetSource } from "./assets.js";

/** `FrameSpec` を描くアダプタ（docs/07-render.md）。`render` は例外を投げず、`FrameSpec` を変更しない。 */
export interface Renderer {
  init(opts: { width: number; height: number; assets: AssetSource }): Promise<void>;
  render(frame: FrameSpec): void;
  resize(w: number, h: number): void;
  dispose(): void;
}
