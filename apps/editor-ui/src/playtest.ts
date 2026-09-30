import { createRuntime } from "@rpg/runtime";
import type { AssetSource, AudioOut, InputSource, Logger, ProjectSource, Renderer, Runtime, Scheduler } from "@rpg/runtime";
import { createMemorySaveRepository } from "@rpg/save-store";
import type { DocProjectSource, EditorSession } from "@rpg/editor-core";
import type { MapId } from "@rpg/schema";

/** 「現在位置からテストプレイ」の開始位置。省略するとタイトルから始める。 */
export interface PlaytestStart {
  mapId: MapId;
  x: number;
  y: number;
}

export interface Playtest {
  readonly runtime: Runtime;
  /** ループを止め、入力・音を解放する。 */
  stop(): void;
}

export interface PlaytestDeps {
  scheduler: Scheduler;
  renderer: Renderer;
  audio: AudioOut;
  input: InputSource & { dispose?(): void };
  assets: AssetSource;
  logger?: Logger;
  onError?: (error: unknown) => void;
  /** 乱数の種。省略すると開始時刻。 */
  seed?: string;
}

/**
 * 編集中の文書でゲームを起動する（docs/13-editor-ui.md「テストプレイ」）。
 * - セーブはメモリ上に置くので、本番のセーブデータには触れない。
 * - `start` があれば、開始マップ・位置をその場所に差し替えて、タイトルを飛ばしてすぐ始める。
 */
export async function startPlaytest(session: EditorSession, deps: PlaytestDeps, start?: PlaytestStart): Promise<Playtest> {
  const base: DocProjectSource = session.projectSource();
  const source: ProjectSource =
    start === undefined
      ? base
      : {
          ...base,
          project: async () => {
            const project = await base.project();
            return { ...project, system: { ...project.system, startMap: start.mapId, startX: start.x, startY: start.y } };
          },
        };
  const project = await source.project();
  const runtime = createRuntime({
    scheduler: deps.scheduler,
    renderer: deps.renderer,
    audio: deps.audio,
    input: deps.input,
    assets: deps.assets,
    projectSource: source,
    saves: createMemorySaveRepository({ projectId: project.meta.id, projectHash: await source.projectHash() }),
    title: start === undefined,
    clock: Date.now,
    ...(deps.seed === undefined ? {} : { seed: deps.seed }),
    ...(deps.logger === undefined ? {} : { logger: deps.logger }),
    ...(deps.onError === undefined ? {} : { onError: deps.onError }),
  });
  await runtime.start();
  return {
    runtime,
    stop() {
      runtime.stop();
      deps.input.dispose?.();
      deps.audio.dispose?.();
    },
  };
}
