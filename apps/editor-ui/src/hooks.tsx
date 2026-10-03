import { createContext, useContext, useMemo, useSyncExternalStore } from "react";
import type { CommandRegistry } from "@rpg/core";
import { BUILTIN_EVENT_TEMPLATES } from "@rpg/editor-core";
import type { EditorSession, EventTemplate } from "@rpg/editor-core";
import type { PlayerBundle } from "@rpg/exporter";
import type { CommandFormOverrideProps } from "./command-form.js";
import type { PluginEnv } from "./plugin-env.js";

export type { CommandFormOverrideProps } from "./command-form.js";
import type { ProjectRepository } from "@rpg/project-store";
import type { AssetSource, Renderer } from "@rpg/runtime";
import type { ComponentType } from "react";
import type { Playtest, PlaytestStart } from "./playtest.js";

/** プロジェクト一覧の「サンプルから作る」に並ぶサンプル（デモの編集データ）。 */
export interface ProjectSample {
  id: string;
  title: string;
  description: string;
  tags: readonly string[];
  /** 一覧に出す画面写真の URL。 */
  imageUrl?: string;
}

/** エディタが外の世界に頼ること。具象アダプタはここ（composition root）でだけ作る。 */
export interface EditorEnv extends PluginEnv {
  commands: CommandRegistry;
  /** コマンドコード → 専用フォーム（無いコマンドは `params` の zod から自動生成） */
  formOverrides: Readonly<Record<string, ComponentType<CommandFormOverrideProps>>>; // プラグインのフォーム（`pluginForms`）を含む
  createRenderer(canvas: HTMLCanvasElement): Renderer;
  createAssets(session: EditorSession): AssetSource;
  /** `padRoot` があり、指が主入力の端末なら、そこにタッチの操作パッドを出す（`stop` で外す）。 */
  startPlaytest(session: EditorSession, canvas: HTMLCanvasElement, start?: PlaytestStart, padRoot?: HTMLElement): Promise<Playtest>;
  /** プレイヤー本体（`player.js`）を取る。配布物に同梱する。 */
  loadPlayerBundle(): Promise<PlayerBundle>;
  /** 書き出したファイルを利用者に渡す（ブラウザではダウンロードさせる）。 */
  saveFile(name: string, bytes: Uint8Array<ArrayBuffer>, mime: string): void;
  /** 同梱されているサンプルの一覧（無ければ空）。 */
  listSamples(): Promise<readonly ProjectSample[]>;
  /** サンプルの編集データを、`ProjectRepository.importZip` で読める ZIP にして返す。 */
  loadSample(id: string): Promise<Uint8Array<ArrayBuffer>>;
}

export const EnvContext = createContext<EditorEnv | null>(null);
export const SessionContext = createContext<EditorSession | null>(null);
export const RepoContext = createContext<ProjectRepository | null>(null);

export function useEnv(): EditorEnv {
  const env = useContext(EnvContext);
  if (env === null) throw new Error("EnvContext の外で使われた");
  return env;
}

/** プロジェクトの保存先（配布物の書き出しなど、セッションの外から読むときに使う）。 */
export function useRepo(): ProjectRepository {
  const repo = useContext(RepoContext);
  if (repo === null) throw new Error("RepoContext の外で使われた");
  return repo;
}

/** セッションを読む。変更のたびに再描画される。 */
export function useSession(): EditorSession {
  const session = useContext(SessionContext);
  if (session === null) throw new Error("SessionContext の外で使われた");
  useSyncExternalStore(session.subscribe, () => session.version);
  return session;
}

/** 置けるイベントのひな形：組み込み（話しかける人・扉・宝箱・商人・敵シンボル）と、プラグインが足したもの。 */
export function useEventTemplates(): readonly EventTemplate[] {
  const env = useEnv();
  return useMemo(() => [...BUILTIN_EVENT_TEMPLATES, ...env.pluginEventTemplates], [env]);
}
