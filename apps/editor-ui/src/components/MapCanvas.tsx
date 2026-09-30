import { cmd } from "@rpg/editor-core";
import { newId } from "@rpg/schema";
import type { EventId } from "@rpg/schema";
import type { AssetSource, Renderer } from "@rpg/runtime";
import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent, ReactElement } from "react";
import { useEnv, useSession } from "../hooks.js";
import { assetsOf, cellAt, cellsOnLine, drawOverlay, eventAt, overlayModel, projectMapForEditor } from "../map/project-map.js";
import type { Cell } from "../map/project-map.js";
import { useExecute } from "./useExecute.js";

type Stroke = { kind: "paint"; last: Cell } | { kind: "drag"; eventId: EventId; at: Cell };

/**
 * マップキャンバス。下のキャンバスに `Renderer`（ゲームと同じ描画）でマップを描き、上のキャンバスにグリッド・イベント枠を重ねる。
 * 操作はすべて EditorCommand（`paintTiles` / `fillTiles` / `createEvent` / `moveEvent` / `deleteEvent`）として `session.execute` に渡す。
 * キーボード：矢印でセルを移動、Enter でツールを適用、O でイベントを開く、Delete で選択中のイベントを削除、
 * Ctrl/⌘ + C・X・V で選択中のイベントのコピー・切り取り・貼り付け（貼り付け先はカーソルのあるセル）。
 */
