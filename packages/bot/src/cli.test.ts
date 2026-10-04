import { describe, expect, it } from "vitest";
import { loadProjectDir, parseEquips, parseItems, parseLevels, runBotCli } from "./cli.js";

describe("pnpm bot（cli.ts）", () => {
  it("レベルの指定：範囲とカンマ区切り（重なりは 1 回）", () => {
    expect(parseLevels("3-6")).toEqual([3, 4, 5, 6]);
    expect(parseLevels("6-4")).toEqual([6, 5, 4]);
    expect(parseLevels("1,5, 9,5")).toEqual([1, 5, 9]);
    expect(() => parseLevels("x")).toThrow(/--levels/);
    expect(() => parseLevels("0")).toThrow(/--levels/);
  });

  it("持ち物と装備の指定", () => {
    expect(parseItems("potion:3, ether:0")).toEqual({ potion: 3, ether: 0 });
    expect(() => parseItems("potion")).toThrow(/--items/);
    expect(() => parseItems("potion:-1")).toThrow(/--items/);
    expect(parseEquips("actor_hero:wp_iron,actor_hero:ar_iron,actor_mina:wp_rod")).toEqual({ actor_hero: ["wp_iron", "ar_iron"], actor_mina: ["wp_rod"] });
    expect(() => parseEquips("wp_iron")).toThrow(/--equip/);
  });

  it("フォルダか fixtures の名前でプロジェクトを読む", () => {
    expect(loadProjectDir("hokora").project.troop("tr_boss" as never)?.name).toBe("ほこらの主");
    expect(() => loadProjectDir("no-such-project")).toThrow(/project.json/);
  });

  it("表で出す。--json なら JSON。敵グループは all・カンマ区切りで複数", () => {
    const table = runBotCli(["hokora", "--troop", "tr_slime,tr_bat", "--levels", "1-2", "--runs", "2", "--equip", "actor_hero:wp_iron", "--items", "item_potion:1"]);
    expect(table).toMatch(/^■ スライム（tr_slime）  パーティ：勇者・ミナ  作戦：smart  各 2 回\nLv\t勝率/);
    expect(table).toContain("■ こうもり（tr_bat）");
    expect(table.split("\n").filter((l) => /^\d+\t/.test(l))).toHaveLength(4);
    const json = JSON.parse(runBotCli(["hokora", "--troop", "tr_slime", "--runs", "1", "--policy", "attack", "--json"])) as { troop: string; levels: { level: number; winRate: number }[] }[];
    expect(json).toEqual([{ troop: "tr_slime", levels: [expect.objectContaining({ level: 1, winRate: 1 })] }]);
    const all = JSON.parse(runBotCli(["hokora", "--troop", "all", "--runs", "1", "--json"])) as unknown[];
    expect(all.length).toBeGreaterThan(5);
  });

  it("使い方の間違いは例外", () => {
    expect(() => runBotCli(["hokora"])).toThrow(/使い方/);
    expect(() => runBotCli(["hokora", "--troop", "tr_slime", "--policy", "nope"])).toThrow(/--policy/);
    expect(() => runBotCli(["hokora", "--troop", "tr_slime", "--runs", "0"])).toThrow(/--runs/);
  });
});
