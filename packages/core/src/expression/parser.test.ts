import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Ast } from "./ast.js";
import { MAX_SOURCE_LENGTH } from "./lexer.js";
import { parse } from "./parser.js";

/** AST を S 式にする（優先順位・結合性の検証用）。 */
export function sexpr(a: Ast): string {
  switch (a.kind) {
    case "number":
    case "boolean":
      return String(a.value);
    case "string":
      return JSON.stringify(a.value);
    case "ident":
      return a.name;
    case "unary":
      return `(${a.op}u ${sexpr(a.arg)})`;
    case "binary":
      return `(${a.op} ${sexpr(a.left)} ${sexpr(a.right)})`;
    case "ternary":
      return `(?: ${sexpr(a.cond)} ${sexpr(a.then)} ${sexpr(a.else)})`;
    case "member":
      return `(. ${sexpr(a.object)} ${a.prop})`;
    case "call":
      return `(call ${[sexpr(a.callee), ...a.args.map(sexpr)].join(" ")})`;
  }
}

const s = (src: string): string => {
  const r = parse(src);
  if (!r.ok) throw new Error(`parse failed: ${JSON.stringify(r.error)}`);
  return sexpr(r.value);
};

describe("parse: precedence and associativity", () => {
  it.each<[string, string]>([
    ["1 + 2 * 3", "(+ 1 (* 2 3))"],
    ["1 * 2 + 3", "(+ (* 1 2) 3)"],
    ["(1 + 2) * 3", "(* (+ 1 2) 3)"],
    ["1 - 2 - 3", "(- (- 1 2) 3)"],
    ["8 / 4 / 2", "(/ (/ 8 4) 2)"],
    ["7 % 4 * 2", "(* (% 7 4) 2)"],
    ["-a * b", "(* (-u a) b)"],
    ["- - a", "(-u (-u a))"],
    ["!a && b", "(&& (!u a) b)"],
    ["a || b && c", "(|| a (&& b c))"],
    ["a && b || c", "(|| (&& a b) c)"],
    ["a == b && c != d", "(&& (== a b) (!= c d))"],
    ["a < b == c > d", "(== (< a b) (> c d))"],
    ["a + b < c - d", "(< (+ a b) (- c d))"],
    ["a <= b >= c", "(>= (<= a b) c)"],
    ["a ? b : c", "(?: a b c)"],
    ["a ? b : c ? d : e", "(?: a b (?: c d e))"],
    ["a ? b ? c : d : e", "(?: a (?: b c d) e)"],
    ["a || b ? c : d", "(?: (|| a b) c d)"],
    ["a.atk * 4 - b.def * 2", "(- (* (. a atk) 4) (* (. b def) 2))"],
    ["a.b.c", "(. (. a b) c)"],
    ["f()", "(call f)"],
    ["f(1)", "(call f 1)"],
    ["max(a.atk, b.atk + 1, 3)", "(call max (. a atk) (+ (. b atk) 1) 3)"],
    ["-f(1)", "(-u (call f 1))"],
    ["f(1)(2)", "(call (call f 1) 2)"],
    ["true && false", "(&& true false)"],
    ['"a" + \'b\'', '(+ "a" "b")'],
    ["1.5 + 0.5", "(+ 1.5 0.5)"],
  ])("%s", (src, expected) => {
    expect(s(src)).toBe(expected);
  });

  it("handles string escapes", () => {
    expect(s('"a\\"b\\n\\\\"')).toBe(JSON.stringify('a"b\n\\'));
  });

  it("ignores whitespace including newlines", () => {
    expect(s("  1\n+\t2 ")).toBe("(+ 1 2)");
  });
});

describe("parse: errors carry positions", () => {
  it.each<[string, string, number, number, number]>([
    // src, reason, pos, line, column
    ["", "unexpectedEnd", 0, 1, 1],
    ["1 +", "unexpectedEnd", 3, 1, 4],
    ["1 + * 2", "unexpectedToken", 4, 1, 5],
    ["(1 + 2", "unexpectedEnd", 6, 1, 7],
    ["1 2", "unexpectedToken", 2, 1, 3],
    ["a ? b", "unexpectedEnd", 5, 1, 6],
    ["f(1,)", "unexpectedToken", 4, 1, 5],
    ["a.", "unexpectedEnd", 2, 1, 3],
    ["a.1", "unexpectedToken", 2, 1, 3],
    ["1 @ 2", "unexpectedChar", 2, 1, 3],
    ["'abc", "unterminatedString", 0, 1, 1],
    ["1 +\n  * 2", "unexpectedToken", 6, 2, 3],
    ["a = b", "unexpectedChar", 2, 1, 3],
    ["a & b", "unexpectedChar", 2, 1, 3],
  ])("%j → %s at %i", (src, reason, pos, line, column) => {
    const r = parse(src);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatchObject({ reason, pos, line, column });
  });

  it("rejects overly long sources and overly deep nesting without throwing", () => {
    const long = parse("1+".repeat(MAX_SOURCE_LENGTH) + "1");
    expect(long).toMatchObject({ ok: false, error: { reason: "tooLong" } });
    const deepParens = parse("(".repeat(500) + "1" + ")".repeat(500));
    expect(deepParens).toMatchObject({ ok: false, error: { reason: "tooDeep" } });
    const deepUnary = parse("!".repeat(500) + "a");
    expect(deepUnary).toMatchObject({ ok: false, error: { reason: "tooDeep" } });
  });

  it("does not treat prototype-ish words specially", () => {
    expect(s("constructor")).toBe("constructor");
    expect(s("__proto__")).toBe("__proto__");
  });
});

