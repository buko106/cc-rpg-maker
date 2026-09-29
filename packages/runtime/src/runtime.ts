import { createCtx, createProjectView, dispatch as coreDispatch, initialState, step } from "@rpg/core";
import type { Action, Ctx, Effect, GameState } from "@rpg/core";
import type { MapData, MapId } from "@rpg/schema";
import { distributeEffect } from "./effects.js";
import type { EffectSinks } from "./effects.js";
import type { FrameSpec } from "./frame-spec.js";
import { projectFrame } from "./projection/index.js";
import type { AssetSource } from "./ports/assets.js";
import type { AudioOut } from "./ports/audio.js";
import type { InputSource } from "./ports/input.js";
import { noopLogger } from "./ports/logger.js";
import type { Logger } from "./ports/logger.js";
import type { ProjectSource } from "./ports/project-source.js";
import type { Renderer } from "./ports/renderer.js";
import type { Scheduler } from "./ports/scheduler.js";
import { applyFxEffect, NO_FX, tickFx } from "./visual-fx.js";
import type { VisualFx } from "./visual-fx.js";

/** 固定タイムステップ（1/60 秒）。 */
export const STEP_MS = 1000 / 60;
/** 1 回の `frame` で取り込む経過時間の上限。これを超えた分は捨てる（スパイラル防止）。 */
export const MAX_FRAME_MS = 250;
/** 1 回の `frame` で `core.step` を呼ぶ回数の上限（250ms 分）。 */
export const MAX_STEPS_PER_FRAME = 15;
/** 浮動小数点誤差の許容。 */
const EPSILON = 1e-6;

export interface RuntimeDeps {
  scheduler: Scheduler;
  renderer: Renderer;
  audio: AudioOut;
  input: InputSource;
  assets: AssetSource;
  projectSource: ProjectSource;
  /** 乱数のシード。省略時は開始時の `scheduler.now()`。 */
  seed?: string;
  logger?: Logger;
  /** ループ中の未捕捉エラー（マップのロード失敗など）。呼ばれるとループは止まる。 */
  onError?: (error: unknown) => void;
}

export type RuntimeStatus = "created" | "running" | "loading" | "stopped" | "failed";

export interface Runtime {
  /** プロジェクトと開始マップを読み込み、ゲームを始めてループを回す。 */
  start(): Promise<void>;
  stop(): void;
  /** 1 フレーム進める。通常は Scheduler から呼ばれるが、テストでは直接呼べる。マップのロード中はその完了まで待つ。 */
  frame(nowMs: number): Promise<void>;
  /** 読み取り専用。`frame` / `dispatch` を呼ばない限り変化しない。`start` 前は例外。 */
  getState(): GameState;
  readonly status: RuntimeStatus;
  dispatch(action: Action): void;
  /** 観測用。すべての Effect が分配される前に届く。 */
  onEffect(cb: (e: Effect) => void): () => void;
  /** 投影の公開（テスト用）。省略時は現在の状態。 */
  project(state?: GameState): FrameSpec;
}

export function createRuntime(deps: RuntimeDeps): Runtime {
  const { scheduler, renderer, audio, input, assets, projectSource } = deps;
  const logger = deps.logger ?? noopLogger;

  let status: RuntimeStatus = "created";
  let ctx: Ctx | undefined;
  let state: GameState | undefined;
  let fx: VisualFx = NO_FX;
  const maps: Record<MapId, MapData> = {};
  let cancelFrame: (() => void) | undefined;
  let lastNow: number | undefined;
  let acc = 0;
  let loading: Promise<void> | undefined;
  const listeners = new Set<(e: Effect) => void>();

  const current = (): { state: GameState; ctx: Ctx } => {
    if (state === undefined || ctx === undefined) throw new Error("runtime: start() が完了していない");
    return { state, ctx };
  };

  const fail = (error: unknown): void => {
    if (status === "failed") return;
    status = "failed";
    cancelFrame?.();
    logger.error(`runtime: ${error instanceof Error ? error.message : String(error)}`);
    deps.onError?.(error);
  };

  const sinks: EffectSinks = {
    audio,
    logger,
    visual(effect) {
      fx = applyFxEffect(fx, effect);
    },
    loadMap(mapId) {
      if (loading !== undefined) return;
      status = "loading";
      loading = projectSource.mapData(mapId).then((map) => {
        maps[mapId] = map;
        if (status === "loading") status = "running";
        loading = undefined;
      });
    },
  };

  function handleEffect(effect: Effect): void {
    for (const cb of listeners) cb(effect);
    distributeEffect(effect, sinks);
  }

  async function frame(nowMs: number): Promise<void> {
    if (status !== "running" && status !== "loading") return;
    const { ctx: c } = current();

    const dt = lastNow === undefined ? 0 : Math.max(0, nowMs - lastNow);
    lastNow = nowMs;
    if (status === "running") acc += Math.min(dt, MAX_FRAME_MS);

    let steps = 0;
    while (status === "running" && acc + EPSILON >= STEP_MS && steps < MAX_STEPS_PER_FRAME) {
      const result = step(current().state, input.poll(), c);
      state = result.state;
      fx = tickFx(fx);
      acc -= STEP_MS;
      steps++;
      for (const e of result.effects) handleEffect(e);
    }
    if (steps === MAX_STEPS_PER_FRAME) acc = Math.min(acc, STEP_MS);
    if (acc < 0) acc = 0;

    renderer.render(projectFrame(current().state, c.project, fx));
    if (loading) {
      await loading;
      acc = 0;
    }
  }

  const onFrame = (nowMs: number): void => {
    cancelFrame = scheduler.requestFrame(onFrame);
    frame(nowMs).catch(fail);
  };

  return {
    async start() {
      if (status !== "created") throw new Error(`runtime: start() は ${status} では呼べない`);
      const project = await projectSource.project();
      maps[project.system.startMap] = await projectSource.mapData(project.system.startMap);
      ctx = createCtx(createProjectView(project, maps));
      state = initialState(ctx, deps.seed ?? String(scheduler.now()));
      await renderer.init({ width: project.system.screen.width, height: project.system.screen.height, assets });
      status = "running";
      lastNow = scheduler.now();
      cancelFrame = scheduler.requestFrame(onFrame);
    },

    stop() {
      if (status === "stopped") return;
      cancelFrame?.();
      status = "stopped";
    },

    frame,

    getState: () => current().state,

    get status() {
      return status;
    },

    dispatch(action) {
      const { state: s, ctx: c } = current();
      const result = coreDispatch(s, action, c);
      state = result.state;
      for (const e of result.effects) handleEffect(e);
    },

    onEffect(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },

    project(s) {
      const { state: cur, ctx: c } = current();
      return projectFrame(s ?? cur, c.project, fx);
    },
  };
}
