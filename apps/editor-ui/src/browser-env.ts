import { createAssetSource } from "@rpg/assets";
import { createNullAudioOut } from "@rpg/audio-null";
import { createCommandRegistry, registerBuiltins } from "@rpg/core";
import type { EditorSession } from "@rpg/editor-core";
import { createBrowserInput } from "@rpg/input-browser";
import { createCanvas2dRenderer } from "@rpg/render-canvas2d";
import type { AssetManifest } from "@rpg/runtime";
import type { EditorEnv } from "./hooks.js";
import { startPlaytest } from "./playtest.js";
import { createRafScheduler } from "./raf-scheduler.js";

/** セッションのマニフェスト（アセットの登録が増減しても、常に最新を読む）。 */
const liveManifest = (session: EditorSession): AssetManifest => ({
  get entries() {
    return session.doc.project.assets.entries;
  },
});

/**
 * ブラウザ用の結線（composition root）。具象アダプタを作るのはここだけ：
 * Canvas2D レンダラ、ProjectRepository が持つアセットのバイト列、ブラウザ入力、rAF、配布物の書き出し（プレイヤー本体の取得とダウンロード）。
 * テストプレイの音は、この版では出さない（audio-null）。
 */
export function createBrowserEnv(options: { playerUrl?: string } = {}): EditorEnv {
  const commands = createCommandRegistry();
  registerBuiltins(commands);
  const createAssets = (session: EditorSession) => createAssetSource(session.assetStore().bytesSource(), liveManifest(session), { verifyHash: true });
  return {
    commands,
    formOverrides: {},
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
    startPlaytest: (session, canvas, start) =>
      startPlaytest(
        session,
        {
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
