import { createCommandRegistry, defineCommand, registerBuiltins } from "@rpg/core";
import type { CommandRegistry } from "@rpg/core";
import type { EventCommand } from "@rpg/schema";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { applyOps, blockOwner, blockSpan, commandTemplate, copyRows, insertionPoint, isPart, moveSpan, pasteRows, removalRange, selectionSpan, syncDividers } from "./command-blocks.js";

let reg: CommandRegistry;
beforeAll(() => {
  reg = createCommandRegistry();
  registerBuiltins(reg);
  // プラグインの独自ブロック：選択肢のように区切り（Pick）が複数ある開始と、内側の終端
  const noRefs = () => [];
  reg.register(
    defineCommand({
      code: "plugin:x/Random",
      params: z.strictObject({ ways: z.number().int().min(1).default(2) }),
      meta: {
        label: "ランダム分岐",
        category: "フロー制御",
        describe: (p) => `ランダム：${p.ways}`,
        refs: noRefs,
        block: { role: "open", close: "plugin:x/EndRandom", bodyFirst: false, dividers: (p) => Array.from({ length: p.ways }, (_, k) => ({ code: "plugin:x/Way", params: { k } })) },
      },
      run: () => ({}),
    }),
  );
  reg.register(defineCommand({ code: "plugin:x/Way", params: z.strictObject({ k: z.number() }), meta: { label: "道", category: "フロー制御", describe: () => "道", refs: noRefs, block: { role: "divider" } }, run: () => ({}) }));
  reg.register(defineCommand({ code: "plugin:x/EndRandom", params: z.strictObject({}), meta: { label: "ランダム終了", category: "フロー制御", describe: () => "終了", refs: noRefs, block: { role: "close" } }, run: () => ({}) }));
});

const c = (code: string, indent = 0, params: Record<string, unknown> = {}): EventCommand => ({ code, params, indent });
const codes = (list: readonly EventCommand[]): string[] => list.map((x) => `${" ".repeat(x.indent)}${x.code}`);
/** 0 Cond / 1 A / 2 Else / 3 B / 4 End / 5 C */
const cond = (): EventCommand[] => [c("ConditionalBranch"), c("Wait", 1), c("Else"), c("ShowText", 1), c("EndBranch"), c("Comment")];

describe("isPart", () => {
  it("区切り・終端・内部用は単独で扱えない。開始やふつうのコマンド・未知のコマンドは扱える", () => {
    for (const code of ["Else", "ChoiceBranch", "EndBranch", "EndLoop", "MoveStep", "plugin:x/Way", "plugin:x/EndRandom"]) expect(isPart(reg, code)).toBe(true);
    for (const code of ["ConditionalBranch", "ShowChoices", "Loop", "Wait", "plugin:x/Random", "unknown"]) expect(isPart(reg, code)).toBe(false);
  });
});

