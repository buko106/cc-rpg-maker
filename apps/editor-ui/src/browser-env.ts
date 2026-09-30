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
 * Canvas2D レンダラ、ProjectRepository が持つアセットのバイト列、ブラウザ入力、rAF。
 * テストプレイの音は、この版では出さない（audio-null）。
 */
export function createBrowserEnv(): EditorEnv {
  const commands = createCommandRegistry();
  registerBuiltins(commands);
  const createAssets = (session: EditorSession) => createAssetSource(session.assetStore().bytesSource(), liveManifest(session), { verifyHash: true });
  return {
    commands,
    formOverrides: {},
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
