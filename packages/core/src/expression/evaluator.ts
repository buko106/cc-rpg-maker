import { err, ok } from "@rpg/schema";
import type { Result } from "@rpg/schema";
import type { Ast } from "./ast.js";
import { FormulaError } from "./errors.js";
import type { EvalError, EvalErrorKind, ParseError } from "./errors.js";
import { parse } from "./parser.js";
import type { FormulaRegistry } from "./registry.js";
import { BATTLER_MEMBERS } from "./types.js";
import type { BattlerView, Mutation, Scope, Value } from "./types.js";

/** 評価ステップの上限（AST ノードの評価回数）。超えたら `budget` エラー。 */
export const STEP_BUDGET = 10_000;

export interface EvalOutput {
  value: Value;
  mutations: Mutation[];
}

/** 評価器内部の中断用。`evaluate` が捕まえて `Result` に変換するので外へは漏れない。 */
class Abort {
  constructor(readonly error: EvalError) {}
}

const fail = (kind: EvalErrorKind, message: string, pos: number): never => {
  throw new Abort({ kind, message, pos });
};

/** NaN / ±Infinity は 0 に正規化する（式が不正でもゲームが止まらない）。 */
const normalize = (n: number): number => (Number.isFinite(n) ? n : 0);

const typeName = (v: Value): string => (v === undefined ? "undefined" : typeof v === "object" ? "Battler" : typeof v);

class Evaluator {
  steps = 0;
  readonly mutations: Mutation[] = [];

  constructor(
    private readonly scope: Scope,
    private readonly reg: FormulaRegistry,
  ) {}

  private num(v: Value, pos: number, what: string): number {
    if (typeof v !== "number") fail("typeMismatch", `${what}は数値が必要（実際: ${typeName(v)}）`, pos);
    return v as number;
  }

  private bool(v: Value, pos: number, what: string): boolean {
    if (typeof v !== "boolean") fail("typeMismatch", `${what}は真偽値が必要（実際: ${typeName(v)}）`, pos);
    return v as boolean;
  }

  eval(node: Ast): Value {
    if (++this.steps > STEP_BUDGET) fail("budget", `評価ステップの上限（${STEP_BUDGET}）を超えた`, node.pos);
    switch (node.kind) {
      case "number":
      case "string":
      case "boolean":
        return node.value;
      case "ident":
        if (!Object.hasOwn(this.scope.vars, node.name)) fail("unknownIdentifier", `未定義の識別子: ${node.name}`, node.pos);
        return this.scope.vars[node.name];
      case "unary": {
        const v = this.eval(node.arg);
        return node.op === "-" ? normalize(-this.num(v, node.pos, "単項 '-' の operand")) : !this.bool(v, node.pos, "'!' の operand");
      }
      case "ternary":
        return this.bool(this.eval(node.cond), node.pos, "'?:' の条件") ? this.eval(node.then) : this.eval(node.else);
      case "member": {
        const obj = this.eval(node.object);
        if (typeof obj !== "object") fail("typeMismatch", `メンバアクセスは Battler にのみ使える（実際: ${typeName(obj)}）`, node.pos);
        if (!(BATTLER_MEMBERS as readonly string[]).includes(node.prop)) {
          fail("forbiddenMember", `許可されていないメンバ: ${node.prop}`, node.pos);
        }
        return (obj as BattlerView)[node.prop as keyof BattlerView];
      }
      case "call":
        return this.call(node);
      case "binary":
        return this.binary(node);
    }
  }

