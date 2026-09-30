import { createAssetSource, createEmbeddedBytesSource, createHttpBytesSource } from "@rpg/assets";
import { createBrowserInput } from "@rpg/input-browser";
import { createPluginRegistry, loadPlugins, selectPlugins, toRuntimeExtensions } from "@rpg/plugin-api";
import type { PluginModule } from "@rpg/plugin-api";
import { createCanvas2dRenderer } from "@rpg/render-canvas2d";
import { createWebglRenderer, isWebglAvailable } from "@rpg/render-webgl";
import { createRuntime } from "@rpg/runtime";
import type { Logger, Renderer, Runtime } from "@rpg/runtime";
import { createSaveRepository } from "@rpg/save-store";
import { createPlayerAudio } from "./audio.js";
import { createEmbeddedProjectSource } from "./embedded-project-source.js";
import type { EmbeddedData } from "./embedded-project-source.js";
import { createHttpProjectSource } from "./http-project-source.js";
import { collectStartAssets } from "./preload.js";
import { createRafScheduler } from "./raf-scheduler.js";
import { createScreens } from "./screens.js";

/**
 * プレイヤーの設定。フォルダ形式（`projectUrl`：`project/` + `assets/`）か、単一 HTML（`embedded`）のどちらか。
 * `plugins` はビルドに入っているプラグイン。`renderer` は描画方式（既定は `auto`）。
 */
export type RendererKind = "canvas2d" | "webgl" | "auto";

/** 描画方式を決める。`auto` は WebGL が使えれば WebGL、使えなければ Canvas2D。 */
export function pickRenderer(kind: RendererKind | undefined, webglAvailable: () => boolean = isWebglAvailable): "canvas2d" | "webgl" {
  if (kind === "canvas2d") return "canvas2d";
  if (kind === "webgl") return "webgl";
  return webglAvailable() ? "webgl" : "canvas2d";
}

export interface PlayerConfig {
  /** 描画方式。`auto`（既定）は WebGL が使えれば WebGL、使えなければ Canvas2D。 */
  renderer?: RendererKind;
  /** フォルダ形式：`project.json` の URL（ページからの相対でよい）。例 `project/project.json` */
  projectUrl?: string;
  /** 単一 HTML：埋め込まれたゲーム一式。指定すると通信しない（`projectUrl` は無視される）。 */
  embedded?: EmbeddedData;
  /** アセットのフォルダの URL。既定は `projectUrl` の隣の `../assets/`。 */
  assetsUrl?: string;
  /** エラー画面にスタックを表示し、ログを console に出す。 */
  debug?: boolean;
  /** ビルドに入っているプラグインの一覧。プロジェクトの `system.plugins` で有効にされたものだけが読み込まれる。 */
  plugins?: readonly PluginModule[];
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
    if (config.embedded === undefined && config.projectUrl === undefined) throw new Error("projectUrl か embedded のどちらかが必要");
    const projectUrl = config.projectUrl === undefined ? undefined : new URL(config.projectUrl, document.baseURI).href;
    const projectSource = config.embedded !== undefined ? createEmbeddedProjectSource(config.embedded) : createHttpProjectSource(projectUrl!);
    const project = await projectSource.project();
    const { width, height } = project.system.screen;
    canvas.style.cssText = `display:block;margin:0 auto;width:${width * ZOOM}px;max-width:100%;height:auto;aspect-ratio:${width}/${height};image-rendering:pixelated;background:#000`;
    document.title = project.meta.title;

    const bytes =
      config.embedded !== undefined
        ? createEmbeddedBytesSource(config.embedded.assets)
        : createHttpBytesSource(config.assetsUrl ?? new URL("../assets/", projectUrl).href, project.assets);
    const playerAudio = createPlayerAudio();
    const assets = createAssetSource(bytes, project.assets, {
      ...(playerAudio.decodeAudio === undefined ? {} : { decodeAudio: playerAudio.decodeAudio }),
    });
    const startMap = await projectSource.mapData(project.system.startMap);
    // 音を出せない環境では音声アセットは読み込まない（デコードできず、起動が止まってしまうため）
    const preloadIds = collectStartAssets(project, startMap).filter((id) => playerAudio.decodeAudio !== undefined || project.assets.entries[id]?.kind !== "audio");
    await assets.preload(preloadIds, (done, total) => screens.loading(`読み込み中… ${done}/${total}`));

    // セーブは project.meta.id ごとに分かれる。同じオリジンで複数のゲームを配るときは saveScope で保存先自体を分ける
    const scope = config.saveScope === undefined ? "" : `-${config.saveScope}`;
    const saves = createSaveRepository({
      projectId: project.meta.id,
      projectHash: await projectSource.projectHash(),
      dbName: `rpg-saves${scope}`,
      prefix: `rpg-save${scope}`,
    });

    const input = createBrowserInput(window, { gamepad: true });
    const logger = consoleLogger(debug);
    // プラグイン：プロジェクトが有効にしたものだけを読み込む。読み込めなくてもゲームは始める（警告だけ）
    const selection = selectPlugins(config.plugins ?? [], project.system.plugins);
    for (const w of selection.warnings) logger.warn(w);
    const registry = createPluginRegistry();
    await loadPlugins(selection.modules, registry, { logger, params: selection.params });
    const audio = playerAudio.connect(assets, logger);
    const rendererName = pickRenderer(config.renderer);
    canvas.dataset["renderer"] = rendererName; // 観測用（E2E とデバッグ）
    // `preserveDrawingBuffer` は、描いた内容をあとから読む（スクリーンショット・ピクセル確認）ために debug のときだけ有効にする
    const renderer: Renderer = rendererName === "webgl" ? createWebglRenderer(canvas, { pixelated: true, preserveDrawingBuffer: debug }) : createCanvas2dRenderer(canvas, { pixelated: true });
    const runtime = createRuntime({
      scheduler: createRafScheduler(),
      renderer,
      audio,
      input,
      assets,
      projectSource,
      saves,
      clock: Date.now,
      seed: String(Date.now()),
      logger,
      extensions: toRuntimeExtensions(registry, logger),
      onError: (e) => {
        input.dispose();
        audio.dispose();
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
