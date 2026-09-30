import { describe, expect, it } from "vitest";
import { loadFixtureProject } from "@rpg/test-utils";
import { collectStartAssets } from "./preload.js";

describe("collectStartAssets", () => {
  it("タイルセット画像・アクターの歩行グラフィック・開始マップのイベントの絵・敵の絵・BGM を、重複なく集める", () => {
    const { project, maps } = loadFixtureProject("demo");
    const ids = collectStartAssets(project, maps["map_town" as never]!);
    expect(ids).toEqual([
      "0c4fa5c6a7e06cb7", // スライム（マップ）
      "0eefde69801856a9", // npc
      "54bc63c07507e5c4", // スライム（戦闘）
      "87073bd84cdaced6", // 戦闘 BGM
      "96d90b7571e30700", // ネコ
      "a879bad5bc621a64", // ヒヨコ
      "b9b596c2f04468ac", // tileset
      "bb2e23b45d1f4d4d", // hero
    ]);
  });

  it("マニフェストに無い ID は含めない", () => {
    const { project, maps } = loadFixtureProject("demo");
    const town = maps["map_town" as never]!;
    const trimmed = { ...project, assets: { entries: { bb2e23b45d1f4d4d: project.assets.entries["bb2e23b45d1f4d4d" as never] } } } as never;
    expect(collectStartAssets(trimmed, town)).toEqual(["bb2e23b45d1f4d4d"]);
  });
});
