import type { Tool } from "@rpg/editor-core";
import type { ReactElement } from "react";
import { useEventTemplates, useSession } from "../hooks.js";

const TOOLS: readonly [Tool, string, string][] = [
  ["pencil", "鉛筆", "タイルを描く"],
  ["eraser", "消しゴム", "タイルを消す"],
  ["fill", "塗りつぶし", "つながった同じタイルを塗る"],
  ["event", "イベント", "クリックでイベントを置く／選ぶ。ドラッグで移動。「置くイベント」でひな形を選ぶと、入力してから置く"],
  ["select", "選択", "イベントを選ぶ／動かす"],
];

/** ツール・置くイベント（ひな形）・レイヤ・表示（拡大・グリッド）の切り替え。 */
export function ToolBar({ grid, onGrid }: { grid: boolean; onGrid: (on: boolean) => void }): ReactElement {
  const session = useSession();
  const templates = useEventTemplates();
  const template = templates.find((t) => t.id === session.ui.eventTemplate);
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
      <label className="check" title={template?.description ?? "空いたセルをクリックすると、空のイベントを置く"}>
        置くイベント
        <select
          aria-label="置くイベント"
          value={template?.id ?? ""}
          onChange={(e) => {
            // ひな形を選んだら、そのままイベントツールで置けるようにする
            const id = e.target.value === "" ? undefined : e.target.value;
            session.setUi({ eventTemplate: id, ...(id === undefined ? {} : { tool: "event" }) });
          }}
        >
          <option value="">空のイベント</option>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
      </label>
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
