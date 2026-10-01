import type { ItemId, SwitchId, VariableId } from "@rpg/schema";
import { FormulaError } from "./errors.js";
import type { FormulaRegistry } from "./registry.js";
import type { Value } from "./types.js";

function num(v: Value, fn: string, index: number): number {
  if (typeof v !== "number") throw new FormulaError("typeMismatch", `${fn}: 第${index + 1}引数は数値でなければならない`);
  return v;
}
function str(v: Value, fn: string, index: number): string {
  if (typeof v !== "string") throw new FormulaError("typeMismatch", `${fn}: 第${index + 1}引数は文字列（ID）でなければならない`);
  return v;
}
function arity(args: Value[], fn: string, n: number): void {
  if (args.length !== n) throw new FormulaError("argument", `${fn}: 引数は ${n} 個必要（実際: ${args.length}）`);
}
function nums(args: Value[], fn: string): number[] {
  if (args.length === 0) throw new FormulaError("argument", `${fn}: 引数が 1 個以上必要`);
  return args.map((a, i) => num(a, fn, i));
}

/** 組み込み関数を登録する。docs/05-expression.md。 */
export function registerBuiltinFns(r: FormulaRegistry): void {
  r.registerFn("v", (a, scope) => (arity(a, "v", 1), scope.variable(str(a[0], "v", 0) as VariableId)));
  r.registerFn("s", (a, scope) => (arity(a, "s", 1), scope.switch(str(a[0], "s", 0) as SwitchId)));

  // マップイベントの位置（押せる岩が仕掛けの位置に載ったか、など）。そのイベントが居ない（別のマップ・存在しない ID）と -1
  r.registerFn("evx", (a, scope) => (arity(a, "evx", 1), scope.eventPos?.(str(a[0], "evx", 0))?.x ?? -1));
  r.registerFn("evy", (a, scope) => (arity(a, "evy", 1), scope.eventPos?.(str(a[0], "evy", 0))?.y ?? -1));

  r.registerFn("min", (a) => Math.min(...nums(a, "min")));
  r.registerFn("max", (a) => Math.max(...nums(a, "max")));
  r.registerFn("floor", (a) => (arity(a, "floor", 1), Math.floor(num(a[0], "floor", 0))));
  r.registerFn("ceil", (a) => (arity(a, "ceil", 1), Math.ceil(num(a[0], "ceil", 0))));
  r.registerFn("round", (a) => (arity(a, "round", 1), Math.round(num(a[0], "round", 0))));
  r.registerFn("abs", (a) => (arity(a, "abs", 1), Math.abs(num(a[0], "abs", 0))));
  r.registerFn("clamp", (a) => {
    arity(a, "clamp", 3);
    return Math.min(Math.max(num(a[0], "clamp", 0), num(a[1], "clamp", 1)), num(a[2], "clamp", 2));
  });
  r.registerFn("rand", (a, scope) => {
    arity(a, "rand", 2);
    const x = Math.floor(num(a[0], "rand", 0));
    const y = Math.floor(num(a[1], "rand", 1));
    return scope.rng.int(Math.min(x, y), Math.max(x, y));
  });

  // 副作用関数（mode: "script" のみ）。状態は変更せず、変更操作を記録する。
  r.registerFn(
    "setVar",
    (a, _scope, emit) => {
      arity(a, "setVar", 2);
      const value = num(a[1], "setVar", 1);
      emit({ kind: "setVar", id: str(a[0], "setVar", 0) as VariableId, value });
      return value;
    },
    { sideEffect: true },
  );
  r.registerFn(
    "setSwitch",
    (a, _scope, emit) => {
      arity(a, "setSwitch", 2);
      const value = a[1];
      if (typeof value !== "boolean") throw new FormulaError("typeMismatch", "setSwitch: 第2引数は真偽値でなければならない");
      emit({ kind: "setSwitch", id: str(a[0], "setSwitch", 0) as SwitchId, value });
      return value;
    },
    { sideEffect: true },
  );
  r.registerFn(
    "gainItem",
    (a, _scope, emit) => {
      arity(a, "gainItem", 2);
      const count = Math.trunc(num(a[1], "gainItem", 1));
      emit({ kind: "gainItem", id: str(a[0], "gainItem", 0) as ItemId, count });
      return count;
    },
    { sideEffect: true },
  );
}