describe("commandTemplate", () => {
  it("開始の行は、区切りと終端を一緒に入れる（字下げは引き継ぐ）", () => {
    expect(commandTemplate(reg, "ConditionalBranch", { condition: "x" }, 2).map((x) => [x.code, x.indent])).toEqual([["ConditionalBranch", 2], ["Else", 2], ["EndBranch", 2]]);
    const battle = commandTemplate(reg, "BattleProcessing", { troop: "t" }, 0);
    expect(codes(battle)).toEqual(["BattleProcessing", "ChoiceBranch", "ChoiceBranch", "ChoiceBranch", "EndBranch"]);
    expect(battle.filter((x) => x.code === "ChoiceBranch").map((x) => x.params)).toEqual([{ index: 0 }, { index: 1 }, { index: 2 }]);
    expect(codes(commandTemplate(reg, "Loop", {}, 1))).toEqual([" Loop", " EndLoop"]);
    const choices = commandTemplate(reg, "ShowChoices", { choices: ["a", "b", "c"] }, 0);
    expect(choices.filter((x) => x.code === "ChoiceBranch").map((x) => x.params)).toEqual([{ index: 0 }, { index: 1 }, { index: 2 }]);
    expect(commandTemplate(reg, "Wait", { frames: 1 }, 1)).toEqual([{ code: "Wait", params: { frames: 1 }, indent: 1 }]);
    expect(commandTemplate(reg, "unknown", {}, 0)).toEqual([c("unknown")]);
  });

  it("設定が不正でも区切りを入れる（戦闘の処理の敵グループが未設定のとき）。区切りを作れない設定なら、開始と終端だけ", () => {
    expect(codes(commandTemplate(reg, "BattleProcessing", { troop: "" }, 0))).toEqual(["BattleProcessing", "ChoiceBranch", "ChoiceBranch", "ChoiceBranch", "EndBranch"]);
    expect(codes(commandTemplate(reg, "ShowChoices", {}, 0))).toEqual(["ShowChoices", "EndBranch"]);
  });

  it("プラグインのブロックも、メタデータだけで区切りと終端が入る", () => {
    expect(codes(commandTemplate(reg, "plugin:x/Random", { ways: 3 }, 0))).toEqual(["plugin:x/Random", "plugin:x/Way", "plugin:x/Way", "plugin:x/Way", "plugin:x/EndRandom"]);
  });
});

describe("blockOwner / blockSpan / removalRange", () => {
  const list = [...cond(), c("ShowChoices"), c("ChoiceBranch"), c("Wait", 1), c("ChoiceBranch"), c("EndBranch")];
  it("区切り・終端は、同じ字下げをさかのぼって開始の行を見つける。本体の行や、前のブロックの終端を越えては見つけない", () => {
    expect(blockOwner(reg, list, 2)).toBe(0);
    expect(blockOwner(reg, list, 4)).toBe(0);
    expect(blockOwner(reg, list, 7)).toBe(6);
    expect(blockOwner(reg, list, 9)).toBe(6);
    expect(blockOwner(reg, [c("EndBranch")], 0)).toBeUndefined();
    expect(blockOwner(reg, [c("ConditionalBranch"), c("EndBranch"), c("Else")], 2)).toBeUndefined();
    expect(blockOwner(reg, [c("Wait", 1), c("Else")], 1)).toBeUndefined();
    expect(blockOwner(reg, list, 99)).toBeUndefined();
  });

  it("開始の行・区切り・終端の行はブロック全体、ふつうの行は 1 行。閉じていなければ末尾まで", () => {
    for (const i of [0, 2, 4]) expect(blockSpan(reg, list, i)).toEqual({ at: 0, count: 5 });
    expect(blockSpan(reg, list, 1)).toEqual({ at: 1, count: 1 });
    expect(blockSpan(reg, list, 5)).toEqual({ at: 5, count: 1 });
    expect(blockSpan(reg, list, 9)).toEqual({ at: 6, count: 5 });
    expect(blockSpan(reg, list, 8)).toEqual({ at: 8, count: 1 });
    expect(blockSpan(reg, [c("EndBranch")], 0)).toEqual({ at: 0, count: 1 });
    expect(blockSpan(reg, list, 99)).toBeUndefined();
    expect(blockSpan(reg, [c("BattleProcessing"), c("Wait")], 0)).toEqual({ at: 0, count: 2 });
    expect(blockSpan(reg, [c("Loop"), c("Wait", 1), c("Comment")], 0)).toEqual({ at: 0, count: 3 });
  });

  it("入れ子のブロックは、対応を取って範囲を決める", () => {
    const nested = [c("ConditionalBranch"), c("ConditionalBranch", 1), c("EndBranch", 1), c("Else"), c("EndBranch"), c("Wait")];
    expect(blockSpan(reg, nested, 0)).toEqual({ at: 0, count: 5 });
    expect(blockSpan(reg, nested, 1)).toEqual({ at: 1, count: 2 });
    expect(blockSpan(reg, nested, 2)).toEqual({ at: 1, count: 2 });
  });

  it("消す・動かす・コピーする範囲は、区切り・終端・内部用の行では得られない", () => {
    expect(removalRange(reg, list, 0)).toEqual({ at: 0, count: 5 });
    expect(removalRange(reg, list, 1)).toEqual({ at: 1, count: 1 });
    for (const i of [2, 4, 7, 9]) expect(removalRange(reg, list, i)).toBeUndefined();
    expect(removalRange(reg, [c("MoveStep")], 0)).toBeUndefined();
    expect(removalRange(reg, list, 99)).toBeUndefined();
  });
});

