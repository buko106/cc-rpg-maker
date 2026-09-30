import { createCtx, createProjectView, dispatch as coreDispatch, initialState, SAVE_SLOT_FIRST, step, titleState, toSnapshot } from "@rpg/core";
import type { Action, Ctx, Effect, GameState } from "@rpg/core";
import type { MapData, MapId } from "@rpg/schema";
import { distributeEffect } from "./effects.js";
import type { EffectSinks } from "./effects.js";
import type { FrameSpec } from "./frame-spec.js";
import { projectFrame } from "./projection/index.js";
import type { NoticeKey, UiContext } from "./projection/index.js";
import type { AssetSource } from "./ports/assets.js";
import type { AudioOut } from "./ports/audio.js";
import type { InputSource } from "./ports/input.js";
import { noopLogger } from "./ports/logger.js";
import type { Logger } from "./ports/logger.js";
import type { ProjectSource } from "./ports/project-source.js";
import type { Renderer } from "./ports/renderer.js";
import type { SaveRepository, SlotMeta } from "./ports/saves.js";
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
/** セーブ完了などのお知らせを出しておくステップ数（2 秒）。 */
const NOTICE_STEPS = 120;

export interface RuntimeDeps {
  scheduler: Scheduler;
  renderer: Renderer;
  audio: AudioOut;
  input: InputSource;
  assets: AssetSource;
  projectSource: ProjectSource;
  /** セーブデータの置き場。 */
  saves: SaveRepository;
  /** 現在の壁時計（ミリ秒、Unix エポック）。セーブの日時に使う。省略時は 0（1970 年）。 */
  clock?: () => number;
  /** `true`（既定）ならタイトル画面から始まる。`false` ならすぐニューゲーム。 */
  title?: boolean;
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
  /** 進行中のセーブ書き込みなど、ループを止めない非同期処理がすべて終わるまで待つ。 */
  settled(): Promise<void>;
  /** 観測用。すべての Effect が分配される前に届く。 */
  onEffect(cb: (e: Effect) => void): () => void;
  /** 投影の公開（テスト用）。省略時は現在の状態。 */
  project(state?: GameState): FrameSpec;
}

