import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hashAsset } from "@rpg/assets";
import { FIXTURES_ROOT, loadFixtureProject } from "@rpg/test-utils";

const EXTENSIONS: Record<string, string> = { "image/png": "png", "audio/wav": "wav" };

// サイトの「デモを選ぶ」に並ぶデモ（tools/build-demos.mjs の DEMOS）
// `dungeon`・`fishing` は v2（プラグインの設定 `system.plugins` を持つ）
const DEMOS: readonly (readonly [string, number])[] = [["demo", 1], ["maze", 1], ["tower", 1], ["mansion", 1], ["haunted", 1], ["stealth", 1], ["hokora", 1], ["ice", 1], ["water", 1], ["dungeon", 2], ["fishing", 2]];
describe.each(DEMOS)("fixtures/projects/v%2$d/%1$s のアセット", (name, version) => {
  const ASSETS = join(FIXTURES_ROOT, "projects", `v${version}`, name, "assets");
  const { project } = loadFixtureProject(name, version);
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
