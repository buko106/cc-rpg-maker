import { createCommandRegistry, registerBuiltins } from "@rpg/core";
import { createEditorSession } from "@rpg/editor-core";
import type { EditorSession, EditorSessionDeps } from "@rpg/editor-core";
import { createMemoryProjectRepository } from "@rpg/project-store";
import type { ProjectRepository } from "@rpg/project-store";
import { createNullRenderer } from "@rpg/render-null";
import type { ImageHandle } from "@rpg/runtime";
import type { ReactElement, ReactNode } from "react";
import type { PluginModule } from "@rpg/plugin-api";
import { EnvContext, RepoContext, SessionContext } from "./hooks.js";
import { createPluginEnv } from "./plugin-env.js";
import type { EditorEnv } from "./hooks.js";

// jsdom には Canvas の実装が無い（getContext が「未実装」と騒ぐ）ので、描画しない前提で null を返す。
if (typeof HTMLCanvasElement !== "undefined") {
  HTMLCanvasElement.prototype.getContext = (() => null) as unknown as typeof HTMLCanvasElement.prototype.getContext;
}

// jsdom には PointerEvent も無い。座標つきのポインタイベントを送れるように、MouseEvent を元に用意する。
if (typeof globalThis.PointerEvent === "undefined" && typeof MouseEvent !== "undefined") {
  class TestPointerEvent extends MouseEvent {
    readonly pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
    }
  }
  (globalThis as unknown as { PointerEvent: unknown }).PointerEvent = TestPointerEvent;
}

// jsdom の Blob / File には arrayBuffer() が無いことがある。FileReader で代用する。
if (typeof Blob !== "undefined" && typeof Blob.prototype.arrayBuffer !== "function") {
  Blob.prototype.arrayBuffer = function (this: Blob): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(this);
    });
  };
}

/**
 * コンポーネントのテスト用の環境：メモリ上のリポジトリ、null のレンダラ、組み込みコマンド入りのレジストリ。
 * `startPlaytest` は呼ばれた内容を記録するだけ。
 */
export interface TestEnv {
  env: EditorEnv;
  repo: ProjectRepository;
  session: EditorSession;
  playtests: { canvas: HTMLCanvasElement; start: unknown }[];
  /** `saveFile` に渡されたファイル。 */
  saved: { name: string; bytes: Uint8Array<ArrayBuffer>; mime: string }[];
  /** `session` と `env` を渡した状態で描く。 */
  wrap(children: ReactNode): ReactElement;
}

export async function createTestEnv(opts: { session?: Partial<EditorSessionDeps>; plugins?: readonly PluginModule[] } = {}): Promise<TestEnv> {
  const repo = createMemoryProjectRepository();
  const commands = createCommandRegistry();
  registerBuiltins(commands);
  const playtests: TestEnv["playtests"] = [];
  const saved: TestEnv["saved"] = [];
  const pluginEnv = await createPluginEnv(opts.plugins ?? [], commands);
  const env: EditorEnv = {
    ...pluginEnv,
    loadPlayerBundle: () => Promise.resolve({ js: "/* player */" }),
    saveFile: (name, bytes, mime) => void saved.push({ name, bytes, mime }),
    commands,
    formOverrides: pluginEnv.pluginForms,
    createRenderer: () => createNullRenderer(),
    createAssets: () => ({
      loadImage: () => Promise.resolve({} as ImageHandle),
      loadAudio: () => Promise.reject(new Error("音声は使わない")),
      loadJson: () => Promise.reject(new Error("JSON は使わない")),
      has: () => Promise.resolve(true),
    }),
    startPlaytest: (_session, canvas, start) => {
      playtests.push({ canvas, start });
      return Promise.resolve({ runtime: { getState: () => ({}) } as never, stop: () => {} });
    },
  };
  const doc = await repo.create("テスト");
  const session = createEditorSession({ repo, doc, commands, diagnostics: pluginEnv.pluginDiagnostics, ...opts.session });
  return {
    env,
    repo,
    session,
    playtests,
    saved,
    wrap: (children) => (
      <EnvContext.Provider value={env}>
        <RepoContext.Provider value={repo}>
          <SessionContext.Provider value={session}>{children}</SessionContext.Provider>
        </RepoContext.Provider>
      </EnvContext.Provider>
    ),
  };
}
