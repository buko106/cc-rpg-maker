import { createContext, useContext, useMemo, useSyncExternalStore } from "react";
import type { CommandRegistry } from "@rpg/core";
import { parse } from "@rpg/core";
import { cmd } from "@rpg/editor-core";
import type { EditorSession } from "@rpg/editor-core";
import type { SwitchId, VariableId } from "@rpg/schema";
import type { PlayerBundle } from "@rpg/exporter";
import type { CommandFormOverrideProps } from "./command-form.js";
import type { PluginEnv } from "./plugin-env.js";

export type { CommandFormOverrideProps } from "./command-form.js";
import type { ProjectRepository } from "@rpg/project-store";
import type { AssetSource, Renderer } from "@rpg/runtime";
import type { ComponentType } from "react";
import type { FormContext } from "./schema-form/SchemaForm.js";
import type { RefOptions } from "./schema-form/values.js";
import { nextId } from "./next-id.js";
import type { Playtest, PlaytestStart } from "./playtest.js";

/** エディタが外の世界に頼ること。具象アダプタはここ（composition root）でだけ作る。 */
export interface EditorEnv extends PluginEnv {
  commands: CommandRegistry;
  /** コマンドコード → 専用フォーム（無いコマンドは `params` の zod から自動生成） */
  formOverrides: Readonly<Record<string, ComponentType<CommandFormOverrideProps>>>; // プラグインのフォーム（`pluginForms`）を含む
  createRenderer(canvas: HTMLCanvasElement): Renderer;
  createAssets(session: EditorSession): AssetSource;
  startPlaytest(session: EditorSession, canvas: HTMLCanvasElement, start?: PlaytestStart): Promise<Playtest>;
  /** プレイヤー本体（`player.js`）を取る。配布物に同梱する。 */
  loadPlayerBundle(): Promise<PlayerBundle>;
  /** 書き出したファイルを利用者に渡す（ブラウザではダウンロードさせる）。 */
  saveFile(name: string, bytes: Uint8Array<ArrayBuffer>, mime: string): void;
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

/** 名前つきの ID 一覧（フォームの選択肢）。 */
function refOptionsOf(session: EditorSession): RefOptions {
  const { project } = session.doc;
  const db = project.database;
  const named = (table: Record<string, { name: string }>): { value: string; label: string }[] =>
    Object.entries(table).map(([value, e]) => ({ value, label: e.name === "" || e.name === value ? value : `${e.name}（${value}）` }));
  return (ref, assetKind) => {
    switch (ref) {
      case "actor": return named(db.actors);
      case "class": return named(db.classes);
      case "skill": return named(db.skills);
      case "item": return named(db.items);
      case "enemy": return named(db.enemies);
      case "troop": return named(db.troops);
      case "state": return named(db.states);
      case "commonEvent": return named(db.commonEvents);
      case "map": return named(project.maps);
      case "tileset": return named(project.tilesets);
      case "switch": return named(project.switches);
      case "variable": return named(project.variables);
      case "asset":
        return Object.entries(project.assets.entries)
          .filter(([, e]) => assetKind === undefined || e.kind === assetKind)
          .map(([value, e]) => ({ value, label: e.name }));
      default: return [];
    }
  };
}

/**
 * フォームの中でその場で作れる ID の種類：スイッチと変数。`sw_001` / `var_001` のような空いている連番で作り、
 * 直後の編集（作ったものを選ぶフォームの確定）と 1 回の Undo にまとめる（`groupWithNext`）。
 */
function newRefOf(session: EditorSession): NonNullable<FormContext["newRef"]> {
  return (ref) => {
    if (ref !== "switch" && ref !== "variable") return undefined;
    const isSwitch = ref === "switch";
    return {
      noun: isSwitch ? "スイッチ" : "変数",
      create(name) {
        const id = nextId(isSwitch ? "sw" : "var", Object.keys(session.doc.project[isSwitch ? "switches" : "variables"]));
        const c = isSwitch ? cmd.setSwitchName(id as SwitchId, name) : cmd.setVariableName(id as VariableId, name);
        return session.execute(c, { groupWithNext: true }).ok ? id : undefined;
      },
    };
  };
}

/** 式の文法エラーを返す（05 の `parse`）。 */
const checkFormula = (source: string): string | undefined => {
  const r = parse(source);
  return r.ok ? undefined : `${r.error.column} 文字目：${r.error.message}`;
};

/** 現在の文書に合わせたフォームの文脈。 */
export function useFormContext(renderCommands?: FormContext["renderCommands"]): FormContext {
  const session = useSession();
  const { project } = session.doc;
  // 選択肢は文書のうち ID を持つ部分にだけ依存する（version ごとに作り直しても害はないが、軽くしておく）
  return useMemo(
    () => ({ refOptions: refOptionsOf(session), checkFormula, newRef: newRefOf(session), ...(renderCommands === undefined ? {} : { renderCommands }) }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [project, renderCommands],
  );
}
