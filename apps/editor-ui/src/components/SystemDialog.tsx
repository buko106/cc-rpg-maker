import { cmd } from "@rpg/editor-core";
import { systemSettingsSchema } from "@rpg/schema";
import type { SwitchId, SystemSettings, VariableId } from "@rpg/schema";
import { useState } from "react";
import type { ReactElement } from "react";
import { FormEditor } from "../form-editor.js";
import { useFormContext } from "../form-context.js";
import { useEnv, useSession } from "../hooks.js";
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

type PluginRef = SystemSettings["plugins"][number];

/** 設定（`params`）の JSON 欄。有効な JSON のオブジェクトのときだけ確定する。 */
function ParamsField({ id, value, onCommit }: { id: string; value: Record<string, unknown>; onCommit: (v: Record<string, unknown>) => void }): ReactElement {
  const [text, setText] = useState(JSON.stringify(value));
  const parsed = ((): Record<string, unknown> | undefined => {
    try {
      const v: unknown = JSON.parse(text);
      return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  })();
  return (
    <input
      type="text"
      aria-label={`${id} の設定（JSON）`}
      aria-invalid={parsed === undefined}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        try {
          const v: unknown = JSON.parse(e.target.value);
          if (typeof v === "object" && v !== null && !Array.isArray(v)) onCommit(v as Record<string, unknown>);
        } catch {
          // 書きかけ。確定しない
        }
      }}
    />
  );
}

/** プラグインの有効・無効と設定。ビルドに入っているプラグインから選ぶ。 */
function PluginsTab(): ReactElement {
  const env = useEnv();
  const session = useSession();
  const { run, dialog, error } = useExecute();
  const refs = session.doc.project.system.plugins;
  const set = (next: PluginRef[]): boolean => run(cmd.setSystem({ plugins: next }));
  const unknown = refs.filter((r) => !env.pluginCatalog.some((m) => m.name === r.name));
  return (
    <div className="plugins">
      {error !== undefined && <p role="alert" className="notice error">{error}</p>}
      {env.pluginFailures.length > 0 && (
        <p role="alert" className="notice error">
          読み込めなかったプラグイン：{env.pluginFailures.map((f) => f.name).join("、")}
        </p>
      )}
      <ul aria-label="プラグインの一覧" className="asset-list">
        {env.pluginCatalog.map((m) => {
          const ref = refs.find((r) => r.name === m.name);
          return (
            <li key={m.name}>
              <label className="check">
                <input
                  type="checkbox"
                  aria-label={`${m.name} を有効にする`}
                  checked={ref !== undefined}
                  onChange={(e) => set(e.target.checked ? [...refs, { name: m.name, version: m.version, params: {} }] : refs.filter((r) => r.name !== m.name))}
                />
                <code>{m.name}</code> <span className="muted">{m.version}</span>
              </label>
              {ref !== undefined && <ParamsField key={m.name + JSON.stringify(ref.params)} id={m.name} value={ref.params} onCommit={(params) => set(refs.map((r) => (r.name === m.name ? { ...r, params } : r)))} />}
            </li>
          );
        })}
        {env.pluginCatalog.length === 0 && <li className="empty">（このビルドにはプラグインが入っていない）</li>}
      </ul>
      {unknown.length > 0 && (
        <div>
          <h4>このビルドに入っていないプラグイン</h4>
          <ul aria-label="入っていないプラグイン">
            {unknown.map((r) => (
              <li key={r.name}>
                <code>{r.name}</code> <span className="muted">{r.version}</span>
                <button type="button" aria-label={`${r.name} を一覧から外す`} onClick={() => set(refs.filter((x) => x.name !== r.name))}>
                  外す
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {dialog}
    </div>
  );
}

/** システム設定：開始位置・初期パーティ・画面・BGM・用語、そしてスイッチと変数の名前。 */
export function SystemDialog({ onClose }: { onClose: () => void }): ReactElement {
  const session = useSession();
  const ctx = useFormContext();
  const { run, dialog, error } = useExecute();
  const [tab, setTab] = useState<"system" | "switches" | "variables" | "plugins">("system");
  const tabs = [
    ["system", "基本設定"],
    ["switches", "スイッチ"],
    ["variables", "変数"],
    ["plugins", "プラグイン"],
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
        ) : tab === "plugins" ? (
          <PluginsTab />
        ) : (
          <NamedList table={tab} />
        )}
      </div>
      {dialog}
    </Dialog>
  );
}
