import { describe, expect, it } from "vitest";
import { loadFixtureProject } from "@rpg/test-utils";
import { collectStartAssets } from "./preload.js";

describe("collectStartAssets", () => {
  it("タイルセット画像・アクターの歩行グラフィック・開始マップのイベントの絵を、重複なく集める", () => {
    const { project, maps } = loadFixtureProject("demo");
    const ids = collectStartAssets(project, maps["map_town" as never]!);
    expect(ids).toEqual(["0eefde69801856a9", "b9b596c2f04468ac", "bb2e23b45d1f4d4d"]); // npc, tileset, hero
  });

  it("マニフェストに無い ID は含めない", () => {
    const { project, maps } = loadFixtureProject("demo");
    const town = maps["map_town" as never]!;
    const trimmed = { ...project, assets: { entries: { bb2e23b45d1f4d4d: project.assets.entries["bb2e23b45d1f4d4d" as never] } } } as never;
    expect(collectStartAssets(trimmed, town)).toEqual(["bb2e23b45d1f4d4d"]);
  });
});
