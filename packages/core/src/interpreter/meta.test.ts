import type { EventCommand } from "@rpg/schema";
import { cmd, loadFixtureProject } from "@rpg/test-utils";
import { describe, expect, it } from "vitest";

const { ctx, view: project } = loadFixtureProject("transfer-demo");

/** 各組み込みコマンドの、エディタ向けメタ情報（1 行表示と参照）。 */
const cases: [EventCommand, string, unknown[]][] = [
  [cmd("ShowText", { text: "1行目\n2行目" }), "文章：1行目", []],
  [cmd("ShowText", { text: "x", face: { asset: "0123456789abcdef" } }), "文章：x", [{ kind: "asset", id: "0123456789abcdef" }]],
  [cmd("ControlSwitches", { ids: ["a", "b"], value: true }), "スイッチ a, b = ON", [{ kind: "switch", id: "a" }, { kind: "switch", id: "b" }]],
  [cmd("ControlSwitches", { ids: ["a"], value: false }), "スイッチ a = OFF", [{ kind: "switch", id: "a" }]],
  [cmd("ControlVariables", { ids: ["x"], op: "add", operand: { kind: "constant", value: 3 } }), "変数 x ＋ 3", [{ kind: "variable", id: "x" }]],
  [cmd("ControlVariables", { ids: ["x"], op: "set", operand: { kind: "variable", id: "y" } }), "変数 x ＝ 変数 y", [{ kind: "variable", id: "x" }, { kind: "variable", id: "y" }]],
  [cmd("ControlVariables", { ids: ["x"], op: "mul", operand: { kind: "random", min: 1, max: 6 } }), "変数 x × 乱数 1〜6", [{ kind: "variable", id: "x" }]],
  [cmd("ControlVariables", { ids: ["x"], op: "sub", operand: { kind: "expr", expr: "1+1" } }), "変数 x － 式 1+1", [{ kind: "variable", id: "x" }]],
  [cmd("ControlVariables", { ids: ["x"], op: "div", operand: { kind: "constant", value: 2 } }), "変数 x ÷ 2", [{ kind: "variable", id: "x" }]],
  [cmd("ControlVariables", { ids: ["x"], op: "mod", operand: { kind: "constant", value: 2 } }), "変数 x ％ 2", [{ kind: "variable", id: "x" }]],
  [cmd("ConditionalBranch", { condition: 'v("a") > 1' }), '条件分岐：v("a") > 1', []],
  [cmd("ConditionalBranch", { condition: { kind: "switch", id: "s", value: true } }), "条件分岐：スイッチ s == ON", [{ kind: "switch", id: "s" }]],
  [cmd("ConditionalBranch", { condition: { kind: "switch", id: "s", value: false } }), "条件分岐：スイッチ s == OFF", [{ kind: "switch", id: "s" }]],
  [cmd("ConditionalBranch", { condition: { kind: "variable", id: "v", op: ">=", value: 3 } }), "条件分岐：変数 v >= 3", [{ kind: "variable", id: "v" }]],
  // 名前のあるスイッチ・変数は名前で出す
  [cmd("ControlSwitches", { ids: ["sw_entered", "a"], value: true }), "スイッチ 入室済み, a = ON", [{ kind: "switch", id: "sw_entered" }, { kind: "switch", id: "a" }]],
  [cmd("ControlVariables", { ids: ["var_visits"], op: "add", operand: { kind: "variable", id: "var_visits" } }), "変数 訪問回数 ＋ 変数 訪問回数", [{ kind: "variable", id: "var_visits" }, { kind: "variable", id: "var_visits" }]],
  [cmd("ConditionalBranch", { condition: { kind: "switch", id: "sw_entered", value: true } }), "条件分岐：スイッチ 入室済み == ON", [{ kind: "switch", id: "sw_entered" }]],
  [cmd("ConditionalBranch", { condition: { kind: "variable", id: "var_visits", op: "<=", value: 1 } }), "条件分岐：変数 訪問回数 <= 1", [{ kind: "variable", id: "var_visits" }]],
  [cmd("Else"), "それ以外のとき", []],
  [cmd("EndBranch"), "分岐終了", []],
  [cmd("Wait", { frames: 30 }), "ウェイト：30フレーム", []],
  [cmd("TransferPlayer", { mapId: "map_b", x: 2, y: 3 }), "場所移動：map_b (2, 3)", [{ kind: "map", id: "map_b" }]],
  [cmd("ChoiceBranch", { index: 1 }), "分岐 1", []],
  [cmd("BattleProcessing", { troop: "tr_x" }), "戦闘の処理：tr_x", [{ kind: "troop", id: "tr_x" }]],
  [cmd("BattleProcessing", { troop: "tr_x", canEscape: false, canLose: true }), "戦闘の処理：tr_x（逃走不可）（敗北可）", [{ kind: "troop", id: "tr_x" }]],
  [cmd("Comment", { text: "メモ\n2行目" }), "注釈：メモ", []],
  [cmd("Loop"), "ループ", []],
  [cmd("BreakLoop"), "ループの中断", []],
  [cmd("EndLoop"), "以上繰り返し", []],
  [cmd("ExitEventProcessing"), "イベント処理の中断", []],
  [cmd("CallCommonEvent", { id: "ce_x" }), "コモンイベント：ce_x", [{ kind: "commonEvent", id: "ce_x" }]],
  [cmd("Label", { name: "top" }), "ラベル：top", []],
  [cmd("JumpToLabel", { name: "top" }), "ラベルジャンプ：top", []],
  [cmd("ControlSelfSwitch", { key: "A", value: true }), "セルフスイッチ A = ON", []],
  [cmd("ControlTimer", { op: "start", seconds: 5 }), "タイマー開始：5秒", []],
  [cmd("ControlTimer", { op: "stop" }), "タイマー停止", []],
  [cmd("ChangeGold", { op: "gain", amount: { kind: "constant", value: 100 } }), "所持金を100だけ増やす", []],
  [cmd("ChangeGold", { op: "lose", amount: { kind: "variable", id: "g" } }), "所持金を変数 gだけ減らす", [{ kind: "variable", id: "g" }]],
  [cmd("ChangeItems", { item: "it_x", op: "gain", amount: { kind: "constant", value: 2 } }), "it_x を2個増やす", [{ kind: "item", id: "it_x" }]],
  [cmd("ChangeParty", { actor: "ac_x", op: "add" }), "パーティ：ac_x を加える", [{ kind: "actor", id: "ac_x" }]],
  [cmd("ChangeParty", { actor: "ac_x", op: "remove" }), "パーティ：ac_x を外す", [{ kind: "actor", id: "ac_x" }]],
  [cmd("ChangeHp", { op: "lose", amount: { kind: "constant", value: 5 } }), "パーティ全員 の HP を5減らす", []],
  [cmd("ChangeMp", { target: "ac_x", op: "gain", amount: { kind: "constant", value: 5 } }), "ac_x の MP を5増やす", [{ kind: "actor", id: "ac_x" }]],
  [cmd("ChangeExp", { amount: { kind: "constant", value: 30 } }), "パーティ全員 の経験値を30増やす", []],
  [cmd("ChangeLevel", { op: "gain", amount: { kind: "constant", value: 1 } }), "パーティ全員 のレベルを1増やす", []],
  [cmd("ShowChoices", { choices: ["はい", "いいえ"] }), "選択肢：はい / いいえ", []],
  [cmd("InputNumber", { variable: "n" }), "数値入力：変数 n（4桁）", [{ kind: "variable", id: "n" }]],
  [cmd("SelectItem", { variable: "n" }), "アイテム選択：変数 n", [{ kind: "variable", id: "n" }]],
  [cmd("ShopProcessing", { goods: ["it_a", "it_b"] }), "ショップ：it_a、it_b", [{ kind: "item", id: "it_a" }, { kind: "item", id: "it_b" }]],
  [cmd("SetMoveRoute", { route: { repeat: false, skippable: false, steps: [{ kind: "wait", frames: 1 }] } }), "移動ルート：このイベント（1歩）", []],
  [cmd("SetMoveRoute", { target: "player", route: { repeat: false, skippable: false, steps: [] } }), "移動ルート：プレイヤー（0歩）", []],
  [cmd("SetEventLocation", { target: "ev_rock", x: 3, y: 4 }), "イベントの位置：イベント ev_rock → (3, 4)", []],
  [cmd("SetEventLocation", { x: 1, y: 2, dir: "up" }), "イベントの位置：このイベント → (1, 2)", []],
  [cmd("ChangeMapTile", { layer: 1, x: 3, y: 4, tile: 0 }), "マップタイル：このマップ 層1 (3, 4) → 0", []],
  [cmd("ChangeMapTile", { map: "map_b", x: 1, y: 2, width: 3, height: 2, tile: 9 }), "マップタイル：map_b 層0 (1, 2) から 3×2 → 9", [{ kind: "map", id: "map_b" }]],
  [cmd("SetMoveRoute", { target: "ev_x", route: { repeat: false, skippable: false, steps: [] } }), "移動ルート：イベント ev_x（0歩）", []],
  [cmd("MoveStep", { who: "player", step: { kind: "turn", dir: "up" } }), "移動ルート：turn", []],
  [cmd("WaitPlayerStep", { turns: 2 }), "プレイヤーの 2 手を待つ", []],
  [cmd("ChangeBgm", { audio: { asset: "0123456789abcdef", volume: 1, pitch: 1, loop: true } }), "BGM：0123456789abcdef", [{ kind: "asset", id: "0123456789abcdef" }]],
  [cmd("PlaySe", { audio: { asset: "0123456789abcdef", volume: 1, pitch: 1, loop: false } }), "SE：0123456789abcdef", [{ kind: "asset", id: "0123456789abcdef" }]],
  [cmd("FadeoutBgm"), "BGM をフェードアウト：1000ms", []],
  [cmd("ShakeScreen"), "シェイク：強さ 5、30フレーム", []],
  [cmd("FlashScreen"), "フラッシュ：30フレーム", []],
  [cmd("TintScreen", { color: { r: 0, g: 0, b: 1, a: 0.5 } }), "色調変更：30フレーム", []],
  [cmd("Fadeout"), "フェードアウト：30フレーム", []],
  [cmd("Fadein", { duration: 10 }), "フェードイン：10フレーム", []],
  [cmd("SaveGame"), "セーブ画面を開く", []],
  [cmd("LoadGame"), "ロード画面を開く", []],
  [cmd("GameOver"), "ゲームオーバー", []],
  [cmd("ReturnToTitle"), "タイトルへ戻る", []],
  [cmd("Script", { expr: "setVar(\"a\", 1)" }), "スクリプト：setVar(\"a\", 1)", []],
];

