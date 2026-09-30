import { cmd, defaultPage, WANDER_ROUTE } from "@rpg/editor-core";
import { eventPageSchema, moveRouteSchema } from "@rpg/schema";
import type { EventId, EventPage, MapId } from "@rpg/schema";
import { useCallback, useMemo, useState } from "react";
import type { ReactElement } from "react";
import type { z } from "zod";
import { FormEditor } from "../form-editor.js";
import { useFormContext } from "../form-context.js";
import { useSession } from "../hooks.js";
import { CommandList } from "./CommandList.js";
import { Dialog } from "./Dialog.js";
import { useExecute } from "./useExecute.js";

/** ページの設定（条件・グラフィック・起動条件など）。コマンド列は専用のリストで編集する。 */
const pageSettingsSchema = eventPageSchema.omit({ commands: true, moveRoute: true });
type PageSettings = z.infer<typeof pageSettingsSchema>;

/**
 * イベントの編集ダイアログ：名前、ページ（タブ）、ページの設定、コマンドリスト。
 * 文書の変更はすべて `session.execute`（`setEventPage` / `insertCommands` など）を通す。
 */
export function EventDialog({ mapId, eventId, onClose }: { mapId: MapId; eventId: EventId; onClose: () => void }): ReactElement | null {
  const session = useSession();
  const { run, dialog, error } = useExecute();
  const [pageIndex, setPageIndex] = useState(0);
  const event = session.doc.maps[mapId]?.events[eventId];
  const ctx = useFormContext();

  const page = event?.pages[pageIndex] ?? event?.pages[0];
  const index = event?.pages[pageIndex] === undefined ? 0 : pageIndex;

  const settings = useMemo<PageSettings | undefined>(() => {
    if (page === undefined) return undefined;
    const { commands: _c, moveRoute: _m, ...rest } = page;
    return rest;
  }, [page]);

  const commit = useCallback(
    (next: PageSettings) => {
      if (page === undefined) return;
      const merged: EventPage = { ...page, ...next };
      // graphic は省略できる項目なので、消えたら外す
      if (next.graphic === undefined) delete (merged as { graphic?: unknown }).graphic;
      run(cmd.setEventPage(mapId, eventId, index, merged));
    },
    [page, run, mapId, eventId, index],
  );

  if (event === undefined || page === undefined || settings === undefined) return null;
  const pages = event.pages;

  return (
    <Dialog title={`イベント：${event.name}`} onClose={onClose} wide>
      <div className="event-header">
        <label>
          名前
          <input type="text" value={event.name} onChange={(e) => run(cmd.setEventName(mapId, eventId, e.target.value))} />
        </label>
        <span className="muted">
          位置 ({event.x}, {event.y})
        </span>
        <button
          type="button"
          className="danger"
          onClick={() => {
            if (run(cmd.deleteEvent(mapId, eventId))) onClose();
          }}
        >
          イベントを削除
        </button>
      </div>
      {error !== undefined && <p role="alert" className="notice error">{error}</p>}

      <div role="tablist" aria-label="イベントページ" className="tabs">
        {pages.map((_, i) => (
          <button key={i} role="tab" type="button" aria-selected={i === index} onClick={() => setPageIndex(i)}>
            ページ {i + 1}
          </button>
        ))}
        <button
          type="button"
          onClick={() => {
            if (run(cmd.setEventPage(mapId, eventId, pages.length, defaultPage()))) setPageIndex(pages.length);
          }}
        >
          ＋ ページ追加
        </button>
        <button
          type="button"
          disabled={pages.length <= 1}
          onClick={() => {
            if (run(cmd.removeEventPage(mapId, eventId, index))) setPageIndex(Math.max(0, index - 1));
          }}
        >
          このページを削除
        </button>
      </div>

      <div role="tabpanel" aria-label={`ページ ${index + 1}`} className="event-page">
        <details open className="page-settings">
          <summary>ページの設定</summary>
          <FormEditor key={`${eventId}:${index}`} schema={pageSettingsSchema} value={settings} ctx={ctx} label="" onCommit={commit} />
        </details>
        <details open className="page-settings">
          <summary>自律移動（ページが有効な間、勝手に動く）</summary>
          <label>
            <input
              type="checkbox"
              checked={page.moveRoute !== undefined}
              onChange={(e) => {
                const { moveRoute: _m, ...rest } = page;
                run(cmd.setEventPage(mapId, eventId, index, e.target.checked ? { ...rest, moveRoute: WANDER_ROUTE } : rest));
              }}
            />{" "}
            自律移動する
          </label>
          {page.moveRoute !== undefined && (
            <FormEditor key={`${eventId}:${index}:route`} schema={moveRouteSchema} value={page.moveRoute} ctx={ctx} label="" onCommit={(moveRoute) => run(cmd.setEventPage(mapId, eventId, index, { ...page, moveRoute }))} />
          )}
        </details>
        <h3>コマンド</h3>
        <CommandList
          commands={page.commands}
          onEdit={(ops, label) => {
            const edits = ops.map((o) =>
              o.op === "insert" ? cmd.insertCommands(mapId, eventId, index, o.at, o.commands) : o.op === "remove" ? cmd.removeCommands(mapId, eventId, index, o.at, o.count) : cmd.replaceCommand(mapId, eventId, index, o.at, o.command),
            );
            // 1 つなら（入力中の文字のまとめなど）そのまま、複数か見出しがあれば 1 回の Undo で戻せるようにまとめる
            run(edits.length === 1 && label === undefined ? edits[0]! : cmd.batch(label ?? "コマンドの編集", edits));
          }}
        />
      </div>
      {dialog}
    </Dialog>
  );
}
