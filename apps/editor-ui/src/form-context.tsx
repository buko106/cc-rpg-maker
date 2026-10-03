import { parse } from "@rpg/core";
import { cmd, withRecentRef } from "@rpg/editor-core";
import type { EditorSession } from "@rpg/editor-core";
import type { SwitchId, VariableId } from "@rpg/schema";
import { useMemo } from "react";
import { MapPicker } from "./components/MapPicker.js";
import { useSession } from "./hooks.js";
import { nextId } from "./next-id.js";
import type { FormContext } from "./schema-form/SchemaForm.js";
import type { RefOptions } from "./schema-form/values.js";

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
    () => ({
      refOptions: refOptionsOf(session),
      checkFormula,
      newRef: newRefOf(session),
      recentRefs: (ref) => session.ui.recentRefs[ref] ?? [],
      onPickRef: (ref, id) => session.setUi({ recentRefs: withRecentRef(session.ui.recentRefs, ref, id) }),
      renderLocation: (props) => <MapPicker {...props} />,
      ...(renderCommands === undefined ? {} : { renderCommands }),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [project, renderCommands],
  );
}
