import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assetExtension } from "@rpg/assets";
import { extensionOf } from "@rpg/project-store";
import { FIXTURES_ROOT } from "@rpg/test-utils";
import { describe, expect, it } from "vitest";
import { createEmbeddedProjectSource } from "./embedded-project-source.js";
import type { EmbeddedData } from "./embedded-project-source.js";

const DEMO = join(FIXTURES_ROOT, "projects", "v1", "demo");
const json = (path: string): unknown => JSON.parse(readFileSync(join(DEMO, path), "utf8"));
const data = (patch: Partial<EmbeddedData> = {}): EmbeddedData => ({
  project: json("project.json"),
  maps: { map_town: json("maps/map_town.json"), map_house: json("maps/map_house.json") },
  assets: {},
  ...patch,
});

describe("createEmbeddedProjectSource", () => {
  it("project を検証して返し、projectHash は埋め込みの値。無ければ JSON 文字列の sha256", async () => {
    const withHash = createEmbeddedProjectSource(data({ projectHash: "abc" }));
    expect((await withHash.project()).meta.id).toBe("demo");
    expect(await withHash.projectHash()).toBe("abc");
    const d = data();
    expect(await createEmbeddedProjectSource(d).projectHash()).toBe(createHash("sha256").update(JSON.stringify(d.project)).digest("hex"));
  });

  it("マップを検証して返す。プロジェクトに無いマップ・埋め込まれていないマップ・不正なマップは reject", async () => {
    const source = createEmbeddedProjectSource(data());
    expect((await source.mapData("map_town" as never)).id).toBe("map_town");
    await expect(source.mapData("map_nope" as never)).rejects.toThrow(/プロジェクトに無い/);
    await expect(createEmbeddedProjectSource(data({ maps: {} })).mapData("map_town" as never)).rejects.toThrow(/埋め込まれていない/);
    await expect(createEmbeddedProjectSource(data({ maps: { map_town: { id: "map_town" } } })).mapData("map_town" as never)).rejects.toThrow(/不正/);
  });

  it("不正なプロジェクトは project() が reject する", async () => {
    await expect(createEmbeddedProjectSource(data({ project: { nope: 1 } })).project()).rejects.toThrow(/不正/);
  });
});

describe("書き出しとプレイヤーの取り決め", () => {
  it("[inv] エクスポータが付けるアセットの拡張子は、プレイヤーが取りに行く URL の拡張子と同じ", () => {
    const entries = [
      { name: "hero.png", mime: "image/png" },
      { name: "HERO.PNG", mime: "image/png" },
      { name: "bgm.ogg", mime: "audio/ogg" },
      { name: "noext", mime: "audio/mpeg" },
      { name: "noext", mime: "image/jpeg" },
      { name: "noext", mime: "application/json" },
      { name: "weird.toolongext", mime: "image/webp" },
      { name: "font.ttf", mime: "font/ttf" },
      { name: "noext", mime: "font/ttf" },
      { name: "noext", mime: "application/octet-stream" },
      { name: "a.b.c", mime: "image/gif" },
    ];
    for (const e of entries) expect(extensionOf(e), JSON.stringify(e)).toBe(`.${assetExtension(e)}`);
  });
});
