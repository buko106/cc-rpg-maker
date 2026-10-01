import { createAssetSource } from "@rpg/assets";
import { createNullAudioOut } from "@rpg/audio-null";
import { createCommandRegistry, registerBuiltins } from "@rpg/core";
import type { EditorSession } from "@rpg/editor-core";
import { createBrowserInput } from "@rpg/input-browser";
import { createCanvas2dRenderer } from "@rpg/render-canvas2d";
import type { PluginModule } from "@rpg/plugin-api";
import { samplePlugins } from "@rpg/plugin-samples";
import { writeZip } from "@rpg/project-store";
import type { AssetManifest } from "@rpg/runtime";
import type { EditorEnv, ProjectSample } from "./hooks.js";
import { createPluginEnv } from "./plugin-env.js";
import { startPlaytest } from "./playtest.js";
import { createRafScheduler } from "./raf-scheduler.js";

/** セッションのマニフェスト（アセットの登録が増減しても、常に最新を読む）。 */
const liveManifest = (session: EditorSession): AssetManifest => ({
  get entries() {
    return session.doc.project.assets.entries;
  },
});

/** `samples/index.json` の 1 件（エディタのビルド `build-web.mjs` が書く）。 */
interface SampleEntry {
  id: string;
  title: string;
  description: string;
  tags: string[];
  image?: string;
  /** サンプルのフォルダ（`samples/<id>/`）の中のファイル。 */
  files: string[];
}

/**
 * 同梱のサンプル（`<baseUrl>index.json` と `<baseUrl><id>/…`）を読む。一覧が無ければ（404）サンプルは無い。
 * サンプルはフォルダ形式（project.json + maps/ + assets/）で置かれていて、読むときに ZIP にまとめる。
 */
export function createSampleSource(baseUrl: string, fetchFn: typeof fetch = (input, init) => fetch(input, init)): Pick<EditorEnv, "listSamples" | "loadSample"> {
  let index: Promise<SampleEntry[]> | undefined;
  const entries = (): Promise<SampleEntry[]> =>
    (index ??= fetchFn(`${baseUrl}index.json`).then(async (res) => {
      if (res.status === 404) return [];
      if (!res.ok) throw new Error(`サンプルの一覧を取得できない（HTTP ${res.status}）`);
      return (await res.json()) as SampleEntry[];
    })).catch((e: unknown) => {
      index = undefined; // 次に開いたときに取り直す
      throw e;
    });
  return {
    async listSamples() {
      return (await entries()).map(
        ({ id, title, description, tags, image }): ProjectSample => ({ id, title, description, tags, ...(image === undefined ? {} : { imageUrl: `${baseUrl}${image}` }) }),
      );
    },
    async loadSample(id) {
      const entry = (await entries()).find((e) => e.id === id);
      if (entry === undefined) throw new Error(`サンプル「${id}」が無い`);
      const files = await Promise.all(
        entry.files.map(async (name) => {
          const res = await fetchFn(`${baseUrl}${id}/${name}`);
          if (!res.ok) throw new Error(`サンプルのファイル（${name}）を取得できない（HTTP ${res.status}）`);
          return { name, bytes: new Uint8Array(await res.arrayBuffer()) };
        }),
      );
      return writeZip(files);
    },
  };
}

/**
 * ブラウザ用の結線（composition root）。具象アダプタを作るのはここだけ：
 * Canvas2D レンダラ、ProjectRepository が持つアセットのバイト列、ブラウザ入力、rAF、配布物の書き出し（プレイヤー本体の取得とダウンロード）、
 * 同梱のサンプル（同じオリジンの `samples/`）。
 * テストプレイの音は、この版では出さない（audio-null）。
 */
export async function createBrowserEnv(options: { playerUrl?: string; samplesUrl?: string; plugins?: readonly PluginModule[] } = {}): Promise<EditorEnv> {
  const commands = createCommandRegistry();
  registerBuiltins(commands);
  const pluginEnv = await createPluginEnv(options.plugins ?? samplePlugins, commands, { debug() {}, info() {}, warn: (m) => console.warn(`[plugin] ${m}`), error: (m) => console.error(`[plugin] ${m}`) });
  const createAssets = (session: EditorSession) => createAssetSource(session.assetStore().bytesSource(), liveManifest(session), { verifyHash: true });
  return {
    ...pluginEnv,
    ...createSampleSource(options.samplesUrl ?? "samples/"),
    commands,
    formOverrides: pluginEnv.pluginForms,
    async loadPlayerBundle() {
      const url = options.playerUrl ?? "player/player.js";
      const res = await fetch(url);
      if (!res.ok) throw new Error(`プレイヤー本体（${url}）を取得できない（HTTP ${res.status}）`);
      return { js: await res.text() };
    },
    saveFile(name, bytes, mime) {
      const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    },
    createRenderer: (canvas) => createCanvas2dRenderer(canvas, { pixelated: true }),
    createAssets,
    startPlaytest: async (session, canvas, start) =>
      startPlaytest(
        session,
        {
          extensions: await pluginEnv.createExtensions(session.doc.project.system.plugins, { debug() {}, info() {}, warn: (m) => console.warn(`[playtest] ${m}`), error: (m) => console.error(`[playtest] ${m}`) }),
          scheduler: createRafScheduler(),
          renderer: createCanvas2dRenderer(canvas, { pixelated: true }),
          audio: createNullAudioOut(),
          input: createBrowserInput(window),
          assets: createAssets(session),
          logger: { debug() {}, info() {}, warn: (m) => console.warn(`[playtest] ${m}`), error: (m) => console.error(`[playtest] ${m}`) },
          onError: (e) => console.error("[playtest]", e),
        },
        start,
      ),
  };
}
