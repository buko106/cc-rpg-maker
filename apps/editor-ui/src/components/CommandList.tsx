import { createProjectView } from "@rpg/core";
import type { EventCommand } from "@rpg/schema";
import { useMemo, useState } from "react";
import type { KeyboardEvent, ReactElement } from "react";
import { BLOCK_PARTS, commandTemplate, insertionPoint, removalRange, syncChoiceBranches } from "../command-templates.js";
import type { CommandOp } from "../command-templates.js";
import { FormEditor } from "../form-editor.js";
import { useEnv, useFormContext, useSession } from "../hooks.js";
import { describeSchema } from "../schema-form/introspect.js";
import { defaultValue } from "../schema-form/values.js";
import { Dialog } from "./Dialog.js";

export interface CommandListProps {
  commands: readonly EventCommand[];
  /** 編集操作（挿入・削除・差し替え）を順に適用する。複数のときは 1 回の Undo で戻せるようにまとめる。 */
  onEdit(ops: CommandOp[]): void;
}

/** 追加できるコマンドの一覧（分岐の部品は、対になるコマンドと一緒に入るので出さない）。 */
function CommandPicker({ onPick, onClose }: { onPick: (code: string) => void; onClose: () => void }): ReactElement {
  const env = useEnv();
  const groups = new Map<string, { code: string; label: string }[]>();
  for (const h of env.commands.list()) {
    if (BLOCK_PARTS.has(h.code)) continue;
    const list = groups.get(h.meta.category) ?? [];
    list.push({ code: h.code, label: h.meta.label });
    groups.set(h.meta.category, list);
  }
  return (
    <Dialog title="コマンドの追加" onClose={onClose}>
      {[...groups].map(([category, items]) => (
        <section key={category} aria-label={category}>
          <h3>{category}</h3>
          <div className="picker-grid">
            {items.map((it) => (
              <button key={it.code} type="button" onClick={() => onPick(it.code)}>
                {it.label}
              </button>
            ))}
          </div>
        </section>
      ))}
    </Dialog>
  );
}

/** 1 コマンドの設定フォーム（`formOverrides` にあればそれ、無ければ params の zod から自動生成）。 */
export function CommandForm({ command, onCommit }: { command: EventCommand; onCommit: (params: Record<string, unknown>) => void }): ReactElement {
  const env = useEnv();
  const ctx = useFormContext();
  const handler = env.commands.get(command.code);
  if (handler === undefined) return <p role="alert">未知のコマンド {command.code} は編集できません。</p>;
  const Override = env.formOverrides[command.code];
  if (Override !== undefined) return <Override params={command.params} onCommit={onCommit} ctx={ctx} />;
  const parsed = handler.params.safeParse(command.params);
  return (
    <FormEditor
      key={command.code}
      schema={handler.params}
      value={parsed.success ? parsed.data : command.params}
      ctx={ctx}
      label=""
      onCommit={(params) => onCommit(params as Record<string, unknown>)}
    />
  );
}

/**
 * イベントコマンドのリスト。行を選んで「追加」「編集」「削除」する。
 * 矢印キーで行を移動、Enter で編集、Delete で削除。文書の変更は親が渡す `onInsert` などを通して行う。
 */
export function CommandList({ commands, onEdit }: CommandListProps): ReactElement {
  const env = useEnv();
  const session = useSession();
  const ctx = useFormContext();
  const [selected, setSelected] = useState<number | undefined>();
  const [picking, setPicking] = useState(false);
  const [editing, setEditing] = useState(false);
  const view = useMemo(() => createProjectView(session.doc.project, session.doc.maps), [session.doc.project, session.doc.maps]);

  const describe = (c: EventCommand): string => {
    const h = env.commands.get(c.code);
    if (h === undefined) return `？ ${c.code}`;
    const p = h.params.safeParse(c.params);
    return p.success ? h.meta.describe(p.data, view) : `${h.meta.label}（設定が不正）`;
  };

  const add = (code: string): void => {
    const h = env.commands.get(code);
    if (h === undefined) return;
    const point = insertionPoint(commands, selected);
    const raw = defaultValue(describeSchema(h.params), ctx.refOptions) ?? {};
    const parsed = h.params.safeParse(raw);
    onEdit([{ op: "insert", at: point.at, commands: commandTemplate(code, (parsed.success ? parsed.data : raw) as Record<string, unknown>, point.indent) }]);
    setSelected(point.at);
    setPicking(false);
    setEditing(true);
  };

  const remove = (): void => {
    if (selected === undefined) return;
    const range = removalRange(commands, selected);
    if (range === undefined) return;
    onEdit([{ op: "remove", at: range.at, count: range.count }]);
    setSelected(undefined);
    setEditing(false);
  };

  /** 設定フォームの確定。選択肢の数が変わったら、対になる分岐の数も合わせる。 */
  const commit = (index: number, command: EventCommand, params: Record<string, unknown>): void => {
    const next = { ...command, params };
    const sync = command.code === "ShowChoices" && Array.isArray(params["choices"]) ? syncChoiceBranches(commands, index, (params["choices"] as unknown[]).length) : [];
    onEdit([{ op: "replace", at: index, command: next }, ...sync]);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>): void => {
    if (e.target instanceof HTMLElement && e.target.closest(".command-editor") !== null) return;
    if (e.key === "ArrowDown") setSelected((s) => Math.min(commands.length - 1, (s ?? -1) + 1));
    else if (e.key === "ArrowUp") setSelected((s) => Math.max(0, (s ?? commands.length) - 1));
    else if (e.key === "Enter" && selected !== undefined) setEditing(true);
    else if (e.key === "Delete" && selected !== undefined) remove();
    else return;
    e.preventDefault();
  };

  const current = selected === undefined ? undefined : commands[selected];
  const removable = selected !== undefined && removalRange(commands, selected) !== undefined;
  return (
    <div className="command-list" onKeyDown={onKeyDown}>
      <ol role="listbox" aria-label="イベントコマンド" tabIndex={0} aria-activedescendant={selected === undefined ? undefined : `cmd-row-${selected}`}>
        {commands.map((c, i) => (
          <li
            key={i}
            id={`cmd-row-${i}`}
            role="option"
            aria-selected={selected === i}
            className={selected === i ? "selected" : undefined}
            style={{ paddingLeft: `${c.indent * 18 + 8}px` }}
            onClick={() => setSelected(i)}
            onDoubleClick={() => {
              setSelected(i);
              setEditing(true);
            }}
          >
            {describe(c)}
          </li>
        ))}
        {commands.length === 0 && <li className="empty">（コマンドなし）</li>}
      </ol>
      <div className="command-actions">
        <button type="button" onClick={() => setPicking(true)}>
          コマンドを追加…
        </button>
        <button type="button" disabled={current === undefined} onClick={() => setEditing((v) => !v)}>
          {editing ? "編集を閉じる" : "編集"}
        </button>
        <button type="button" disabled={!removable} onClick={remove}>
          削除
        </button>
      </div>
      {picking && <CommandPicker onPick={add} onClose={() => setPicking(false)} />}
      {editing && current !== undefined && selected !== undefined && (
        <div className="command-editor" aria-label="コマンドの設定">
          <h4>{env.commands.get(current.code)?.meta.label ?? current.code}</h4>
          <CommandForm command={current} onCommit={(params) => commit(selected, current, params)} />
        </div>
      )}
    </div>
  );
}
