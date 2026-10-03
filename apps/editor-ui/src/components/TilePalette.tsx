import { cmd } from "@rpg/editor-core";
import type { Direction } from "@rpg/schema";
import type { ReactElement } from "react";
import { useSession } from "../hooks.js";
import { useAssetUrl } from "./useAssetUrl.js";
import { useExecute } from "./useExecute.js";

/** 通行可能方向のビット（docs/01-schema.md：下=1, 左=2, 右=4, 上=8）。範囲外のタイルは全方向通行可（15）。 */
const PASSAGE: readonly [number, string][] = [[1, "下"], [2, "左"], [4, "右"], [8, "上"]];

/** 床の動き（氷・ベルト）。どれか 1 つだけ選べる。`""` は通常の床。 */
type FloorMotion = "" | "ice" | Direction;
const FLOOR_MOTIONS: readonly [FloorMotion, string][] = [
  ["", "通常"],
  ["ice", "滑る（氷）"],
  ["up", "ベルト：上へ運ぶ"],
  ["down", "ベルト：下へ運ぶ"],
  ["left", "ベルト：左へ運ぶ"],
  ["right", "ベルト：右へ運ぶ"],
];

/** 足元のタイルによる歩く速さの増減（段階。1 段階ごとに 2 倍）。 */
const FOOTING_SPEEDS: readonly [number, string][] = [
  [2, "とても速い（+2）"],
  [1, "速い（+1）"],
  [0, "ふつう"],
  [-1, "遅い（−1）"],
  [-2, "とても遅い（−2）"],
  [-3, "ほとんど進めない（−3）"],
];

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

  const recent = session.ui.recentTiles.filter((t) => t > 0 && t < cols * rows);
  const pick = (t: number): void =>
    session.setUi({ tile: t, tool: session.ui.tool === "eraser" ? "pencil" : session.ui.tool });

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

  // 床の動き：通常・氷・ベルト（4 方向）のどれか 1 つ（排他）。氷は `Tileset.ice`、ベルトは `Tileset.conveyor` に持つ。
  // 選び直すと、もう一方からは外す（空になった ice / conveyor は丸ごと消す）。古いデータで両方に載っているタイルは、ベルトとして見せる。
  const belt = tileset?.conveyor?.[String(selected)];
  const slippery = tileset?.ice?.includes(selected) === true;
  const floorMotion: FloorMotion = belt ?? (slippery ? "ice" : "");
  const setFloorMotion = (motion: FloorMotion): void => {
    if (tileset === undefined) return;
    const { ice: _ice, conveyor: _conveyor, ...base } = tileset;
    const ice = (tileset.ice ?? []).filter((t) => t !== selected);
    const conveyor = Object.fromEntries(Object.entries(tileset.conveyor ?? {}).filter(([tile]) => tile !== String(selected)));
    if (motion === "ice") ice.push(selected);
    else if (motion !== "") conveyor[String(selected)] = motion;
    ice.sort((x, y) => x - y);
    run(cmd.upsertTileset({ ...base, ...(ice.length === 0 ? {} : { ice }), ...(Object.keys(conveyor).length === 0 ? {} : { conveyor }) }));
  };

  // 足元の速さ（砂地・沼など）。何も変えない設定（ふつう・走れる）は持たない
  const footing = tileset?.terrain?.[String(selected)];
  const setFooting = (next: { speed?: number; noDash?: boolean }): void => {
    if (tileset === undefined) return;
    const speed = next.speed ?? footing?.speed ?? 0;
    const noDash = next.noDash ?? footing?.noDash === true;
    const rest = Object.fromEntries(Object.entries(tileset.terrain ?? {}).filter(([tile]) => tile !== String(selected)));
    const effect = { ...(speed === 0 ? {} : { speed }), ...(noDash ? { noDash: true } : {}) };
    const terrain = Object.keys(effect).length === 0 ? rest : { ...rest, [String(selected)]: effect };
    const { terrain: _old, ...base } = tileset;
    run(cmd.upsertTileset(Object.keys(terrain).length === 0 ? base : { ...base, terrain }));
  };

  const tileButton = (t: number, label = `タイル ${t}`): ReactElement => (
    <button
      key={t}
      type="button"
      className={session.ui.tile === t ? "tile selected" : "tile"}
      aria-label={label}
      aria-pressed={session.ui.tile === t}
      style={{
        width: size,
        height: size,
        backgroundImage: url === undefined ? undefined : `url(${url})`,
        backgroundPosition: `-${(t % cols) * size}px -${Math.floor(t / cols) * size}px`,
      }}
      onClick={() => pick(t)}
    />
  );

  return (
    <section className="tile-palette" aria-label="タイルパレット">
      <h2>タイル</h2>
      {recent.length > 0 && (
        <div className="palette-recent" role="group" aria-label="最近使ったタイル">
          <span className="palette-recent-label">最近使った</span>
          {recent.map((t) => tileButton(t, `最近使ったタイル ${t}`))}
        </div>
      )}
      {tiles.length === 0 && <p className="muted">（このマップのタイルセットには画像がありません）</p>}
      <div className="palette-grid" role="group" aria-label="タイル" style={{ gridTemplateColumns: `repeat(${Math.max(1, Math.min(cols, 6))}, ${size}px)` }}>
        {tiles.map((t) => tileButton(t))}
      </div>
      {tileset !== undefined && tiles.length > 0 && (
        <>
          <fieldset className="passage">
            <legend>タイル {selected} の通行</legend>
            {PASSAGE.map(([bit, label]) => (
              <label key={bit} className="check">
                <input type="checkbox" checked={(passage & bit) !== 0} onChange={(e) => setPassage(bit, e.target.checked)} />
                {label}から入れる
              </label>
            ))}
          </fieldset>
          <fieldset className="passage">
            <legend>タイル {selected} の床の効果</legend>
            <label>
              床の動き
              <select value={floorMotion} onChange={(e) => setFloorMotion(e.target.value as FloorMotion)}>
                {FLOOR_MOTIONS.map(([motion, label]) => (
                  <option key={motion} value={motion}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              足元の速さ
              <select value={footing?.speed ?? 0} onChange={(e) => setFooting({ speed: Number(e.target.value) })}>
                {FOOTING_SPEEDS.map(([speed, label]) => (
                  <option key={speed} value={speed}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="check">
              <input type="checkbox" checked={footing?.noDash === true} onChange={(e) => setFooting({ noDash: e.target.checked })} />
              走れない
            </label>
          </fieldset>
        </>
      )}
      {error !== undefined && <p role="alert" className="notice error">{error}</p>}
    </section>
  );
}
