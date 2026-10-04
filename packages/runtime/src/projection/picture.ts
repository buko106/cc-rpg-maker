import type { UiNode } from "../frame-spec.js";
import { pictureNow } from "../visual-fx.js";
import type { VisualFx } from "../visual-fx.js";

/** ピクチャ（`ShowPicture`）を、番号の小さい順（大きいほど手前）の `image` ノードにする。メッセージ・タイマーより奥に描く。 */
export function projectPictures(fx: VisualFx): UiNode[] {
  if (fx.pictures === undefined) return [];
  return Object.entries(fx.pictures)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([, p]): UiNode => {
      const now = pictureNow(p);
      return { kind: "image", asset: p.asset, x: Math.round(now.x), y: Math.round(now.y), alpha: now.opacity, scale: now.scale, ...(p.origin === "center" ? { origin: "center" as const } : {}) };
    });
}
