import type { MapId } from "@rpg/schema";
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent, ReactElement } from "react";
import { useEnv, useSession } from "../hooks.js";
import { cellAt, drawOverlay, overlayModel } from "../map/project-map.js";
import type { Cell } from "../map/project-map.js";
import { useMapRenderer } from "../map/use-map-renderer.js";
import type { LocationPickerProps } from "../schema-form/SchemaForm.js";

/** プレビューの最大の大きさ（これより大きいマップは縮めて見せる）。 */
const MAX_WIDTH = 420;
const MAX_HEIGHT = 300;

/**
 * マップをクリックして位置を選ぶ、小さなプレビュー（場所移動の移動先・開始位置など）。
 * 下にゲームと同じ描画、上にグリッド・イベント・選んでいる位置の枠。キーボードでは矢印キーで位置を動かす。
 */
export function MapPicker({ mapId, x, y, label, onPick }: LocationPickerProps): ReactElement {
  const session = useSession();
  const env = useEnv();
  const { project } = session.doc;
  const map = Object.hasOwn(session.doc.maps, mapId) ? session.doc.maps[mapId as MapId] : undefined;
  const baseRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState<Cell | undefined>();
  const ts = project.system.tileSize;
  const width = (map?.width ?? 1) * ts;
  const height = (map?.height ?? 1) * ts;
  const inside = map !== undefined && x >= 0 && y >= 0 && x < map.width && y < map.height;

  useMapRenderer(baseRef, session, env, project, map);

  useEffect(() => {
    const overlay = overlayRef.current;
    const ctx = overlay?.getContext("2d");
    if (overlay === null || ctx == null || map === undefined) return;
    overlay.width = width;
    overlay.height = height;
    drawOverlay(ctx, overlayModel(project, map, { selected: undefined, hover, grid: true, marker: inside ? { x, y } : undefined }));
  }, [project, map, hover, x, y, inside, width, height]);

  if (map === undefined) return <p className="muted">マップ {mapId} はありません。</p>;

  const cellOf = (e: { clientX: number; clientY: number }): Cell | undefined => {
    const el = overlayRef.current;
    if (el === null) return undefined;
    const r = el.getBoundingClientRect();
    return cellAt(map, e.clientX - r.left, e.clientY - r.top, r.width, r.height);
  };
  const onPointerDown = (e: PointerEvent<HTMLCanvasElement>): void => {
    if (e.button !== 0) return;
    const cell = cellOf(e);
    if (cell === undefined) return;
    e.currentTarget.focus();
    onPick(cell.x, cell.y);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLCanvasElement>): void => {
    const move = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (move === undefined) return;
    e.preventDefault();
    // 範囲の外（別のマップから切り替えた直後など）なら、まず内側に寄せる
    const cx = Math.min(map.width - 1, Math.max(0, x));
    const cy = Math.min(map.height - 1, Math.max(0, y));
    onPick(Math.min(map.width - 1, Math.max(0, cx + move[0]!)), Math.min(map.height - 1, Math.max(0, cy + move[1]!)));
  };

  const scale = Math.min(1, MAX_WIDTH / width, MAX_HEIGHT / height);
  const shown = { width: Math.round(width * scale), height: Math.round(height * scale) };
  const name = project.maps[map.id]?.name ?? map.id;
  return (
    <div className="map-picker">
      <div className="canvas-stack" style={shown}>
        <canvas ref={baseRef} width={width} height={height} style={shown} aria-hidden="true" />
        <canvas
          ref={overlayRef}
          width={width}
          height={height}
          style={shown}
          tabIndex={0}
          role="application"
          aria-label={`${label}：マップ「${name}」をクリックして位置を選ぶ（矢印キーでも動かせる）`}
          onPointerDown={onPointerDown}
          onPointerMove={(e) => {
            const cell = cellOf(e);
            setHover((h) => (h?.x === cell?.x && h?.y === cell?.y ? h : cell));
          }}
          onPointerLeave={() => setHover(undefined)}
          onKeyDown={onKeyDown}
        />
      </div>
      <span className="muted" aria-live="polite">
        {inside ? `選んでいる位置：(${x}, ${y})` : `(${x}, ${y}) はマップ「${name}」（${map.width}×${map.height}）の外です`}
        {hover !== undefined && `　カーソル：(${hover.x}, ${hover.y})`}
      </span>
    </div>
  );
}