describe("selectionSpan", () => {
  const list = cond();
  it("本体の中の行だけを選んだときは、そのまま（順不同）", () => {
    const body = [c("ConditionalBranch"), c("Wait", 1), c("Comment", 1), c("ShowText", 1), c("Else"), c("EndBranch")];
    expect(selectionSpan(reg, body, 1, 3)).toEqual({ at: 1, count: 3 });
    expect(selectionSpan(reg, body, 3, 1)).toEqual({ at: 1, count: 3 });
    expect(selectionSpan(reg, body, 2, 2)).toEqual({ at: 2, count: 1 });
  });

  it("開始・区切り・終端にかかるときは、ブロック全体まで広げる。ブロックの外の行までつなげれば、その行まで", () => {
    expect(selectionSpan(reg, list, 0, 0)).toEqual({ at: 0, count: 5 });
    expect(selectionSpan(reg, list, 1, 3)).toEqual({ at: 0, count: 5 }); // Else をまたぐ
    expect(selectionSpan(reg, list, 4, 4)).toEqual({ at: 0, count: 5 });
    expect(selectionSpan(reg, list, 3, 5)).toEqual({ at: 0, count: 6 }); // 終端を含む → 全体 + 後ろの行
    expect(selectionSpan(reg, [c("Wait"), ...list], 0, 2)).toEqual({ at: 0, count: 6 });
  });

  it("入れ子：内側のブロックにかかれば、内側のブロック全体まで", () => {
    const nested = [c("ConditionalBranch"), c("Wait", 1), c("ConditionalBranch", 1), c("Comment", 2), c("Else", 1), c("Comment", 2), c("EndBranch", 1), c("Wait", 1), c("Else"), c("EndBranch")];
    expect(selectionSpan(reg, nested, 1, 3)).toEqual({ at: 1, count: 6 });
    expect(selectionSpan(reg, nested, 3, 5)).toEqual({ at: 2, count: 5 });
  });

  it("範囲の外の行は undefined", () => {
    expect(selectionSpan(reg, list, 0, 99)).toBeUndefined();
    expect(selectionSpan(reg, list, -1, 2)).toBeUndefined();
  });
});

describe("insertionPoint", () => {
  const list = [...cond(), c("ShowChoices"), c("ChoiceBranch"), c("Loop"), c("EndLoop"), c("ShowText")];
  it("選択なしは末尾（字下げ 0）。本体が続く行（条件分岐・ループの開始・区切り）はブロックの中（+1）、それ以外は同じ字下げ", () => {
    expect(insertionPoint(reg, list, undefined)).toEqual({ at: list.length, indent: 0 });
    expect(insertionPoint(reg, list, 99)).toEqual({ at: list.length, indent: 0 });
    expect(insertionPoint(reg, list, 0)).toEqual({ at: 1, indent: 1 }); // 条件分岐
    expect(insertionPoint(reg, list, 1)).toEqual({ at: 2, indent: 1 });
    expect(insertionPoint(reg, list, 2)).toEqual({ at: 3, indent: 1 }); // Else
    expect(insertionPoint(reg, list, 4)).toEqual({ at: 5, indent: 0 }); // 終端
    expect(insertionPoint(reg, list, 6)).toEqual({ at: 7, indent: 0 }); // 選択肢の開始（直後は区切り）
    expect(insertionPoint(reg, list, 7)).toEqual({ at: 8, indent: 1 }); // 区切り
    expect(insertionPoint(reg, list, 8)).toEqual({ at: 9, indent: 1 }); // ループ
    expect(insertionPoint(reg, list, 9)).toEqual({ at: 10, indent: 0 });
  });
});

