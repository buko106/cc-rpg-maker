import { createAssetSource, createHttpBytesSource } from "@rpg/assets";
import { createNullAudioOut } from "@rpg/audio-null";
import { createBrowserInput } from "@rpg/input-browser";
import { createCanvas2dRenderer } from "@rpg/render-canvas2d";
import { createRuntime } from "@rpg/runtime";
import type { Logger, Runtime } from "@rpg/runtime";
import { createSaveRepository } from "@rpg/save-store";
import { createHttpProjectSource } from "./http-project-source.js";
import { collectStartAssets } from "./preload.js";
import { createRafScheduler } from "./raf-scheduler.js";
import { createScreens } from "./screens.js";

/**
 * プレイヤーの設定。M2 ではフォルダ形式（`project/` + `assets/`）のみ。
 * 単一 HTML（`embedded`）、`renderer`（webgl）、`plugins` は後続のマイルストーンで追加する。
 */
export interface PlayerConfig {
  /** `project.json` の URL（ページからの相対でよい）。例 `project/project.json` */
  projectUrl: string;
  /** アセットのフォルダの URL。既定は `projectUrl` の隣の `../assets/`。 */
  assetsUrl?: string;
  /** エラー画面にスタックを表示し、ログを console に出す。 */
  debug?: boolean;
  /** 同じオリジンで複数のゲームを配るときの、セーブの保存先を分けるキー。 */
  saveScope?: string;
}

/** 画面の拡大率（整数倍にすると輪郭がにじまない）。 */
const ZOOM = 2;

const consoleLogger = (debug: boolean): Logger => ({
  debug: (m) => debug && console.debug(`[rpg] ${m}`),
  info: (m) => debug && console.info(`[rpg] ${m}`),
  warn: (m) => console.warn(`[rpg] ${m}`),
  error: (m) => console.error(`[rpg] ${m}`),
});

/**
 * `root` にゲームを起動する。読み込み中は進捗を、失敗したらエラー画面を出す（例外も再送出する）。
 * 戻り値の Runtime は開始済みで、ループが回っている。
 */
export async function bootPlayer(root: HTMLElement, config: PlayerConfig): Promise<Runtime> {
  const debug = config.debug ?? false;
  root.replaceChildren();
  root.style.position = "relative";
  const canvas = document.createElement("canvas");
  canvas.tabIndex = 0;
  canvas.setAttribute("aria-label", "ゲーム画面");
  root.append(canvas);
  const screens = createScreens(root);

  try {
    screens.loading("読み込み中…");
    const projectUrl = new URL(config.projectUrl, document.baseURI).href;
    const projectSource = createHttpProjectSource(projectUrl);
    const project = await projectSource.project();
    const { width, height } = project.system.screen;
    canvas.style.cssText = `display:block;margin:0 auto;width:${width * ZOOM}px;max-width:100%;height:auto;aspect-ratio:${width}/${height};image-rendering:pixelated;background:#000`;
    document.title = project.meta.title;

    const assetsUrl = config.assetsUrl ?? new URL("../assets/", projectUrl).href;
    const assets = createAssetSource(createHttpBytesSource(assetsUrl, project.assets), project.assets);
    const startMap = await projectSource.mapData(project.system.startMap);
    await assets.preload(collectStartAssets(project, startMap), (done, total) => screens.loading(`読み込み中… ${done}/${total}`));

    // セーブは project.meta.id ごとに分かれる。同じオリジンで複数のゲームを配るときは saveScope で保存先自体を分ける
    const scope = config.saveScope === undefined ? "" : `-${config.saveScope}`;
    const saves = createSaveRepository({
      projectId: project.meta.id,
      projectHash: await projectSource.projectHash(),
      dbName: `rpg-saves${scope}`,
      prefix: `rpg-save${scope}`,
    });

    const input = createBrowserInput(window, { gamepad: true });
    const runtime = createRuntime({
      scheduler: createRafScheduler(),
      renderer: createCanvas2dRenderer(canvas, { pixelated: true }),
      audio: createNullAudioOut(), // 音は M4（audio-webaudio）
      input,
      assets,
      projectSource,
      saves,
      clock: Date.now,
      seed: String(Date.now()),
      logger: consoleLogger(debug),
      onError: (e) => {
        input.dispose();
        screens.error(e, debug);
      },
    });
    await runtime.start();
    screens.hide();
    canvas.focus();
    return runtime;
  } catch (e) {
    screens.error(e, debug);
    throw e;
  }
}