export function MapCanvas({ grid, onOpenEvent }: { grid: boolean; onOpenEvent: (eventId: EventId) => void }): ReactElement {
  const session = useSession();
  const env = useEnv();
  const { run, dialog, error } = useExecute();
  const baseRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const engine = useRef<{ renderer: Renderer; assets: AssetSource; ready: boolean; loaded: Set<string>; lastFrame?: ReturnType<typeof projectMapForEditor> } | undefined>(undefined);
  const stroke = useRef<Stroke | undefined>(undefined);
  const [hover, setHover] = useState<Cell | undefined>();
  /** 最後にカーソルがあったセル（ボタンから貼るときの貼り付け先。キャンバスの外へ出ても残る） */
  const lastCell = useRef<Cell | undefined>(undefined);
  const [readyTick, setReadyTick] = useState(0);

  const { ui, doc } = session;
  const map = ui.currentMap === undefined ? undefined : doc.maps[ui.currentMap];
  const tileSize = doc.project.system.tileSize;
  const width = (map?.width ?? 1) * tileSize;
  const height = (map?.height ?? 1) * tileSize;

  // Renderer はセッションが変わるまで使い回す
  useEffect(() => {
    const canvas = baseRef.current;
    if (canvas === null) return;
    const assets = env.createAssets(session);
    const renderer = env.createRenderer(canvas);
    const state = { renderer, assets, ready: false, loaded: new Set<string>() };
    engine.current = state;
    void renderer.init({ width, height, assets }).then(() => {
      state.ready = true;
      setReadyTick((n) => n + 1); // 初期化が終わったので描く
    });
    return () => {
      engine.current = undefined;
      renderer.dispose();
    };
    // Renderer の作り直しはセッションの切り替え時だけ（サイズは下の effect で追随する）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, env]);

  // マップの内容が変わったときだけ、Renderer で描き直す（ホバーの移動では描き直さない）
  const frame = useMemo(() => (map === undefined ? undefined : projectMapForEditor(doc.project, map)), [doc.project, map]);
  useEffect(() => {
    const state = engine.current;
    if (state === undefined || !state.ready || frame === undefined) return;
    state.renderer.resize(width, height);
    state.lastFrame = frame;
    state.renderer.render(frame);
    // 画像の読み込みが終わったら、もう一度描く（Renderer は未ロードの画像を次のフレームから描く）
    for (const id of assetsOf(frame)) {
      if (state.loaded.has(id)) continue;
      state.loaded.add(id);
      state.assets.loadImage(id).then(
        () => requestAnimationFrame(() => engine.current === state && state.lastFrame !== undefined && state.renderer.render(state.lastFrame)),
        () => state.loaded.delete(id),
      );
    }
  }, [frame, width, height, readyTick]);

  // グリッド・イベント枠・選択・ホバーのオーバーレイ
  useEffect(() => {
    const overlay = overlayRef.current;
    const ctx = overlay?.getContext("2d");
    if (overlay === null || ctx == null || map === undefined) return;
    overlay.width = width;
    overlay.height = height;
    drawOverlay(ctx, overlayModel(doc.project, map, { selected: ui.selection.kind === "event" ? ui.selection.eventId : undefined, hover, grid }));
  }, [doc.project, map, ui.selection, hover, grid, width, height]);

  const selected = ui.selection.kind === "event" ? map?.events[ui.selection.eventId] : undefined;

  const copyEvent = (): void => {
    if (selected !== undefined) session.setUi({ clipboard: selected });
  };
  const cutEvent = (): void => {
    if (selected === undefined || ui.currentMap === undefined) return;
    session.setUi({ clipboard: selected });
    run(cmd.deleteEvent(ui.currentMap, selected.id));
  };
  const pasteEvent = (): void => {
    const cell = hover ?? lastCell.current ?? { x: 0, y: 0 };
    if (ui.clipboard === undefined || ui.currentMap === undefined) return;
    const id = newId<"EventId">("ev");
    if (run(cmd.pasteEvent(ui.currentMap, ui.clipboard, cell.x, cell.y, id))) session.setUi({ selection: { kind: "event", eventId: id } });
  };

  const cellOf = (e: { clientX: number; clientY: number }): Cell | undefined => {
    const el = overlayRef.current;
    if (el === null || map === undefined) return undefined;
    const r = el.getBoundingClientRect();
    return cellAt(map, e.clientX - r.left, e.clientY - r.top, r.width, r.height);
  };

  const paintCells = (cells: Cell[]): void => {
    if (ui.currentMap === undefined) return;
    const tile = ui.tool === "eraser" ? 0 : ui.tile;
    run(cmd.paintTiles(ui.currentMap, ui.currentLayer, cells.map((c) => ({ ...c, tile }))));
  };

  /** セル 1 つにツールを適用する（ポインタの押下・キーボードの Enter 共通）。ドラッグ／塗りの続きを返す。 */
  const apply = (cell: Cell): Stroke | undefined => {
    if (map === undefined || ui.currentMap === undefined) return undefined;
    const existing = eventAt(map, cell.x, cell.y);
    switch (ui.tool) {
      case "pencil":
      case "eraser":
        paintCells([cell]);
        return { kind: "paint", last: cell };
      case "fill":
        run(cmd.fillTiles(ui.currentMap, ui.currentLayer, cell.x, cell.y, ui.tile));
        return undefined;
      case "event":
      case "select": {
        if (existing !== undefined) {
          session.setUi({ selection: { kind: "event", eventId: existing.id } });
          return { kind: "drag", eventId: existing.id, at: cell };
        }
        if (ui.tool === "select") {
          session.setUi({ selection: { kind: "none" } });
          return undefined;
        }
        const id = newId<"EventId">("ev");
        if (run(cmd.createEvent(ui.currentMap, cell.x, cell.y, id))) {
          session.setUi({ selection: { kind: "event", eventId: id } });
          return { kind: "drag", eventId: id, at: cell };
        }
        return undefined;
      }
    }
  };

  const onPointerDown = (e: PointerEvent<HTMLCanvasElement>): void => {
    if (e.button !== 0) return;
    const cell = cellOf(e);
    if (cell === undefined) return;
    e.currentTarget.focus();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    stroke.current = apply(cell);
  };

  const onPointerMove = (e: PointerEvent<HTMLCanvasElement>): void => {
    const cell = cellOf(e);
    setHover((h) => (h?.x === cell?.x && h?.y === cell?.y ? h : cell));
    if (cell !== undefined) lastCell.current = cell;
    const s = stroke.current;
    if (cell === undefined || s === undefined || ui.currentMap === undefined) return;
    if (s.kind === "paint") {
      if (cell.x === s.last.x && cell.y === s.last.y) return;
      paintCells(cellsOnLine(s.last, cell).slice(1));
      stroke.current = { kind: "paint", last: cell };
    } else if (cell.x !== s.at.x || cell.y !== s.at.y) {
      if (run(cmd.moveEvent(ui.currentMap, s.eventId, cell.x, cell.y))) stroke.current = { kind: "drag", eventId: s.eventId, at: cell };
    }
  };

  const endStroke = (): void => {
    stroke.current = undefined;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLCanvasElement>): void => {
    if (map === undefined) return;
    const at = hover ?? lastCell.current ?? { x: 0, y: 0 };
    const shortcut = e.ctrlKey || e.metaKey ? e.key.toLowerCase() : undefined;
    if (shortcut === "c" || shortcut === "x" || shortcut === "v") {
      if (shortcut === "c") copyEvent();
      else if (shortcut === "x") cutEvent();
      else pasteEvent();
      e.preventDefault();
      return;
    }
    const move = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (move !== undefined && move.length === 2) {
      const next = { x: Math.min(map.width - 1, Math.max(0, at.x + move[0]!)), y: Math.min(map.height - 1, Math.max(0, at.y + move[1]!)) };
      lastCell.current = next;
      setHover(next);
    } else if (e.key === "Enter" || e.key === " ") {
      apply(at);
    } else if (e.key.toLowerCase() === "o") {
      const ev = eventAt(map, at.x, at.y);
      if (ev !== undefined) onOpenEvent(ev.id);
    } else if ((e.key === "Delete" || e.key === "Backspace") && ui.selection.kind === "event" && ui.currentMap !== undefined) {
      run(cmd.deleteEvent(ui.currentMap, ui.selection.eventId));
    } else return;
    e.preventDefault();
  };

  if (map === undefined) return <div className="map-canvas empty">マップがありません。左のツリーから追加してください。</div>;
  const shown = { width: width * ui.zoom, height: height * ui.zoom };
  return (
    <div className="map-canvas">
      {error !== undefined && <p role="alert" className="notice error">{error}</p>}
      <div className="canvas-scroll">
        <div className="canvas-stack" style={shown}>
          <canvas ref={baseRef} width={width} height={height} style={shown} aria-hidden="true" />
          <canvas
            ref={overlayRef}
            width={width}
            height={height}
            style={shown}
            tabIndex={0}
            role="application"
            aria-label={`マップ「${session.doc.project.maps[map.id]?.name ?? map.id}」の編集キャンバス。矢印キーでセルを移動、Enter でツールを適用、O でイベントを開く、Ctrl+C・X・V でイベントをコピー・切り取り・貼り付け`}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endStroke}
            onPointerCancel={endStroke}
            onPointerLeave={() => setHover(undefined)}
            onDoubleClick={(e) => {
              const cell = cellOf(e);
              const ev = cell === undefined ? undefined : eventAt(map, cell.x, cell.y);
              if (ev !== undefined) onOpenEvent(ev.id);
            }}
            onKeyDown={onKeyDown}
          />
        </div>
      </div>
      <div className="clipboard-bar" role="toolbar" aria-label="イベントのコピーと貼り付け">
        <button type="button" disabled={selected === undefined} title="選んでいるイベントをコピー（Ctrl+C）" onClick={copyEvent}>
          コピー
        </button>
        <button type="button" disabled={selected === undefined} title="選んでいるイベントを切り取り（Ctrl+X）" onClick={cutEvent}>
          切り取り
        </button>
        <button type="button" disabled={ui.clipboard === undefined} title="最後にカーソルがあったセルに貼り付け（Ctrl+V）" onClick={pasteEvent}>
          貼り付け
        </button>
        {ui.clipboard !== undefined && <span className="muted">クリップボード：「{ui.clipboard.name}」</span>}
      </div>
      <p className="muted status-line" aria-live="polite">
        {hover === undefined ? "" : `(${hover.x}, ${hover.y})`}
      </p>
      {dialog}
    </div>
  );
}
