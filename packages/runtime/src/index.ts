/**
 * @rpg/runtime — ゲームループ、シーン管理、FrameSpec 投影、ポート定義。
 *
 * 設計: docs/06-runtime.md
 *
 * アダプタ（render-* / audio-* / input-* / assets）は core に依存できないので、
 * ポートの定義に必要な core / schema の型をここから再エクスポートする。
 */
export { createRuntime, MAX_FRAME_MS, MAX_STEPS_PER_FRAME, STEP_MS } from "./runtime.js";
export type { Runtime, RuntimeDeps, RuntimeStatus } from "./runtime.js";
export { distributeEffect } from "./effects.js";
export type { EffectSinks } from "./effects.js";
export { NO_UI, projectFrame, projectMapLayers, projectMenu, projectMessage, projectTitle, term } from "./projection/index.js";
export type { NoticeKey, TermKey, UiContext } from "./projection/index.js";
export { expandText } from "./text-codec.js";
export type { ColoredText, TextEnv } from "./text-codec.js";
export { applyFxEffect, fxOverlay, NO_FX, tickFx } from "./visual-fx.js";
export type { VisualFx } from "./visual-fx.js";
export type { FontSpec, FrameLayer, FrameSpec, Overlay, Sprite, TextRun, UiNode } from "./frame-spec.js";
export { AssetError } from "./ports/assets.js";
export type { AssetErrorKind, AssetSource, AudioHandle, ImageHandle } from "./ports/assets.js";
export type { AudioOut } from "./ports/audio.js";
export type { InputSource } from "./ports/input.js";
export { noopLogger } from "./ports/logger.js";
export type { Logger } from "./ports/logger.js";
export type { ProjectSource } from "./ports/project-source.js";
export type { Renderer } from "./ports/renderer.js";
export type { BlobLike, SaveRepository, SaveRepositoryOpts, SaveStoreError, SlotMeta } from "./ports/saves.js";
export type { Scheduler } from "./ports/scheduler.js";

// ポートのシグネチャに現れる core / schema の型と、アダプタが `InputFrame` を作るのに必要な関数
export { emptyInput, inputFrame } from "@rpg/core";
export type { Action, Button, Effect, GameState, InputFrame, RGBA, SaveSnapshot } from "@rpg/core";
export { err, ok } from "@rpg/schema";
export type { AssetId, AssetManifest, AudioRef, Direction, MapData, MapId, Project, Result } from "@rpg/schema";
