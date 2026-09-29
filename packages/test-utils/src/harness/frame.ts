import type { FrameSpec } from "@rpg/runtime";

/**
 * FrameSpec のスナップショット用の要約。タイルの配列は「何個中いくつが空でないか」に畳む
 * （スナップショットは小さく、関連ノードだけを残す。docs/16-testing.md）。
 */
export function summarizeFrame(frame: FrameSpec): unknown {
  return {
    ...frame,
    layers: frame.layers.map((l) =>
      l.kind === "tiles" ? { ...l, tiles: `${l.tiles.length} tiles, ${l.tiles.filter((t) => t !== 0).length} non-empty` } : l,
    ),
  };
}
