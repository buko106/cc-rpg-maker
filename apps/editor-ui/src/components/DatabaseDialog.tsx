import { applyOps, cmd } from "@rpg/editor-core";
import { actorSchema, classSchema, commonEventSchema, enemySchema, itemSchema, skillSchema, stateSchema, troopSchema } from "@rpg/schema";
import type { Database, EventCommand } from "@rpg/schema";
import { useMemo, useState } from "react";
import type { ReactElement } from "react";
import type { ZodType } from "zod";
import { FormEditor } from "../form-editor.js";
import { useFormContext } from "../form-context.js";
import { useSession } from "../hooks.js";
import { describeSchema } from "../schema-form/introspect.js";
import { defaultValue } from "../schema-form/values.js";
import { nextId } from "../next-id.js";
import { CommandList } from "./CommandList.js";
import { Dialog } from "./Dialog.js";
import { useExecute } from "./useExecute.js";

interface TableConfig {
  key: keyof Database;
  label: string;
  prefix: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schema: any;
  /** 追加するときの初期値（既定値の上書き） */
  initial?: Record<string, unknown>;
}

const TABLES: readonly TableConfig[] = [
  { key: "actors", label: "アクター", prefix: "actor", schema: actorSchema, initial: { name: "新しいアクター" } },
  { key: "classes", label: "職業", prefix: "class", schema: classSchema, initial: { name: "新しい職業" } },
  { key: "skills", label: "スキル", prefix: "sk", schema: skillSchema, initial: { name: "新しいスキル", formula: "a.atk * 2 - b.def" } },
  { key: "items", label: "アイテム", prefix: "item", schema: itemSchema, initial: { name: "新しいアイテム" } },
  { key: "enemies", label: "敵", prefix: "en", schema: enemySchema, initial: { name: "新しい敵" } },
  { key: "troops", label: "敵グループ", prefix: "tr", schema: troopSchema, initial: { name: "新しい敵グループ" } },
  { key: "states", label: "ステート", prefix: "st", schema: stateSchema, initial: { name: "新しいステート" } },
  { key: "commonEvents", label: "コモンイベント", prefix: "ce", schema: commonEventSchema, initial: { name: "新しいコモンイベント" } },
];

export { nextId };

/** コマンド列フィールドの編集ウィジェット（コモンイベント・敵グループのページ）。 */
function renderCommands(commands: EventCommand[], onChange: (next: EventCommand[]) => void): ReactElement {
  return (
    <CommandList commands={commands} onEdit={(ops) => onChange(applyOps(commands, ops))} />
  );
}

/** 1 件の編集。ID は主キーなので編集させず、残りの項目をスキーマから自動生成したフォームで編集する。 */
function EntityForm({ table, id }: { table: TableConfig; id: string }): ReactElement | null {
  const session = useSession();
  const ctx = useFormContext(renderCommands);
  const { run, dialog, error } = useExecute();
  const entity = (session.doc.project.database[table.key] as Record<string, Record<string, unknown>>)[id];
  const schema = useMemo(() => (table.schema as { omit(m: Record<string, true>): ZodType }).omit({ id: true }), [table]);
  if (entity === undefined) return null;
  const { id: _id, ...rest } = entity;
  return (
    <div className="entity-form">
      <h3>
        {String(entity["name"] ?? id)} <span className="muted">（{id}）</span>
      </h3>
      {error !== undefined && <p role="alert" className="notice error">{error}</p>}
      <FormEditor
        key={`${table.key}:${id}`}
        schema={schema}
        value={rest}
        ctx={ctx}
        label=""
        onCommit={(v) => run(cmd.upsertEntity(table.key, { ...(v as object), id } as never))}
      />
      {dialog}
    </div>
  );
}

/** データベースのダイアログ：タブごとに一覧（追加・削除）と、選んだ 1 件のフォーム。 */
export function DatabaseDialog({ onClose }: { onClose: () => void }): ReactElement {
  const session = useSession();
  const ctx = useFormContext();
  const { run, dialog, error } = useExecute((c) => c.label);
  const [tab, setTab] = useState<keyof Database>("actors");
  const [selected, setSelected] = useState<Partial<Record<keyof Database, string>>>({});
  const [problem, setProblem] = useState<string | undefined>();
  const table = TABLES.find((t) => t.key === tab)!;
  const records = session.doc.project.database[tab] as Record<string, { name: string }>;
  const current = selected[tab] !== undefined && Object.hasOwn(records, selected[tab]) ? selected[tab] : Object.keys(records)[0];

  const add = (): void => {
    const id = nextId(table.prefix, Object.keys(records));
    const spec = describeSchema((table.schema as { omit(m: Record<string, true>): ZodType }).omit({ id: true }));
    const draft = { id, ...(defaultValue(spec, ctx.refOptions) as object), ...table.initial };
    const parsed = (table.schema as ZodType).safeParse(draft);
    if (!parsed.success) {
      setProblem(`${table.label}を追加できません：${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("、")}`);
      return;
    }
    setProblem(undefined);
    if (run(cmd.upsertEntity(tab, parsed.data as never))) setSelected({ ...selected, [tab]: id });
  };

  return (
    <Dialog title="データベース" onClose={onClose} wide>
      <div role="tablist" aria-label="データベースの種類" className="tabs">
        {TABLES.map((t) => (
          <button key={t.key} role="tab" type="button" aria-selected={t.key === tab} onClick={() => { setTab(t.key); setProblem(undefined); }}>
            {t.label}
          </button>
        ))}
      </div>
      {(problem ?? error) !== undefined && <p role="alert" className="notice error">{problem ?? error}</p>}
      <div className="db-body" role="tabpanel" aria-label={table.label}>
        <div className="db-list">
          <ul aria-label={`${table.label}の一覧`}>
            {Object.values(records).map((e) => {
              const id = (e as unknown as { id: string }).id;
              return (
                <li key={id}>
                  <button type="button" aria-current={id === current} className={id === current ? "selected" : undefined} onClick={() => setSelected({ ...selected, [tab]: id })}>
                    {e.name === "" ? id : e.name}
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="db-actions">
            <button type="button" onClick={add}>
              ＋ 追加
            </button>
            <button type="button" disabled={current === undefined} onClick={() => current !== undefined && run(cmd.deleteEntity(tab, current))}>
              削除
            </button>
          </div>
        </div>
        <div className="db-form">{current === undefined ? <p className="muted">（まだありません）</p> : <EntityForm table={table} id={current} />}</div>
      </div>
      {dialog}
    </Dialog>
  );
}