describe("builtin command metadata", () => {
  it.each(cases)("%j", (command, description, refs) => {
    const handler = ctx.commands.get(command.code)!;
    const params = handler.params.parse(command.params);
    expect(handler.meta.describe(params, project)).toBe(description);
    expect(handler.meta.refs(params)).toEqual(refs);
  });

  it("分岐を持つコマンドは、分岐の見出し（branchLabel）を持つ", () => {
    const choices = ctx.commands.get("ShowChoices")!;
    const p = choices.params.parse({ choices: ["泊まる", "やめる"] });
    expect([0, 1, 2].map((i) => choices.meta.branchLabel!(p, i))).toEqual(["[泊まる] のとき", "[やめる] のとき", "[選択肢 3] のとき"]);
    const battle = ctx.commands.get("BattleProcessing")!;
    const b = battle.params.parse({ troop: "tr_x" });
    expect([0, 1, 2, 3].map((i) => battle.meta.branchLabel!(b, i))).toEqual(["勝ったとき", "逃げたとき", "負けたとき", "分岐 3"]);
    expect(ctx.commands.get("ShowText")!.meta.branchLabel).toBeUndefined();
  });

  it("every builtin has a label and a category for the editor", () => {
    for (const h of ctx.commands.list()) {
      expect(h.meta.label, h.code).not.toBe("");
      expect(h.meta.category, h.code).not.toBe("");
    }
  });

  it("every builtin's describe() and refs() accept whatever params.parse() produces (defaults applied)", () => {
    const minimal: Record<string, Record<string, unknown>> = {
      ShowText: { text: "" },
      ControlSwitches: { ids: ["a"], value: true },
      ControlVariables: { ids: ["a"], op: "set", operand: { kind: "constant", value: 0 } },
      ConditionalBranch: { condition: "true" },
      Else: {},
      EndBranch: {},
      Wait: { frames: 0 },
      TransferPlayer: { mapId: "map_a", x: 0, y: 0 },
      ChoiceBranch: { index: 0 },
      BattleProcessing: { troop: "tr_x" },
      Comment: {}, Loop: {}, BreakLoop: {}, EndLoop: {}, ExitEventProcessing: {},
      CallCommonEvent: { id: "ce_x" }, Label: { name: "a" }, JumpToLabel: { name: "a" },
      ControlSelfSwitch: { key: "A", value: true }, ControlTimer: { op: "stop" },
      ChangeGold: { op: "gain", amount: { kind: "constant", value: 1 } },
      ChangeItems: { item: "it_x", op: "gain", amount: { kind: "constant", value: 1 } },
      ChangeParty: { actor: "ac_x", op: "add" },
      ChangeHp: { op: "gain", amount: { kind: "constant", value: 1 } },
      ChangeMp: { op: "gain", amount: { kind: "constant", value: 1 } },
      ChangeExp: { amount: { kind: "constant", value: 1 } },
      ChangeLevel: { op: "gain", amount: { kind: "constant", value: 1 } },
      ShowChoices: { choices: ["a"] }, InputNumber: { variable: "n" }, SelectItem: { variable: "n" }, ShopProcessing: { goods: ["it_x"] },
      SetMoveRoute: { route: { repeat: false, skippable: false, steps: [] } },
      SetEventLocation: { x: 0, y: 0 },
      ChangeMapTile: { x: 0, y: 0, tile: 0 },
      MoveStep: { who: "player", step: { kind: "wait", frames: 1 } },
      WaitPlayerStep: {},
      ChangeBgm: { audio: { asset: "0123456789abcdef", volume: 1, pitch: 1, loop: true } },
      PlaySe: { audio: { asset: "0123456789abcdef", volume: 1, pitch: 1, loop: false } },
      FadeoutBgm: {}, ShakeScreen: {}, FlashScreen: {}, TintScreen: { color: { r: 0, g: 0, b: 0, a: 0 } }, Fadeout: {}, Fadein: {},
      SaveGame: {}, LoadGame: {}, GameOver: {}, ReturnToTitle: {}, Script: { expr: "1" },
    };
    expect(Object.keys(minimal).sort()).toEqual(ctx.commands.list().map((h) => h.code).sort());
    for (const h of ctx.commands.list()) {
      const p = h.params.parse(minimal[h.code]);
      expect(() => h.meta.describe(p, project)).not.toThrow();
      expect(Array.isArray(h.meta.refs(p))).toBe(true);
    }
  });

  it("applies documented defaults", () => {
    expect(ctx.commands.get("ShowText")!.params.parse({ text: "x" })).toEqual({ text: "x", position: "bottom", background: "window" });
    expect(ctx.commands.get("TransferPlayer")!.params.parse({ mapId: "m", x: 0, y: 0 })).toMatchObject({ dir: "retain", fade: "black" });
    expect(ctx.commands.get("BattleProcessing")!.params.parse({ troop: "t" })).toEqual({ troop: "t", canEscape: true, canLose: false });
  });
});

