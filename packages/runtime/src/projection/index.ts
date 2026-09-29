import type { GameState, ProjectView } from "@rpg/core";
import type { FrameSpec } from "../frame-spec.js";
import { fxOverlay, NO_FX } from "../visual-fx.js";
import type { VisualFx } from "../visual-fx.js";
import { projectMapLayers } from "./map-scene.js";
import { projectMessage } from "./message.js";

/**
 * `GameState` → `FrameSpec`。純粋関数（同じ入力なら deep-equal な出力）。
 * M2 ではマップシーンとメッセージのみ。タイトル・メニュー・戦闘のシーンは空の画面になる。
 */
export function projectFrame(state: GameState, view: ProjectView, fx: VisualFx = NO_FX): FrameSpec {
  const { screen } = view.project.system;
  const overlay = fxOverlay(fx);
  if (state.scene.kind !== "map") return { size: screen, camera: { x: 0, y: 0 }, layers: [], overlay, ui: [] };

  const { tileSize, layers } = projectMapLayers(state, view);
  return {
    size: { width: screen.width, height: screen.height },
    camera: { x: Math.round(state.map.camera.x * tileSize), y: Math.round(state.map.camera.y * tileSize) },
    layers,
    overlay,
    ui: projectMessage(state, (id) => (Object.hasOwn(state.actors, id) ? state.actors[id as keyof typeof state.actors]?.name : undefined), screen),
  };
}

export { projectMapLayers } from "./map-scene.js";
export { projectMessage } from "./message.js";