describe("syncDividers", () => {
  const choices = (n: number): EventCommand[] => [c("ShowChoices", 0, { choices: Array.from({ length: n }, (_, i) => `c${i}`) }), ...Array.from({ length: n }, (_, i) => [c("ChoiceBranch", 0, { index: i }), c("Wait", 1)]).flat(), c("EndBranch"), c("Comment")];
  it("選択肢が増えたら、終端の前に空の分岐を足す。減ったら、余った分岐を本体ごと消す。同じなら何もしない", () => {
    const two = choices(2);
    expect(syncDividers(reg, two, 0, { choices: ["a", "b"] })).toEqual([]);
    expect(syncDividers(reg, two, 0, { choices: ["a", "b", "c", "d"] })).toEqual([{ op: "insert", at: 5, commands: [c("ChoiceBranch", 0, { index: 2 }), c("ChoiceBranch", 0, { index: 3 })] }]);
    expect(applyOps(two, syncDividers(reg, two, 0, { choices: ["a"] }))).toEqual([two[0], two[1], two[2], two[5], two[6]]);
  });

  it("選択肢のない行・開始でない行・設定が不正・閉じていない分岐・区切りを作れない行は何もしない。字下げも引き継ぐ", () => {
    expect(syncDividers(reg, cond(), 1, {})).toEqual([]);
    expect(syncDividers(reg, cond(), 99, {})).toEqual([]);
    expect(syncDividers(reg, choices(2), 0, { choices: [] })).toEqual([]); // min(1) に反する
    expect(syncDividers(reg, [c("ShowChoices", 0, { choices: ["a"] }), c("ChoiceBranch")], 0, { choices: ["a", "b"] })).toEqual([]);
    expect(syncDividers(reg, cond(), 0, { condition: "x" })).toEqual([]); // 条件分岐の区切りは Else 1 つのまま
    const nested = [c("Loop"), ...choices(1).map((x) => ({ ...x, indent: x.indent + 1 })), c("EndLoop")];
    expect(syncDividers(reg, nested, 1, { choices: ["a", "b"] })).toEqual([{ op: "insert", at: 4, commands: [c("ChoiceBranch", 1, { index: 1 })] }]);
  });

  it("プラグインのブロックも、区切りの数を合わせる", () => {
    const list = [c("plugin:x/Random", 0, { ways: 1 }), c("plugin:x/Way", 0, { k: 0 }), c("plugin:x/EndRandom")];
    expect(syncDividers(reg, list, 0, { ways: 3 })).toEqual([{ op: "insert", at: 2, commands: [c("plugin:x/Way", 0, { k: 1 }), c("plugin:x/Way", 0, { k: 2 })] }]);
  });
});

