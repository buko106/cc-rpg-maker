import { createMemoryProjectRepository } from "@rpg/project-store";
import type { EventId, MapId } from "@rpg/schema";
import { cmd, createEditorSession, defaultPage } from "@rpg/editor-core";
import { createCommandRegistry, registerBuiltins } from "@rpg/core";
import { describe, expect, it } from "vitest";
import { assetsOf, cellAt, cellsOnLine, drawOverlay, eventAt, overlayModel, projectMapForEditor } from "./project-map.js";
import type { OverlayContext } from "./project-map.js";

const M1 = "map_001" as MapId;

async function session() {
  const repo = createMemoryProjectRepository();
  const registry = createCommandRegistry();
  registerBuiltins(registry);
  const s = createEditorSession({ repo, doc: await repo.create("t"), commands: registry });
  s.execute(cmd.paintTiles(M1, 1, [{ x: 2, y: 1, tile: 3 }]));
  s.execute(cmd.createEvent(M1, 4, 3, "ev_b" as EventId));
  s.execute(cmd.createEvent(M1, 4, 3, "ev_a" as EventId));
  s.execute(cmd.createEvent(M1, 6, 2, "ev_c" as EventId));
  const walk = Object.keys(s.doc.project.assets.entries)[1] as never;
  s.execute(cmd.setEventPage(M1, "ev_c" as EventId, 0, { ...defaultPage(), graphic: { asset: walk, index: 0, direction: "left" } }));
  return s;
}

describe("projectMapForEditor", () => {
  it("マップのタイルレイヤと、グラフィックを持つイベントのスプライトを FrameSpec にする", async () => {
    const s = await session();
    const frame = projectMapForEditor(s.doc.project, s.doc.maps[M1]!);
    expect(frame.size).toEqual({ width: 640, height: 480 });
    expect(frame.layers.map((l) => l.kind)).toEqual(["tiles", "tiles", "sprites"]);
    const tiles = frame.layers[1];
    expect(tiles?.kind === "tiles" && tiles.tiles[1 * 20 + 2]).toBe(3);
    const sprites = frame.layers[2];
    // 左向きは 2 行目、止まっているときは中央のパターン（横 1 番目）
    expect(sprites?.kind === "sprites" && sprites.sprites).toEqual([expect.objectContaining({ sx: 32, sy: 32, sw: 32, sh: 32, x: 192, y: 64 })]);
    expect(assetsOf(frame)).toHaveLength(2);
    expect(JSON.parse(JSON.stringify(frame))).toEqual(frame); // 純データ
  });

  it("グラフィックが無ければスプライトレイヤは無い。タイルセットに画像が無ければ null", async () => {
    const s = await session();
    const map = { ...s.doc.maps[M1]!, events: {} };
    const project = { ...s.doc.project, tilesets: { ts_default: { id: "ts_default", name: "x", passage: [] } } } as never;
    const frame = projectMapForEditor(project, map);
    expect(frame.layers.map((l) => l.kind)).toEqual(["tiles", "tiles"]);
    expect(frame.layers[0]?.kind === "tiles" && frame.layers[0].tileset).toBeNull();
    expect(assetsOf(frame)).toEqual([]);
  });
});

describe("cellAt / eventAt / cellsOnLine", () => {
  it("表示の大きさ（拡大込み）からセルを求める。範囲外・大きさ 0 は undefined", () => {
    const map = { width: 20, height: 15 };
    expect(cellAt(map, 0, 0, 640, 480)).toEqual({ x: 0, y: 0 });
    expect(cellAt(map, 639, 479, 640, 480)).toEqual({ x: 19, y: 14 });
    expect(cellAt(map, 100, 50, 1280, 960)).toEqual({ x: 1, y: 0 }); // 2 倍表示
    expect(cellAt(map, -1, 0, 640, 480)).toBeUndefined();
    expect(cellAt(map, 640, 0, 640, 480)).toBeUndefined();
    expect(cellAt(map, 5, 5, 0, 0)).toBeUndefined();
  });

  it("同じセルに複数のイベントがいれば ID 順の先頭", async () => {
    const s = await session();
    expect(eventAt(s.doc.maps[M1]!, 4, 3)?.id).toBe("ev_a");
    expect(eventAt(s.doc.maps[M1]!, 0, 0)).toBeUndefined();
  });

  it("2 点を結ぶセル（斜め・逆向き・同じ点）", () => {
    expect(cellsOnLine({ x: 0, y: 0 }, { x: 3, y: 0 })).toEqual([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }]);
    expect(cellsOnLine({ x: 3, y: 2 }, { x: 0, y: 0 })).toHaveLength(4);
    expect(cellsOnLine({ x: 1, y: 1 }, { x: 1, y: 1 })).toEqual([{ x: 1, y: 1 }]);
    const diagonal = cellsOnLine({ x: 0, y: 0 }, { x: 2, y: 2 });
    expect(diagonal).toEqual([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }]);
  });
});

describe("overlay", () => {
  it("overlayModel はイベントと選択・ホバーを含む", async () => {
    const s = await session();
    const model = overlayModel(s.doc.project, s.doc.maps[M1]!, { selected: "ev_c" as EventId, hover: { x: 1, y: 1 }, grid: true });
    expect(model).toMatchObject({ width: 640, height: 480, tileSize: 32, grid: true, hover: { x: 1, y: 1 } });
    expect(model.events.find((e) => e.id === "ev_c")?.selected).toBe(true);
    expect(model.events.find((e) => e.id === "ev_a")?.selected).toBe(false);
  });

  it("drawOverlay はグリッド・ホバー・イベント枠を描く（グリッドを切れば線は引かない）", async () => {
    const s = await session();
    const calls: string[] = [];
    const ctx = new Proxy({} as OverlayContext, {
      get: (_t, name: string) => (name in { strokeStyle: 1, fillStyle: 1, lineWidth: 1, font: 1, textBaseline: 1 } ? undefined : (...args: unknown[]) => calls.push(`${name}(${args.join(",")})`)),
      set: () => true,
    });
    const model = overlayModel(s.doc.project, s.doc.maps[M1]!, { selected: undefined, hover: { x: 1, y: 2 }, grid: true });
    drawOverlay(ctx, model);
    expect(calls[0]).toBe("clearRect(0,0,640,480)");
    expect(calls.filter((c) => c.startsWith("moveTo"))).toHaveLength(21 + 16);
    expect(calls).toContain("fillRect(32,64,32,32)"); // ホバー
    expect(calls.filter((c) => c.startsWith("fillText")).map((c) => c.split(",")[0])).toEqual(expect.arrayContaining(["fillText(EV002", "fillText(EV003", "fillText(EV001"]));
    calls.length = 0;
    drawOverlay(ctx, { ...model, grid: false, hover: undefined });
    expect(calls.some((c) => c.startsWith("moveTo"))).toBe(false);
  });
});