// ---- プロパティ ----

const identArb = fc.constantFrom("a", "b", "x", "hp", "foo");
const astArb: fc.Arbitrary<Ast> = fc.letrec<{ ast: Ast }>((tie) => ({
  ast: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    fc.integer({ min: 0, max: 99 }).map((value): Ast => ({ kind: "number", value, pos: 0 })),
    fc.boolean().map((value): Ast => ({ kind: "boolean", value, pos: 0 })),
    identArb.map((name): Ast => ({ kind: "ident", name, pos: 0 })),
    fc.string({ maxLength: 4 }).map((value): Ast => ({ kind: "string", value, pos: 0 })),
    tie("ast").map((arg): Ast => ({ kind: "unary", op: "-", arg, pos: 0 })),
    tie("ast").map((arg): Ast => ({ kind: "unary", op: "!", arg, pos: 0 })),
    fc
      .tuple(fc.constantFrom("||", "&&", "==", "!=", "<", "<=", ">", ">=", "+", "-", "*", "/", "%" as const), tie("ast"), tie("ast"))
      .map(([op, left, right]): Ast => ({ kind: "binary", op, left, right, pos: 0 })),
    fc.tuple(tie("ast"), tie("ast"), tie("ast")).map(([cond, then, els]): Ast => ({ kind: "ternary", cond, then, else: els, pos: 0 })),
    fc.tuple(tie("ast"), identArb).map(([object, prop]): Ast => ({ kind: "member", object, prop, pos: 0 })),
    fc.tuple(identArb, fc.array(tie("ast"), { maxLength: 3 })).map(([name, args]): Ast => ({
      kind: "call",
      callee: { kind: "ident", name, pos: 0 },
      args,
      pos: 0,
    })),
  ),
})).ast;

/** 完全括弧で AST を文字列化する。パースし直すと同じ構造になるはず。 */
function print(a: Ast): string {
  switch (a.kind) {
    case "number":
      return String(a.value);
    case "boolean":
      return String(a.value);
    case "string":
      return JSON.stringify(a.value);
    case "ident":
      return a.name;
    case "unary":
      return `(${a.op}${print(a.arg)})`;
    case "binary":
      return `(${print(a.left)} ${a.op} ${print(a.right)})`;
    case "ternary":
      return `(${print(a.cond)} ? ${print(a.then)} : ${print(a.else)})`;
    case "member":
      return `(${print(a.object)}).${a.prop}`;
    case "call":
      return `${print(a.callee)}(${a.args.map(print).join(", ")})`;
  }
}

describe("parse: properties", () => {
  it("[inv-1] never throws on arbitrary strings", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), (src) => {
        expect(typeof parse(src).ok).toBe("boolean");
      }),
      { numRuns: 500 },
    );
  });

  it("[inv-1] never throws on arbitrary token sequences", () => {
    const token = fc.constantFrom("(", ")", "?", ":", ",", ".", "||", "&&", "==", "!=", "<", "<=", ">", ">=", "+", "-", "*", "/", "%", "!", "1", "2.5", "a", "b", "f", "true", "'s'", '"t"', "\n", "@", "=");
    fc.assert(
      fc.property(fc.array(token, { maxLength: 60 }), (tokens) => {
        expect(typeof parse(tokens.join(" ")).ok).toBe("boolean");
      }),
      { numRuns: 500 },
    );
  });

  it("fully-parenthesised printing round-trips through parse", () => {
    fc.assert(
      fc.property(astArb, (ast) => {
        const src = print(ast);
        fc.pre(src.length <= MAX_SOURCE_LENGTH);
        const reparsed = parse(src);
        expect(reparsed.ok, src).toBe(true);
        if (reparsed.ok) expect(print(reparsed.value)).toBe(src);
      }),
    );
  });

  it("error positions are within the source", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), (src) => {
        const r = parse(src);
        if (!r.ok) {
          expect(r.error.pos).toBeGreaterThanOrEqual(0);
          expect(r.error.pos).toBeLessThanOrEqual(src.length);
          expect(r.error.line).toBeGreaterThanOrEqual(1);
          expect(r.error.column).toBeGreaterThanOrEqual(1);
        }
      }),
    );
  });
});
