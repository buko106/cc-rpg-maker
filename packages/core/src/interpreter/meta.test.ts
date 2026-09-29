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
  [cmd("Else"), "それ以外のとき", []],
  [cmd("EndBranch"), "分岐終了", []],
  [cmd("Wait", { frames: 30 }), "ウェイト：30フレーム", []],
  [cmd("TransferPlayer", { mapId: "map_b", x: 2, y: 3 }), "場所移動：map_b (2, 3)", [{ kind: "map", id: "map_b" }]],
];

describe("builtin command metadata", () => {
  it.each(cases)("%j", (command, description, refs) => {
    const handler = ctx.commands.get(command.code)!;
    const params = handler.params.parse(command.params);
    expect(handler.meta.describe(params, project)).toBe(description);
    expect(handler.meta.refs(params)).toEqual(refs);
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
  });
});