  private binary(node: Extract<Ast, { kind: "binary" }>): Value {
    const { op, pos } = node;
    if (op === "&&" || op === "||") {
      const left = this.bool(this.eval(node.left), pos, `'${op}' の左辺`);
      if (op === "&&" ? !left : left) return left;
      return this.bool(this.eval(node.right), pos, `'${op}' の右辺`);
    }
    const l = this.eval(node.left);
    const r = this.eval(node.right);
    switch (op) {
      case "==":
        return l === r;
      case "!=":
        return l !== r;
      case "<":
      case "<=":
      case ">":
      case ">=": {
        if (!((typeof l === "number" && typeof r === "number") || (typeof l === "string" && typeof r === "string"))) {
          fail("typeMismatch", `'${op}' は数値同士か文字列同士でのみ使える（実際: ${typeName(l)} と ${typeName(r)}）`, pos);
        }
        const a = l as number;
        const b = r as number;
        return op === "<" ? a < b : op === "<=" ? a <= b : op === ">" ? a > b : a >= b;
      }
      case "+":
        if (typeof l === "string" || typeof r === "string") {
          const text = (v: Value): string => {
            if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v);
            return fail("typeMismatch", `文字列連結に使えない型: ${typeName(v)}`, pos);
          };
          return text(l) + text(r);
        }
        return normalize(this.num(l, pos, "'+' の左辺") + this.num(r, pos, "'+' の右辺"));
      case "-":
        return normalize(this.num(l, pos, "'-' の左辺") - this.num(r, pos, "'-' の右辺"));
      case "*":
        return normalize(this.num(l, pos, "'*' の左辺") * this.num(r, pos, "'*' の右辺"));
      case "/": {
        const d = this.num(r, pos, "'/' の右辺");
        return d === 0 ? (this.num(l, pos, "'/' の左辺"), 0) : normalize(this.num(l, pos, "'/' の左辺") / d);
      }
      case "%": {
        const d = this.num(r, pos, "'%' の右辺");
        return d === 0 ? (this.num(l, pos, "'%' の左辺"), 0) : normalize(this.num(l, pos, "'%' の左辺") % d);
      }
    }
  }

  private call(node: Extract<Ast, { kind: "call" }>): Value {
    if (node.callee.kind !== "ident") fail("notCallable", "関数名以外は呼び出せない", node.pos);
    const name = (node.callee as Extract<Ast, { kind: "ident" }>).name;
    const entry = this.reg.get(name);
    if (entry === undefined) return fail("unknownFunction", `未定義の関数: ${name}`, node.pos);
    if (entry.sideEffect && this.scope.mode !== "script") {
      fail("sideEffectNotAllowed", `副作用関数 ${name} は script モードでのみ使える`, node.pos);
    }
    const args = node.args.map((a) => this.eval(a));
    try {
      const result = entry.fn(args, this.scope, (m) => this.mutations.push(m));
      return typeof result === "number" ? normalize(result) : result;
    } catch (e) {
      if (e instanceof Abort) throw e;
      if (e instanceof FormulaError) return fail(e.kind, e.message, node.pos);
      // プラグイン関数のバグでもゲームを止めない
      return fail("functionError", `関数 ${name} が失敗した: ${e instanceof Error ? e.message : String(e)}`, node.pos);
    }
  }
}

/**
 * AST を評価する。`Scope` は変更しない（進むのは `scope.rng` のみ）。
 * 副作用は `mutations` として返し、適用は呼び出し側が行う。
 * 同じ `(ast, scope, rng 状態)` に対して同じ結果を返し、必ず有限ステップで終了する。
 */
export function evaluate(ast: Ast, scope: Scope, reg: FormulaRegistry): Result<EvalOutput, EvalError> {
  const ev = new Evaluator(scope, reg);
  try {
    return ok({ value: ev.eval(ast), mutations: ev.mutations });
  } catch (e) {
    if (e instanceof Abort) return err(e.error);
    // パーサを通らない手作りの深い AST でスタックが溢れた場合も、例外を漏らさず budget として扱う
    if (e instanceof RangeError) return err({ kind: "budget", message: "式のネストが深すぎる", pos: ast.pos });
    throw e;
  }
}

/** パースしてキャッシュした AST を評価するクロージャを返す。 */
export function compile(src: string, reg: FormulaRegistry): Result<(scope: Scope) => Result<EvalOutput, EvalError>, ParseError> {
  const parsed = parse(src);
  if (!parsed.ok) return parsed;
  const ast = parsed.value;
  return ok((scope) => evaluate(ast, scope, reg));
}
