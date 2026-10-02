import { cmd } from "@rpg/editor-core";
import type { Anchor } from "@rpg/editor-core";
import type { AssetId, MapId, TilesetId } from "@rpg/schema";
import { useState } from "react";
import type { ReactElement } from "react";
import { useSession } from "../hooks.js";
import { Dialog } from "./Dialog.js";
import { useExecute } from "./useExecute.js";

const ANCHORS: readonly [Anchor, string][] = [
  ["nw", "左上"],
  ["n", "上"],
  ["ne", "右上"],
  ["w", "左"],
  ["c", "中央"],
  ["e", "右"],
  ["sw", "左下"],
  ["s", "下"],
  ["se", "右下"],
];

/** 歩く速さの段階（`Character.speed`。1 段階ごとに 2 倍）。 */
const WALK_SPEEDS: readonly [number, string][] = [
  [1, "1（とても遅い）"],
  [2, "2（遅い）"],
  [3, "3（やや遅い）"],
  [4, "4（ふつう）"],
  [5, "5（やや速い）"],
  [6, "6（速い）"],
];

/** マップの名前・大きさ・タイルセット・BGM・歩く速さ・走れるか。 */
export function MapProperties({ mapId, onClose }: { mapId: MapId; onClose: () => void }): ReactElement | null {
  const session = useSession();
  const { run, error } = useExecute();
  const meta = session.doc.project.maps[mapId];
  const map = session.doc.maps[mapId];
  const [width, setWidth] = useState(map?.width ?? 1);
  const [height, setHeight] = useState(map?.height ?? 1);
  const [anchor, setAnchor] = useState<Anchor>("nw");
  if (meta === undefined || map === undefined) return null;
  const { tilesets, assets } = session.doc.project;
  const audio = Object.entries(assets.entries).filter(([, e]) => e.kind === "audio");

  return (
    <Dialog title={`マップ設定：${meta.name}`} onClose={onClose}>
      {error !== undefined && <p role="alert" className="notice error">{error}</p>}
      <div className="form-grid">
        <label>
          名前
          <input type="text" value={meta.name} onChange={(e) => run(cmd.setMapMeta(mapId, { name: e.target.value }))} />
        </label>
        <label>
          タイルセット
          <select value={map.tileset} onChange={(e) => run(cmd.setMapProperties(mapId, { tileset: e.target.value as TilesetId }))}>
            {Object.values(tilesets).map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          BGM
          <select
            value={map.bgm?.asset ?? ""}
            onChange={(e) => run(cmd.setMapProperties(mapId, { bgm: e.target.value === "" ? null : { asset: e.target.value as AssetId, volume: 1, pitch: 1, loop: true } }))}
          >
            <option value="">なし</option>
            {audio.map(([id, e]) => (
              <option key={id} value={id}>
                {e.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          歩く速さ
          <select value={map.walkSpeed ?? ""} onChange={(e) => run(cmd.setMapProperties(mapId, { walkSpeed: e.target.value === "" ? null : Number(e.target.value) }))}>
            <option value="">システム設定に従う</option>
            {WALK_SPEEDS.map(([speed, label]) => (
              <option key={speed} value={speed}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={map.noDash === true} onChange={(e) => run(cmd.setMapProperties(mapId, { noDash: e.target.checked }))} />
          このマップでは走れない
        </label>
      </div>
      <fieldset>
        <legend>マップの大きさ</legend>
        <div className="form-grid">
          <label>
            幅
            <input type="number" min={1} max={1000} value={width} onChange={(e) => setWidth(Number(e.target.value))} />
          </label>
          <label>
            高さ
            <input type="number" min={1} max={1000} value={height} onChange={(e) => setHeight(Number(e.target.value))} />
          </label>
          <label>
            固定する位置
            <select value={anchor} onChange={(e) => setAnchor(e.target.value as Anchor)}>
              {ANCHORS.map(([a, label]) => (
                <option key={a} value={a}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <button type="button" onClick={() => run(cmd.resizeMap(mapId, width, height, anchor))}>
          サイズを変更
        </button>
      </fieldset>
    </Dialog>
  );
}
