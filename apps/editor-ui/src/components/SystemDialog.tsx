import { cmd } from "@rpg/editor-core";
import { systemSettingsSchema } from "@rpg/schema";
import type { SwitchId, VariableId } from "@rpg/schema";
import { useState } from "react";
import type { ReactElement } from "react";
import { FormEditor } from "../form-editor.js";
import { useFormContext, useSession } from "../hooks.js";
import { Dialog } from "./Dialog.js";
import { useExecute } from "./useExecute.js";

type Named = "switches" | "variables";

/** スイッチ・変数の一覧：名前の変更、追加、削除（使われていれば確認）。 */
function NamedList({ table }: { table: Named }): ReactElement {
  const session = useSession();
  const { run, dialog, error } = useExecute();
  const [newId, setNewId] = useState("");
  const [newName, setNewName] = useState("");
  const noun = table === "switches" ? "スイッチ" : "変数";
  const records = session.doc.project[table] as Record<string, { name: string }>;
  const setName = (id: string, name: string): boolean => run(table === "switches" ? cmd.setSwitchName(id as SwitchId, name) : cmd.setVariableName(id as VariableId, name));
  const remove = (id: string): boolean => run(table === "switches" ? cmd.removeSwitch(id as SwitchId) : cmd.removeVariable(id as VariableId));
  const validId = /^[A-Za-z0-9_-]{1,64}$/.test(newId) && !Object.hasOwn(records, newId);

  return (
    <div className="named-list">
      {error !== undefined && <p role="alert" className="notice error">{error}</p>}
      <ul aria-label={`${noun}の一覧`}>
        {Object.entries(records).map(([id, v]) => (
          <li key={id}>
            <code>{id}</code>
            <input type="text" aria-label={`${id} の名前`} value={v.name} onChange={(e) => setName(id, e.target.value)} />
            <button type="button" aria-label={`${id} を削除`} onClick={() => remove(id)}>
              削除
            </button>
          </li>
        ))}
        {Object.keys(records).length === 0 && <li className="empty">（なし）</li>}
      </ul>
      <form
        className="named-add"
        onSubmit={(e) => {
          e.preventDefault();
          if (validId && setName(newId, newName)) {
            setNewId("");
            setNewName("");
          }
        }}
      >
        <input type="text" aria-label={`新しい${noun}のID`} placeholder="ID（英数字・_・-）" value={newId} onChange={(e) => setNewId(e.target.value)} />
        <input type="text" aria-label={`新しい${noun}の名前`} placeholder="名前" value={newName} onChange={(e) => setNewName(e.target.value)} />
        <button type="submit" disabled={!validId}>
          ＋ 追加
        </button>
      </form>
      {dialog}
    </div>
  );
}

/** システム設定：開始位置・初期パーティ・画面・BGM・用語、そしてスイッチと変数の名前。 */
export function SystemDialog({ onClose }: { onClose: () => void }): ReactElement {
  const session = useSession();
  const ctx = useFormContext();
  const { run, dialog, error } = useExecute();
  const [tab, setTab] = useState<"system" | "switches" | "variables">("system");
  const tabs = [
    ["system", "基本設定"],
    ["switches", "スイッチ"],
    ["variables", "変数"],
  ] as const;
  return (
    <Dialog title="システム" onClose={onClose} wide>
      <div role="tablist" aria-label="システムの項目" className="tabs">
        {tabs.map(([key, label]) => (
          <button key={key} role="tab" type="button" aria-selected={tab === key} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </div>
      {error !== undefined && <p role="alert" className="notice error">{error}</p>}
      <div role="tabpanel">
        {tab === "system" ? (
          <FormEditor schema={systemSettingsSchema} value={session.doc.project.system} ctx={ctx} label="" onCommit={(v) => run(cmd.setSystem(v))} />
        ) : (
          <NamedList table={tab} />
        )}
      </div>
      {dialog}
    </Dialog>
  );
}
