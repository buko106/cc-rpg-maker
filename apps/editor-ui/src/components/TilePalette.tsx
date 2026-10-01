import { cmd } from "@rpg/editor-core";
import type { ReactElement } from "react";
import { useSession } from "../hooks.js";
import { useAssetUrl } from "./useAssetUrl.js";
import { useExecute } from "./useExecute.js";

/** 通行可能方向のビット（docs/01-schema.md：下=1, 左=2, 右=4, 上=8）。範囲外のタイルは全方向通行可（15）。 */
const PASSAGE: readonly [number, string][] = [[1, "下"], [2, "左"], [4, "右"], [8, "上"]];

/**
 * タイルパレット：タイルセット画像を 1 タイルずつのボタンに分けて並べる（キーボードで選べる）。
 * タイル番号は画像の左→右、上→下の順（0 は「空」なので並べない。消しゴムで消す）。
 */
export function TilePalette(): ReactElement {
  const session = useSession();
  const { project } = session.doc;
  const map = session.ui.currentMap === undefined ? undefined : session.doc.maps[session.ui.currentMap];
  const tileset = map === undefined ? undefined : project.tilesets[map.tileset];
  const assetId = tileset?.image?.asset;
  const entry = assetId === undefined ? undefined : project.assets.entries[assetId];
  const url = useAssetUrl(assetId);
  const size = project.system.tileSize;
  const cols = entry?.width === undefined ? 0 : Math.floor(entry.width / size);
  const rows = entry?.height === undefined ? 0 : Math.floor(entry.height / size);
  const tiles = Array.from({ length: cols * rows }, (_, i) => i).filter((i) => i > 0);

  const { run, error } = useExecute();
  const selected = session.ui.tile;
  const passage = tileset?.passage[selected] ?? 15;
  const setPassage = (bit: number, on: boolean): void => {
    if (tileset === undefined) return;
    // 選んだタイルまで、足りない分は全方向通行可（15）で埋めてから、そのビットを切り替える
    const next = Array.from({ length: Math.max(tileset.passage.length, selected + 1) }, (_, i) => tileset.passage[i] ?? 15);
    next[selected] = on ? passage | bit : passage & ~bit;
    run(cmd.upsertTileset({ ...tileset, passage: next }));
  };

  const slippery = tileset?.ice?.includes(selected) === true;
  const setSlippery = (on: boolean): void => {
    if (tileset === undefined) return;
    const rest = (tileset.ice ?? []).filter((t) => t !== selected);
    const ice = on ? [...rest, selected].sort((a, b) => a - b) : rest;
    const { ice: _old, ...base } = tileset;
    run(cmd.upsertTileset(ice.length === 0 ? base : { ...base, ice }));
  };

  return (
    <section className="tile-palette" aria-label="タイルパレット">
      <h2>タイル</h2>
      {tiles.length === 0 && <p className="muted">（このマップのタイルセットには画像がありません）</p>}
      <div className="palette-grid" role="group" aria-label="タイル" style={{ gridTemplateColumns: `repeat(${Math.max(1, Math.min(cols, 6))}, ${size}px)` }}>
        {tiles.map((t) => (
          <button
            key={t}
            type="button"
            className={session.ui.tile === t ? "tile selected" : "tile"}
            aria-label={`タイル ${t}`}
            aria-pressed={session.ui.tile === t}
            style={{
              width: size,
              height: size,
              backgroundImage: url === undefined ? undefined : `url(${url})`,
              backgroundPosition: `-${(t % cols) * size}px -${Math.floor(t / cols) * size}px`,
            }}
            onClick={() => session.setUi({ tile: t, tool: session.ui.tool === "eraser" ? "pencil" : session.ui.tool })}
          />
        ))}
      </div>
      {tileset !== undefined && tiles.length > 0 && (
        <fieldset className="passage">
          <legend>タイル {selected} の通行</legend>
          {PASSAGE.map(([bit, label]) => (
            <label key={bit} className="check">
              <input type="checkbox" checked={(passage & bit) !== 0} onChange={(e) => setPassage(bit, e.target.checked)} />
              {label}から入れる
            </label>
          ))}
          <label className="check">
            <input type="checkbox" checked={slippery} onChange={(e) => setSlippery(e.target.checked)} />
            滑る（氷）
          </label>
        </fieldset>
      )}
      {error !== undefined && <p role="alert" className="notice error">{error}</p>}
    </section>
  );
}
