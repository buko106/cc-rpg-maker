import type { EventId, MapId } from "@rpg/schema";
import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import { useSession } from "../hooks.js";
import { planEventStart } from "../playtest.js";
import type { PlaytestStart } from "../playtest.js";
import type { PlaytestEventInfo } from "./PlaytestPanel.js";
import { AssetBrowser } from "./AssetBrowser.js";
import { DatabaseDialog } from "./DatabaseDialog.js";
import { DiagnosticsPanel } from "./DiagnosticsPanel.js";
import { EventDialog } from "./EventDialog.js";
import { ExportDialog } from "./ExportDialog.js";
import { MapCanvas } from "./MapCanvas.js";
import { MapTree } from "./MapTree.js";
import { PlaytestPanel } from "./PlaytestPanel.js";
import { SystemDialog } from "./SystemDialog.js";
import { TilePalette } from "./TilePalette.js";
import { ToolBar } from "./ToolBar.js";

type Dialog = { kind: "database" | "system" | "assets" | "diagnostics" | "export" } | { kind: "event"; mapId: MapId; eventId: EventId } | { kind: "playtest"; start?: PlaytestStart; event?: PlaytestEventInfo };

function saveText(session: ReturnType<typeof useSession>): string {
  const s = session.saveStatus;
  if (s.kind === "saving") return "保存中…";
  if (s.kind === "error") return `保存に失敗しました（${s.error.kind}）`;
  if (s.kind === "conflict") return "他の場所で更新されています";
  return session.dirty ? "未保存の変更あり" : "保存済み";
}

/** エディタの画面全体：メニューバー、左（マップ・タイル）、中央（キャンバス）、ダイアログ。 */
export function Shell({ onExit }: { onExit: () => void }): ReactElement {
  const session = useSession();
  const [dialog, setDialog] = useState<Dialog | undefined>();
  const [grid, setGrid] = useState(true);
  /** 複数ページのイベントで、テストプレイに使うページ（0 始まり）。 */
  const [pageChoice, setPageChoice] = useState(0);

  // どの画面からでも Ctrl+Z / Ctrl+Shift+Z（Ctrl+Y）/ Ctrl+S が session に届く。テストプレイ中はゲームに任せる。
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (dialog?.kind === "playtest" || !(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      if (key === "z" && !e.shiftKey) session.undo();
      else if ((key === "z" && e.shiftKey) || key === "y") session.redo();
      else if (key === "s") void session.save();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [session, dialog?.kind]);

  // 未保存のまま閉じようとしたら確認する
  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent): void => {
      if (!session.dirty) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [session]);

  const { ui, doc } = session;
  const map = ui.currentMap === undefined ? undefined : doc.maps[ui.currentMap];
  const selectedEvent = ui.selection.kind === "event" ? map?.events[ui.selection.eventId] : undefined;
  const status = session.saveStatus;

  return (
    <div className="shell">
      <header className="menubar" role="banner">
        <button type="button" onClick={onExit}>
          ← プロジェクト一覧
        </button>
        <strong className="project-name">{doc.project.meta.title}</strong>
        <span className="spacer" />
        <button type="button" disabled={!session.canUndo} onClick={() => session.undo()} title={session.undoLabel === undefined ? undefined : `元に戻す：${session.undoLabel}（Ctrl+Z）`}>
          元に戻す
        </button>
        <button type="button" disabled={!session.canRedo} onClick={() => session.redo()} title={session.redoLabel === undefined ? undefined : `やり直す：${session.redoLabel}（Ctrl+Shift+Z）`}>
          やり直す
        </button>
        <button type="button" onClick={() => setDialog({ kind: "database" })}>データベース</button>
        <button type="button" onClick={() => setDialog({ kind: "system" })}>システム</button>
        <button type="button" onClick={() => setDialog({ kind: "assets" })}>アセット</button>
        <button type="button" onClick={() => setDialog({ kind: "diagnostics" })}>診断</button>
        <button type="button" onClick={() => setDialog({ kind: "export" })}>配布物を書き出す…</button>
        <button type="button" className="primary" onClick={() => void session.save()}>保存</button>
        <span role="status" className={status.kind === "error" || status.kind === "conflict" ? "save-status error" : "save-status"}>{saveText(session)}</span>
        {status.kind === "conflict" && (
          <button type="button" className="danger" onClick={() => void session.save({ overwrite: true })}>
            上書き保存
          </button>
        )}
        <button type="button" onClick={() => setDialog({ kind: "playtest" })}>テストプレイ</button>
        {selectedEvent !== undefined && selectedEvent.pages.length > 1 && (
          <label className="page-pick">
            ページ
            <select value={pageChoice} onChange={(e) => setPageChoice(Number(e.target.value))} aria-label="テストプレイで動かすページ">
              {selectedEvent.pages.map((_, i) => (
                <option key={i} value={i}>
                  {i + 1}
                </option>
              ))}
            </select>
          </label>
        )}
        <button
          type="button"
          disabled={map === undefined || selectedEvent === undefined}
          title="選択中のイベントのページの条件を満たして、そのイベントの隣から始めます"
          onClick={() => {
            if (map === undefined || selectedEvent === undefined) return;
            const pageIndex = Math.min(pageChoice, selectedEvent.pages.length - 1);
            const plan = planEventStart(doc.project, map, selectedEvent, pageIndex);
            setDialog({ kind: "playtest", start: plan.start, event: { name: selectedEvent.name, page: pageIndex, ...(plan.shadowedBy === undefined ? {} : { shadowedBy: plan.shadowedBy }) } });
          }}
        >
          選択イベントからテストプレイ
        </button>
      </header>

      <aside className="sidebar">
        <MapTree />
        <TilePalette />
      </aside>

      <main className="workspace">
        <ToolBar grid={grid} onGrid={setGrid} />
        <MapCanvas grid={grid} onOpenEvent={(eventId) => ui.currentMap !== undefined && setDialog({ kind: "event", mapId: ui.currentMap, eventId })} />
        {selectedEvent !== undefined && ui.currentMap !== undefined && (
          <div className="selection-bar">
            イベント「{selectedEvent.name}」({selectedEvent.x}, {selectedEvent.y})
            <button type="button" onClick={() => setDialog({ kind: "event", mapId: ui.currentMap!, eventId: selectedEvent.id })}>
              イベントを編集…
            </button>
          </div>
        )}
      </main>

      {dialog?.kind === "database" && <DatabaseDialog onClose={() => setDialog(undefined)} />}
      {dialog?.kind === "system" && <SystemDialog onClose={() => setDialog(undefined)} />}
      {dialog?.kind === "export" && <ExportDialog onClose={() => setDialog(undefined)} />}
      {dialog?.kind === "assets" && <AssetBrowser onClose={() => setDialog(undefined)} />}
      {dialog?.kind === "diagnostics" && <DiagnosticsPanel onClose={() => setDialog(undefined)} onOpenEvent={(mapId, eventId) => setDialog({ kind: "event", mapId, eventId })} />}
      {dialog?.kind === "event" && <EventDialog mapId={dialog.mapId} eventId={dialog.eventId} onClose={() => setDialog(undefined)} />}
      {dialog?.kind === "playtest" && <PlaytestPanel {...(dialog.start === undefined ? {} : { start: dialog.start })} {...(dialog.event === undefined ? {} : { event: dialog.event })} onClose={() => setDialog(undefined)} />}
    </div>
  );
}