export function createRuntime(deps: RuntimeDeps): Runtime {
  const { scheduler, renderer, audio, input, assets, projectSource, saves } = deps;
  const logger = deps.logger ?? noopLogger;
  const clock = deps.clock ?? (() => 0);

  let status: RuntimeStatus = "created";
  let ctx: Ctx | undefined;
  let state: GameState | undefined;
  let fx: VisualFx = NO_FX;
  const maps: Record<MapId, MapData> = {};
  let cancelFrame: (() => void) | undefined;
  let lastNow: number | undefined;
  let acc = 0;
  let loading: Promise<void> | undefined;
  let projectId = "";
  let projectHash = "";
  /** `listSlots` のキャッシュ（セーブ/ロード画面の表示用）。 */
  let slots: readonly SlotMeta[] = [];
  /** 見た目だけの一時状態（GameState に入れない）：セーブ結果などのお知らせ。 */
  let notice: { key: NoticeKey; steps: number } | undefined;
  const inflight = new Set<Promise<unknown>>();
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

  /** ループを止めて非同期の作業（マップ・セーブデータの読み込み）を行う。同時には 1 つだけ。失敗は `fail`。 */
  function runLoading(task: () => Promise<void>): void {
    if (loading !== undefined) return;
    status = "loading";
    loading = task()
      .catch(fail)
      .finally(() => {
        if (status === "loading") status = "running";
        loading = undefined;
      });
  }

  const track = (p: Promise<unknown>): void => {
    inflight.add(p);
    void p.finally(() => inflight.delete(p));
  };

  const setNotice = (key: NoticeKey): void => {
    notice = { key, steps: NOTICE_STEPS };
  };

  const refreshSlots = async (): Promise<void> => {
    try {
      slots = await saves.listSlots();
    } catch (e) {
      logger.warn(`セーブスロットの一覧を取得できない: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  /** 現在の状態のスナップショットを取り（同期）、書き込みは非同期で行う。 */
  function saveSlot(slot: number): void {
    const { state: s } = current();
    const now = clock();
    const snap = toSnapshot(s, { projectId, projectHash, savedAt: new Date(Number.isFinite(now) ? now : 0).toISOString() });
    track(
      saves
        .write(slot, snap)
        .then(async (r) => {
          if (r.ok) {
            setNotice("saved");
            await refreshSlots();
          } else {
            logger.warn(`slot ${slot} に保存できない: ${r.error.kind}`);
            setNotice("saveFailed");
          }
        })
        .catch((e: unknown) => {
          logger.warn(`slot ${slot} に保存できない: ${e instanceof Error ? e.message : String(e)}`);
          setNotice("saveFailed");
        }),
    );
  }

  /** セーブデータを読み、そのマップを用意してから `loadSnapshot` で状態を置き換える。失敗してもゲームは続く（お知らせだけ）。 */
  async function loadSlot(slot: number): Promise<void> {
    const r = await saves.read(slot);
    if (!r.ok) {
      logger.warn(`slot ${slot} を読み込めない: ${r.error.kind}`);
      setNotice("loadFailed");
      return;
    }
    const { state: before, ctx: c } = current();
    const mapId = r.value.state.map.mapId;
    if (!Object.hasOwn(c.project.project.maps, mapId)) {
      logger.warn(`slot ${slot}: プロジェクトに無いマップ ${mapId} を指している`);
      setNotice("loadFailed");
      return;
    }
    if (!Object.hasOwn(maps, mapId)) {
      try {
        maps[mapId] = await projectSource.mapData(mapId);
      } catch (e) {
        logger.warn(`slot ${slot}: マップ ${mapId} を読み込めない: ${e instanceof Error ? e.message : String(e)}`);
        setNotice("loadFailed");
        return;
      }
    }
    const result = coreDispatch(before, { type: "loadSnapshot", snapshot: r.value }, c);
    for (const e of result.effects) handleEffect(e);
    if (result.state === before) {
      setNotice("loadFailed");
      return;
    }
    state = result.state;
    fx = NO_FX;
    notice = undefined;
    if (before.scene.kind === "title") audio.stopBgm(500);
  }

  const sinks: EffectSinks = {
    audio,
    logger,
    visual(effect) {
      fx = applyFxEffect(fx, effect);
    },
    loadMap(mapId) {
      runLoading(async () => {
        maps[mapId] = await projectSource.mapData(mapId);
      });
    },
    save: (slot) => saveSlot(slot ?? SAVE_SLOT_FIRST),
    load: (slot) => runLoading(() => loadSlot(slot ?? SAVE_SLOT_FIRST)),
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
      if (notice !== undefined) notice = notice.steps <= 1 ? undefined : { ...notice, steps: notice.steps - 1 };
      acc -= STEP_MS;
      steps++;
      for (const e of result.effects) handleEffect(e);
    }
    if (steps === MAX_STEPS_PER_FRAME) acc = Math.min(acc, STEP_MS);
    if (acc < 0) acc = 0;

    renderer.render(projectFrame(current().state, c.project, fx, uiContext()));
    if (loading) {
      await loading;
      acc = 0;
    }
  }

  const uiContext = (): UiContext => ({ slots, ...(notice === undefined ? {} : { notice: notice.key }) });

  const onFrame = (nowMs: number): void => {
    cancelFrame = scheduler.requestFrame(onFrame);
    frame(nowMs).catch(fail);
  };

  return {
    async start() {
      if (status !== "created") throw new Error(`runtime: start() は ${status} では呼べない`);
      const project = await projectSource.project();
      projectId = project.meta.id;
      projectHash = await projectSource.projectHash();
      maps[project.system.startMap] = await projectSource.mapData(project.system.startMap);
      ctx = createCtx(createProjectView(project, maps));
      const seed = deps.seed ?? String(scheduler.now());
      const showTitle = deps.title ?? true;
      state = showTitle ? titleState(ctx, seed) : initialState(ctx, seed);
      await refreshSlots();
      if (showTitle && project.system.bgm.title !== undefined) audio.playBgm(project.system.bgm.title);
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

    async settled() {
      while (inflight.size > 0 || loading !== undefined) await Promise.all([...inflight, loading]);
    },

    onEffect(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },

    project(s) {
      const { state: cur, ctx: c } = current();
      return projectFrame(s ?? cur, c.project, fx, uiContext());
    },
  };
}