describe("ブロックの構造（meta.block / meta.internal）", () => {
  const roles = (role: string): string[] => ctx.commands.list().filter((h) => h.meta.block?.role === role).map((h) => h.code).sort();

  it("組み込みの開始・区切り・終端・内部用", () => {
    expect(roles("open")).toEqual(["BattleProcessing", "ConditionalBranch", "Loop", "ShowChoices"]);
    expect(roles("divider")).toEqual(["ChoiceBranch", "Else"]);
    expect(roles("close")).toEqual(["EndBranch", "EndLoop"]);
    expect(ctx.commands.list().filter((h) => h.meta.internal === true).map((h) => h.code)).toEqual(["MoveStep", "WaitPlayerStep"]);
  });

  it("開始の close は終端のコマンド、dividers が返す行は区切りのコマンドで、params は検証を通る", () => {
    const samples: Record<string, Record<string, unknown>> = {
      ConditionalBranch: { condition: "true" },
      ShowChoices: { choices: ["a", "b", "c"] },
      BattleProcessing: { troop: "tr_x" },
      Loop: {},
    };
    for (const h of ctx.commands.list()) {
      const block = h.meta.block;
      if (block?.role !== "open") continue;
      expect(ctx.commands.get(block.close)?.meta.block?.role).toBe("close");
      for (const d of block.dividers(h.params.parse(samples[h.code]))) {
        expect(ctx.commands.get(d.code)?.meta.block?.role).toBe("divider");
        expect(ctx.commands.validate({ code: d.code, params: { ...d.params }, indent: 0 }).ok).toBe(true);
      }
    }
  });

  it("区切りの並び：条件分岐は Else 1 つ、選択肢は選択肢の数だけ、戦闘の処理は 勝ち/逃げ/負け の 3 つ、ループは無し。直後が本体なのは条件分岐とループ", () => {
    const open = (code: string, params: Record<string, unknown>) => {
      const h = ctx.commands.get(code)!;
      const block = h.meta.block!;
      if (block.role !== "open") throw new Error("開始ではない");
      return { bodyFirst: block.bodyFirst, dividers: block.dividers(h.params.parse(params)) };
    };
    expect(open("ConditionalBranch", { condition: "true" })).toEqual({ bodyFirst: true, dividers: [{ code: "Else", params: {} }] });
    expect(open("ShowChoices", { choices: ["a", "b"] })).toEqual({ bodyFirst: false, dividers: [{ code: "ChoiceBranch", params: { index: 0 } }, { code: "ChoiceBranch", params: { index: 1 } }] });
    expect(open("BattleProcessing", { troop: "t" }).dividers.map((d) => d.params)).toEqual([{ index: 0 }, { index: 1 }, { index: 2 }]);
    expect(open("Loop", {})).toEqual({ bodyFirst: true, dividers: [] });
  });
});
