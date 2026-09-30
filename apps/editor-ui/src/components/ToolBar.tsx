import type { Tool } from "@rpg/editor-core";
import type { ReactElement } from "react";
import { useSession } from "../hooks.js";

const TOOLS: readonly [Tool, string, string][] = [
  ["pencil", "鉛筆", "タイルを描く"],
  ["eraser", "消しゴム", "タイルを消す"],
  ["fill", "塗りつぶし", "つながった同じタイルを塗る"],
  ["event", "イベント", "クリックでイベントを置く／選ぶ。ドラッグで移動"],
  ["select", "選択", "イベントを選ぶ／動かす"],
];

/** ツール・レイヤ・表示（拡大・グリッド）の切り替え。 */
export function ToolBar({ grid, onGrid }: { grid: boolean; onGrid: (on: boolean) => void }): ReactElement {
  const session = useSession();
  const map = session.ui.currentMap === undefined ? undefined : session.doc.maps[session.ui.currentMap];
  return (
    <div className="toolbar" role="toolbar" aria-label="マップのツール">
      <div role="radiogroup" aria-label="ツール" className="btn-group">
        {TOOLS.map(([tool, label, hint]) => (
          <button key={tool} type="button" role="radio" aria-checked={session.ui.tool === tool} title={hint} onClick={() => session.setUi({ tool })}>
            {label}
          </button>
        ))}
      </div>
      <div role="radiogroup" aria-label="レイヤ" className="btn-group">
        {(map?.layers ?? []).map((layer, i) => (
          <button key={i} type="button" role="radio" aria-checked={session.ui.currentLayer === i} onClick={() => session.setUi({ currentLayer: i })}>
            {layer.name}
          </button>
        ))}
      </div>
      <div role="radiogroup" aria-label="拡大率" className="btn-group">
        {[1, 2].map((z) => (
          <button key={z} type="button" role="radio" aria-checked={session.ui.zoom === z} onClick={() => session.setUi({ zoom: z })}>
            ×{z}
          </button>
        ))}
      </div>
      <label className="check">
        <input type="checkbox" checked={grid} onChange={(e) => onGrid(e.target.checked)} />
        グリッド
      </label>
    </div>
  );
}
