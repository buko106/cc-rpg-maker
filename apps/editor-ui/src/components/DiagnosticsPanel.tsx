import type { MapId, EventId } from "@rpg/schema";
import type { ReactElement } from "react";
import { useSession } from "../hooks.js";
import { Dialog } from "./Dialog.js";

/** 整合性チェックの結果。項目を押すと、その場所（マップ・イベント）を開く。 */
export function DiagnosticsPanel({ onClose, onOpenEvent }: { onClose: () => void; onOpenEvent: (mapId: MapId, eventId: EventId) => void }): ReactElement {
  const session = useSession();
  const found = session.validate();
  const errors = found.filter((d) => d.severity === "error").length;
  return (
    <Dialog title="診断" onClose={onClose} wide>
      <p role="status">
        {found.length === 0 ? "問題は見つかりませんでした。" : `エラー ${errors} 件、警告 ${found.length - errors} 件`}
      </p>
      <ul className="diagnostics" aria-label="診断結果">
        {found.map((d, i) => {
          const loc = d.location;
          const jump = loc?.mapId !== undefined;
          return (
            <li key={i} className={d.severity}>
              <span className="badge">{d.severity === "error" ? "エラー" : "警告"}</span>
              <span>{d.message}</span>
              {jump && (
                <button
                  type="button"
                  onClick={() => {
                    const mapId = loc.mapId as MapId;
                    session.setUi({ currentMap: mapId, selection: loc.eventId === undefined ? { kind: "none" } : { kind: "event", eventId: loc.eventId as EventId } });
                    if (loc.eventId !== undefined) onOpenEvent(mapId, loc.eventId as EventId);
                  }}
                >
                  開く
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </Dialog>
  );
}
