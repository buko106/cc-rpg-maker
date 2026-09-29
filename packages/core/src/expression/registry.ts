import type { Mutation, Scope, Value } from "./types.js";

/**
 * 式関数の実装。引数の不正は `FormulaError` を投げて伝える（評価器が `EvalError` に変換する）。
 * `emit` は変更操作の記録用で、`sideEffect` な関数だけが使う。
 */
export type FormulaFn = (args: Value[], scope: Scope, emit: (m: Mutation) => void) => Value;

export interface RegisteredFn {
  readonly fn: FormulaFn;
  readonly sideEffect: boolean;
}

export interface FormulaRegistry {
  /** 同名の二重登録は Error（プログラミングエラー）。`name` は識別子でなければならない。 */
  registerFn(name: string, fn: FormulaFn, opts?: { sideEffect?: boolean }): void;
  has(name: string): boolean;
  get(name: string): RegisteredFn | undefined;
}

export function createFormulaRegistry(): FormulaRegistry {
  const fns = new Map<string, RegisteredFn>();
  return {
    registerFn(name, fn, opts) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`式関数名が不正: ${name}`);
      if (fns.has(name)) throw new Error(`式関数が二重登録された: ${name}`);
      fns.set(name, { fn, sideEffect: opts?.sideEffect ?? false });
    },
    has: (name) => fns.has(name),
    get: (name) => fns.get(name),
  };
}