describe("moveSpan", () => {
  // 0 Wait / 1 Cond / 2 Wait / 3 Else / 4 ShowText / 5 EndBranch / 6 Comment
  const list = [c("Wait"), c("ConditionalBranch"), c("Wait", 1), c("Else"), c("ShowText", 1), c("EndBranch"), c("Comment")];
  it("ふつうの行は、となりの行やブロック全体を飛び越える。動かしたあとの範囲を返す", () => {
    const down = moveSpan(reg, list, { at: 0, count: 1 }, "down")!;
    expect(codes(applyOps(list, down.ops))).toEqual(["ConditionalBranch", " Wait", "Else", " ShowText", "EndBranch", "Wait", "Comment"]);
    expect(down.span).toEqual({ at: 5, count: 1 });
    const up = moveSpan(reg, list, { at: 6, count: 1 }, "up")!;
    expect(codes(applyOps(list, up.ops))).toEqual(["Wait", "Comment", "ConditionalBranch", " Wait", "Else", " ShowText", "EndBranch"]);
    expect(up.span).toEqual({ at: 1, count: 1 });
  });

  it("ブロックごと動かせる。複数行の範囲も、そのまま動く", () => {
    const block = moveSpan(reg, list, { at: 1, count: 5 }, "up")!;
    expect(codes(applyOps(list, block.ops))).toEqual(["ConditionalBranch", " Wait", "Else", " ShowText", "EndBranch", "Wait", "Comment"]);
    expect(block.span).toEqual({ at: 0, count: 5 });
    const two = moveSpan(reg, list, { at: 0, count: 6 }, "down")!;
    expect(codes(applyOps(list, two.ops))).toEqual(["Comment", "Wait", "ConditionalBranch", " Wait", "Else", " ShowText", "EndBranch"]);
    expect(two.span).toEqual({ at: 1, count: 6 });
  });

  it("本体の端や、区切り・終端は越えない（別の分岐へは、切り取りと貼り付けで動かす）。先頭・末尾も動かない", () => {
    expect(moveSpan(reg, list, { at: 2, count: 1 }, "up")).toBeUndefined(); // 本体の先頭
    expect(moveSpan(reg, list, { at: 2, count: 1 }, "down")).toBeUndefined(); // Else が次
    expect(moveSpan(reg, list, { at: 4, count: 1 }, "down")).toBeUndefined(); // 終端が次
    expect(moveSpan(reg, list, { at: 4, count: 1 }, "up")).toBeUndefined(); // Else が前
    expect(moveSpan(reg, list, { at: 0, count: 1 }, "up")).toBeUndefined();
    expect(moveSpan(reg, list, { at: 6, count: 1 }, "down")).toBeUndefined();
    expect(moveSpan(reg, list, { at: 6, count: 0 }, "up")).toBeUndefined();
    expect(moveSpan(reg, list, { at: 9, count: 1 }, "up")).toBeUndefined();
  });

  it("本体の中では、同じ本体の中のとなりどうしで入れ替わる", () => {
    const body = [c("Loop"), c("Wait", 1), c("ShowText", 1), c("Comment", 1), c("EndLoop")];
    const r = moveSpan(reg, body, { at: 1, count: 1 }, "down")!;
    expect(codes(applyOps(body, r.ops))).toEqual(["Loop", " ShowText", " Wait", " Comment", "EndLoop"]);
    expect(moveSpan(reg, body, { at: 3, count: 1 }, "down")).toBeUndefined();
  });

  it("字下げがちがう行（壊れた並び）は越えない", () => {
    expect(moveSpan(reg, [c("Wait", 1), c("Wait")], { at: 1, count: 1 }, "up")).toBeUndefined();
    expect(moveSpan(reg, [c("EndBranch"), c("Wait")], { at: 1, count: 1 }, "up")).toBeUndefined(); // 属する開始の無い終端
  });
});

describe("copyRows / pasteRows", () => {
  it("コピーは字下げが 0 始まりになり、貼り付けは貼る場所の字下げに合わせる", () => {
    const list = [c("Loop", 2), c("Wait", 3), c("EndLoop", 2), c("Comment", 2)];
    const rows = copyRows(list, { at: 0, count: 3 });
    expect(codes(rows)).toEqual(["Loop", " Wait", "EndLoop"]);
    expect(codes(pasteRows(rows, 1))).toEqual([" Loop", "  Wait", " EndLoop"]);
    expect(copyRows(list, { at: 9, count: 2 })).toEqual([]);
    expect(rows[0]).not.toBe(list[0]); // コピーは別の行（元の字下げを壊さない）
    expect(list[0]!.indent).toBe(2);
  });
});
