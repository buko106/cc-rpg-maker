import { parseMapData, parseProject, serializeMapData, serializeProject } from "@rpg/schema";
import { describe, expect, it } from "vitest";
import { createTemplate, TEMPLATE_MAP_ID } from "./template.js";
import { hashBytes, imageSize, mimeOf } from "./util.js";

describe("createTemplate", () => {
  const t = createTemplate("p1", "題", "2026-01-01T00:00:00.000Z");

  it("スキーマに通る project と map になる", () => {
    const project = parseProject(serializeProject(t.doc.project));
    expect(project.ok).toBe(true);
    const map = parseMapData(serializeMapData(t.doc.maps[TEMPLATE_MAP_ID]!), 1);
    expect(map.ok).toBe(true);
  });

  it("アセットの ID は内容ハッシュと一致し、マニフェストに載っている", async () => {
    for (const a of t.assets) {
      expect(await hashBytes(a.bytes)).toBe(a.id);
      expect(t.doc.project.assets.entries[a.id]).toEqual(a.entry);
    }
    expect(t.assets[0]?.entry).toMatchObject({ kind: "image", mime: "image/png", width: 224, height: 32 });
  });

  it("開始位置はマップ内で、初期パーティのアクターが存在する", () => {
    const { system, database } = t.doc.project;
    const map = t.doc.maps[system.startMap]!;
    expect(system.startX).toBeLessThan(map.width);
    expect(system.startY).toBeLessThan(map.height);
    for (const a of system.initialParty) expect(database.actors[a]).toBeDefined();
  });
});

describe("util", () => {
  it("mimeOf は拡張子から推測し、分からなければ octet-stream", () => {
    expect(mimeOf("a.PNG")).toBe("image/png");
    expect(mimeOf("bgm.ogg")).toBe("audio/ogg");
    expect(mimeOf("noext")).toBe("application/octet-stream");
  });

  it("imageSize は GIF / JPEG のヘッダも読み、分からないものは undefined", () => {
    const gif = new Uint8Array(10);
    gif.set([0x47, 0x49, 0x46, 0x38]);
    new DataView(gif.buffer).setUint16(6, 40, true);
    new DataView(gif.buffer).setUint16(8, 30, true);
    expect(imageSize(gif.buffer)).toEqual({ width: 40, height: 30 });

    const jpg = new Uint8Array(20);
    jpg.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08]);
    new DataView(jpg.buffer).setUint16(7, 20); // height
    new DataView(jpg.buffer).setUint16(9, 60); // width
    expect(imageSize(jpg.buffer)).toEqual({ width: 60, height: 20 });

    expect(imageSize(new Uint8Array([1, 2, 3]).buffer)).toBeUndefined();
    expect(imageSize(new Uint8Array([0xff, 0xd8, 0x00, 0x00, 0, 0, 0, 0, 0, 0, 0, 0]).buffer)).toBeUndefined();
  });
});
