import { cmd } from "@rpg/editor-core";
import type { EventTemplate } from "@rpg/editor-core";
import { newId } from "@rpg/schema";
import type { EventId, MapId } from "@rpg/schema";
import { useMemo, useState } from "react";
import type { ReactElement } from "react";
import { useFormContext } from "../form-context.js";
import { IssueList } from "../form-editor.js";
import { useSession } from "../hooks.js";
import type { Cell } from "../map/project-map.js";
import { describeSchema } from "../schema-form/introspect.js";
import { SchemaForm } from "../schema-form/SchemaForm.js";
import { defaultValue } from "../schema-form/values.js";
import { Dialog } from "./Dialog.js";
import { useExecute } from "./useExecute.js";

/**
 * ひな形からイベントを作るダイアログ。ひな形の入力（`template.input` の zod から作ったフォーム）を埋めて「作成」すると、
 * `cell` にイベントを置いて選ぶ（`cmd.createEventFromTemplate`。1 回の Undo で消える）。入力が正しくない間は作成できない。
 * 入力の下書きは文書には入れない（やめれば何も残らない）。
 */
export function EventTemplateDialog({
  template,
  mapId,
  cell,
  onClose,
  onOpenEvent,
}: {
  template: EventTemplate;
  mapId: MapId;
  cell: Cell;
  onClose: () => void;
  /** 「作成して編集…」で、作ったイベントの編集画面を開く */
  onOpenEvent: (eventId: EventId) => void;
}): ReactElement {
  const session = useSession();
  const ctx = useFormContext();
  const { run, dialog, error } = useExecute();
  const spec = useMemo(() => describeSchema(template.input), [template]);
  const [draft, setDraft] = useState<unknown>(() => {
    const base = defaultValue(spec, ctx.refOptions);
    let initial: Record<string, unknown> | undefined;
    try {
      initial = template.initial?.(session.doc.project);
    } catch {
      initial = undefined; // プラグインのひな形の誤りでダイアログを壊さない（既定値のまま）
    }
    return { ...(typeof base === "object" && base !== null ? base : {}), ...initial };
  });
  const parsed = template.input.safeParse(draft);

  const create = (open: boolean): void => {
    if (!parsed.success) return;
    const id = newId<"EventId">("ev");
    if (!run(cmd.createEventFromTemplate(mapId, cell.x, cell.y, template, draft, id))) return;
    session.setUi({ selection: { kind: "event", eventId: id } });
    onClose();
    if (open) onOpenEvent(id);
  };

  return (
    <Dialog title={`ひな形から作成：${template.label}`} onClose={onClose} wide>
      <p className="muted">
        {template.description}　（置く位置：({cell.x}, {cell.y})）
      </p>
      <SchemaForm spec={spec} value={draft} ctx={ctx} label="" onChange={setDraft}>
        {!parsed.success && <IssueList issues={parsed.error.issues} value={draft} spec={spec} />}
      </SchemaForm>
      {error !== undefined && (
        <p role="alert" className="notice error">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <button type="button" className="primary" disabled={!parsed.success} onClick={() => create(false)}>
          作成
        </button>
        <button type="button" disabled={!parsed.success} onClick={() => create(true)}>
          作成して編集…
        </button>
        <button type="button" onClick={onClose}>
          やめる
        </button>
      </div>
      {dialog}
    </Dialog>
  );
}
