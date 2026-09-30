import { cmd } from "@rpg/editor-core";
import { newId } from "@rpg/schema";
import type { MapId, MapMeta } from "@rpg/schema";
import { useState } from "react";
import type { ReactElement } from "react";
import { useSession } from "../hooks.js";
import { MapProperties } from "./MapProperties.js";
import { useExecute } from "./useExecute.js";

interface Row {
  meta: MapMeta;
  depth: number;
}

/** 親子関係を辿って、表示順（order → 名前）に平らにする。親が見つからないマップはルート扱い。 */
export function flattenMaps(maps: Record<string, MapMeta>): Row[] {
  const all = Object.values(maps);
  const byParent = new Map<string | undefined, MapMeta[]>();
  for (const m of all) {
    const key = m.parent !== undefined && Object.hasOwn(maps, m.parent) ? m.parent : undefined;
    byParent.set(key, [...(byParent.get(key) ?? []), m]);
  }
  const rows: Row[] = [];
  const visit = (parent: string | undefined, depth: number, seen: Set<string>): void => {
    const children = (byParent.get(parent) ?? []).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
    for (const m of children) {
      if (seen.has(m.id)) continue;
      rows.push({ meta: m, depth });
      visit(m.id, depth + 1, new Set([...seen, m.id]));
    }
  };
  visit(undefined, 0, new Set());
  return rows;
}

/** マップツリー：選択、追加、設定、削除。 */
export function MapTree(): ReactElement {
  const session = useSession();
  const { run, dialog, error } = useExecute((c) => c.label);
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<MapId | undefined>();
  const current = session.ui.currentMap;
  const rows = flattenMaps(session.doc.project.maps);

  return (
    <section className="map-tree" aria-label="マップツリー">
      <h2>マップ</h2>
      <ul role="tree">
        {rows.map(({ meta, depth }) => (
          <li key={meta.id} role="treeitem" aria-selected={meta.id === current} style={{ paddingLeft: `${depth * 14}px` }}>
            <button type="button" className={meta.id === current ? "selected" : undefined} aria-current={meta.id === current} onClick={() => session.setUi({ currentMap: meta.id, selection: { kind: "none" } })}>
              {meta.name}
            </button>
          </li>
        ))}
      </ul>
      <form
        className="row-form"
        onSubmit={(e) => {
          e.preventDefault();
          const order = rows.length === 0 ? 0 : Math.max(...rows.map((r) => r.meta.order)) + 1;
          const id = newId<"MapId">("map");
          if (run(cmd.createMap({ name: name.trim() === "" ? "新しいマップ" : name.trim(), order }, {}, id))) {
            session.setUi({ currentMap: id, selection: { kind: "none" } });
            setName("");
          }
        }}
      >
        <input type="text" aria-label="新しいマップの名前" placeholder="新しいマップ名" value={name} onChange={(e) => setName(e.target.value)} />
        <button type="submit">＋ 追加</button>
      </form>
      <div className="row-form">
        <button type="button" disabled={current === undefined} onClick={() => setEditing(current)}>
          マップ設定…
        </button>
        <button type="button" disabled={current === undefined} onClick={() => current !== undefined && run(cmd.deleteMap(current))}>
          マップを削除
        </button>
      </div>
      {error !== undefined && <p role="alert" className="notice error">{error}</p>}
      {editing !== undefined && <MapProperties mapId={editing} onClose={() => setEditing(undefined)} />}
      {dialog}
    </section>
  );
}
