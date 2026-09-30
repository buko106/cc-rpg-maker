import type { EventCommand } from "@rpg/schema";
import { describe, expect, it } from "vitest";
import { applyOps, commandTemplate, insertionPoint, removalRange, syncChoiceBranches } from "./command-templates.js";

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

describe("ループと選択肢（M6）", () => {
  it("Loop は EndLoop と、ShowChoices は選択肢の数だけの ChoiceBranch と EndBranch と一緒に入る", () => {
    expect(commandTemplate("Loop", {}, 1).map((x) => [x.code, x.indent])).toEqual([["Loop", 1], ["EndLoop", 1]]);
    const choices = commandTemplate("ShowChoices", { choices: ["a", "b", "c"] }, 0);
    expect(choices.map((x) => x.code)).toEqual(["ShowChoices", "ChoiceBranch", "ChoiceBranch", "ChoiceBranch", "EndBranch"]);
    expect(choices.filter((x) => x.code === "ChoiceBranch").map((x) => x.params)).toEqual([{ index: 0 }, { index: 1 }, { index: 2 }]);
    expect(commandTemplate("ShowChoices", {}, 0).filter((x) => x.code === "ChoiceBranch")).toHaveLength(1);
  });

  it("Loop の直後はループの中（+1）。Loop は EndLoop まで一緒に消え、EndLoop / MoveStep は単独で消せない", () => {
    const list = [c("Loop"), c("Wait", 1), c("EndLoop"), c("ShowChoices"), c("ChoiceBranch"), c("Wait", 1), c("ChoiceBranch"), c("EndBranch")];
    expect(insertionPoint(list, 0)).toEqual({ at: 1, indent: 1 });
    expect(removalRange(list, 0)).toEqual({ at: 0, count: 3 });
    expect(removalRange(list, 2)).toBeUndefined();
    expect(removalRange(list, 3)).toEqual({ at: 3, count: 5 });
    expect(removalRange([c("MoveStep")], 0)).toBeUndefined();
  });
});

describe("syncChoiceBranches", () => {
  const branch = (index: number, indent = 0): EventCommand => ({ code: "ChoiceBranch", params: { index }, indent });
  const list = (n: number): EventCommand[] => [c("ShowChoices"), ...Array.from({ length: n }, (_, k) => [branch(k), c("Wait", 1)]).flat(), c("EndBranch")];

  it("選択肢が増えたら EndBranch の前に空の分岐を足す", () => {
    const ops = syncChoiceBranches(list(2), 0, 4);
    const next = applyOps(list(2), ops);
    expect(next.filter((x) => x.code === "ChoiceBranch").map((x) => x.params["index"])).toEqual([0, 1, 2, 3]);
    expect(next.at(-1)!.code).toBe("EndBranch");
    expect(next).toHaveLength(list(2).length + 2);
  });

  it("選択肢が減ったら余った分岐を本体ごと消す", () => {
    const next = applyOps(list(3), syncChoiceBranches(list(3), 0, 1));
    expect(next.map((x) => x.code)).toEqual(["ShowChoices", "ChoiceBranch", "Wait", "EndBranch"]);
  });

  it("同じ数・ShowChoices でない行・EndBranch が無いときは何もしない。字下げも引き継ぐ", () => {
    expect(syncChoiceBranches(list(2), 0, 2)).toEqual([]);
    expect(syncChoiceBranches(list(2), 1, 1)).toEqual([]);
    expect(syncChoiceBranches([c("ShowChoices"), branch(0)], 0, 3)).toEqual([]);
    const nested = [c("Loop"), c("ShowChoices", 1), branch(0, 1), c("EndBranch", 1), c("EndLoop")];
    const next = applyOps(nested, syncChoiceBranches(nested, 1, 2));
    expect(next.filter((x) => x.code === "ChoiceBranch").map((x) => x.indent)).toEqual([1, 1]);
  });
});

describe("applyOps", () => {
  it("挿入・削除・差し替えを順に適用する（後の位置は前の操作のあと）", () => {
    const base = [c("A"), c("B"), c("C")];
    const next = applyOps(base, [
      { op: "replace", at: 1, command: c("B2") },
      { op: "insert", at: 0, commands: [c("X"), c("Y")] },
      { op: "remove", at: 3, count: 1 },
    ]);
    expect(next.map((x) => x.code)).toEqual(["X", "Y", "A", "C"]);
    expect(base.map((x) => x.code)).toEqual(["A", "B", "C"]);
  });
});
