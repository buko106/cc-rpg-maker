import { createAssetSource, createMemoryBytesSource } from "@rpg/assets";
import { createNullAudioOut } from "@rpg/audio-null";
import type { NullAudioOut } from "@rpg/audio-null";
import { createScriptInput } from "@rpg/input-script";
import type { ScriptInput } from "@rpg/input-script";
import { createNullRenderer } from "@rpg/render-null";
import type { NullRenderer } from "@rpg/render-null";
import { createRuntime, STEP_MS } from "@rpg/runtime";
import type { Effect, InputFrame, Logger, ProjectSource, Runtime } from "@rpg/runtime";
import type { MapData, MapId } from "@rpg/schema";
import { createManualScheduler } from "./manualScheduler.js";
import type { ManualScheduler } from "./manualScheduler.js";
import { loadFixtureProject } from "./project.js";
import type { LoadedProject } from "./project.js";
import { stableStringify } from "./replay.js";

export interface RuntimeHarnessOptions {
  /** `fixtures/projects/v1/<name>` */
  project: string;
  seed?: string;
  /** `mapData` の解決を手動にするマップ（`release(id)` で解決）。遅延ロードのテスト用。 */
  deferMaps?: readonly string[];
  /** `mapData` を失敗させるマップ。 */
  failMaps?: readonly string[];
}

/** 遅延・失敗を制御できる ProjectSource。 */
export interface TestProjectSource extends ProjectSource {
  /** `mapData` が呼ばれた順の ID。 */
  readonly requested: MapId[];
  /** 保留中のマップを解決する。 */
  release(id: string): void;
}

export interface RuntimeHarness {
  runtime: Runtime;
  scheduler: ManualScheduler;
  renderer: NullRenderer;
  audio: NullAudioOut;
  input: ScriptInput;
  projectSource: TestProjectSource;
  loaded: LoadedProject;
  /** `onEffect` で観測した Effect（古い順）。 */
  effects: Effect[];
  warnings: string[];
  /** `onError` に届いた例外。 */
  errors: unknown[];
  /** 仮想時計を `n` フレーム分進める（`n` 回のステップ）。 */
  advanceFrames(n: number): void;
  /** 入力フレームを積んでから、その数だけ進める。 */
  play(...frames: InputFrame[]): void;
}

/**
 * null / script / memory アダプタと手動スケジューラで Runtime を組み立てる（docs/16-testing.md）。
 * `start()` 済みの Runtime を返す。
 */
export async function createRuntimeHarness(opts: RuntimeHarnessOptions): Promise<RuntimeHarness> {
  const loaded = loadFixtureProject(opts.project);
  const deferred = new Set<string>(opts.deferMaps ?? []);
  const failing = new Set<string>(opts.failMaps ?? []);
  const waiting = new Map<string, () => void>();
  const requested: MapId[] = [];

  const projectSource: TestProjectSource = {
    project: () => Promise.resolve(loaded.project),
    projectHash: () => Promise.resolve(stableStringify(loaded.project).length.toString(16)),
    requested,
    mapData(id) {
      requested.push(id);
      const map: MapData | undefined = Object.hasOwn(loaded.maps, id) ? loaded.maps[id] : undefined;
      if (failing.has(id) || map === undefined) return Promise.reject(new Error(`map ${id} を読み込めない`));
      if (!deferred.has(id)) return Promise.resolve(map);
      return new Promise((resolve) => waiting.set(id, () => resolve(map)));
    },
    release(id) {
      const resolve = waiting.get(id);
      if (resolve === undefined) throw new Error(`harness: ${id} は保留されていない`);
      waiting.delete(id);
      resolve();
    },
  };

  const scheduler = createManualScheduler();
  const renderer = createNullRenderer();
  const audio = createNullAudioOut();
  const input = createScriptInput();
  const assets = createAssetSource(createMemoryBytesSource(), loaded.project.assets);
  const warnings: string[] = [];
  const errors: unknown[] = [];
  const logger: Logger = { debug: () => {}, info: () => {}, warn: (m) => warnings.push(m), error: (m) => warnings.push(m) };

  const runtime = createRuntime({ scheduler, renderer, audio, input, assets, projectSource, logger, seed: opts.seed ?? "harness", onError: (e) => errors.push(e) });
  const effects: Effect[] = [];
  runtime.onEffect((e) => effects.push(e));
  await runtime.start();
  requested.length = 0; // start が読む開始マップは数えない

  const advanceFrames = (n: number): void => scheduler.advance(STEP_MS * n);
  return {
    runtime,
    scheduler,
    renderer,
    audio,
    input,
    projectSource,
    loaded,
    effects,
    warnings,
    errors,
    advanceFrames,
    play(...frames) {
      input.push(...frames);
      advanceFrames(frames.length);
    },
  };
}
