import type { EventCommand } from "@rpg/schema";
import { describe, expect, it } from "vitest";
import { commandTemplate, insertionPoint, removalRange } from "./command-templates.js";

const c = (code: string, indent = 0): EventCommand => ({ code, params: {}, indent });

describe("commandTemplate", () => {
  it("条件分岐は Else / EndBranch と、戦闘は ChoiceBranch×3 / EndBranch と一緒に入る。字下げを引き継ぐ", () => {
    expect(commandTemplate("ConditionalBranch", { condition: "x" }, 2).map((x) => [x.code, x.indent])).toEqual([["ConditionalBranch", 2], ["Else", 2], ["EndBranch", 2]]);
    const battle = commandTemplate("BattleProcessing", { troop: "t" }, 0);
    expect(battle.map((x) => x.code)).toEqual(["BattleProcessing", "ChoiceBranch", "ChoiceBranch", "ChoiceBranch", "EndBranch"]);
    expect(battle.filter((x) => x.code === "ChoiceBranch").map((x) => x.params)).toEqual([{ index: 0 }, { index: 1 }, { index: 2 }]);
    expect(commandTemplate("Wait", { frames: 1 }, 1)).toEqual([{ code: "Wait", params: { frames: 1 }, indent: 1 }]);
  });
});

describe("insertionPoint", () => {
  const list = [c("ConditionalBranch"), c("Wait", 1), c("Else"), c("EndBranch"), c("ShowText")];
  it("選択なしは末尾（字下げ 0）。分岐を開く行の直後は分岐の中（+1）、それ以外は同じ字下げ", () => {
    expect(insertionPoint(list, undefined)).toEqual({ at: 5, indent: 0 });
    expect(insertionPoint(list, 99)).toEqual({ at: 5, indent: 0 });
    expect(insertionPoint(list, 0)).toEqual({ at: 1, indent: 1 });
    expect(insertionPoint(list, 1)).toEqual({ at: 2, indent: 1 });
    expect(insertionPoint(list, 2)).toEqual({ at: 3, indent: 1 });
    expect(insertionPoint(list, 4)).toEqual({ at: 5, indent: 0 });
  });
});

describe("removalRange", () => {
  it("分岐の開始は対応する EndBranch まで。部品は単独で消せない。閉じていない分岐は末尾まで", () => {
    const list = [c("ConditionalBranch"), c("ConditionalBranch", 1), c("EndBranch", 1), c("Else"), c("EndBranch"), c("Wait")];
    expect(removalRange(list, 0)).toEqual({ at: 0, count: 5 });
    expect(removalRange(list, 1)).toEqual({ at: 1, count: 2 });
    expect(removalRange(list, 3)).toBeUndefined();
    expect(removalRange(list, 4)).toBeUndefined();
    expect(removalRange(list, 5)).toEqual({ at: 5, count: 1 });
    expect(removalRange(list, 9)).toBeUndefined();
    expect(removalRange([c("BattleProcessing"), c("Wait")], 0)).toEqual({ at: 0, count: 2 });
    expect(removalRange([c("ChoiceBranch")], 0)).toBeUndefined();
  });
});
