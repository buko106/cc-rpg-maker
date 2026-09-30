import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hashAsset } from "@rpg/assets";
import { FIXTURES_ROOT, loadFixtureProject } from "@rpg/test-utils";

const ASSETS = join(FIXTURES_ROOT, "projects", "v1", "demo", "assets");
const EXTENSIONS: Record<string, string> = { "image/png": "png", "audio/wav": "wav" };

describe("fixtures/projects/v1/demo のアセット", () => {
  const { project } = loadFixtureProject("demo");
  const files = readdirSync(ASSETS).sort();

  it("[inv-5] ファイル名（AssetId）は内容の sha256 先頭 16 桁と一致する", async () => {
    for (const file of files) {
      const bytes = readFileSync(join(ASSETS, file));
      const id = await hashAsset(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      expect(file).toBe(`${id}.${file.split(".")[1]}`);
    }
  });

  it("マニフェストの全エントリに実ファイルがあり、サイズが一致する（逆も）", () => {
    const entries = Object.entries(project.assets.entries);
    const fileOf = ([id, entry]: (typeof entries)[number]) => `${id}.${EXTENSIONS[entry.mime]}`;
    expect(files).toEqual(entries.map(fileOf).sort());
    for (const e of entries) expect(readFileSync(join(ASSETS, fileOf(e))).length).toBe(e[1].size);
  });

  it("画像（PNG）の幅・高さがマニフェストと一致する", () => {
    for (const [id, entry] of Object.entries(project.assets.entries).filter(([, e]) => e.kind === "image")) {
      const png = readFileSync(join(ASSETS, `${id}.png`));
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([entry.width, entry.height]);
    }
  });
});
