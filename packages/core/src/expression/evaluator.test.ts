import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Ast } from "./ast.js";
import { registerBuiltinFns } from "./builtins.js";
import { compile, evaluate, STEP_BUDGET } from "./evaluator.js";
import { parse } from "./parser.js";
import { createFormulaRegistry } from "./registry.js";
import type { BattlerView, Scope, Value } from "./types.js";
import { createRandom } from "../random.js";

const battler = (o: Partial<BattlerView> = {}): BattlerView => ({
  hp: 100, mhp: 100, mp: 20, mmp: 20, atk: 30, def: 10, mat: 5, mdf: 5, agi: 8, luk: 3, level: 5, name: "勇者", ...o,
});

const reg = createFormulaRegistry();
registerBuiltinFns(reg);

function scopeOf(over: Partial<Scope> = {}): Scope {
  return {
    vars: { a: battler(), b: battler({ def: 12, name: "スライム" }), ...over.vars },
    variable: (id) => ({ v1: 7, v2: -3 })[id as string] ?? 0,
    switch: (id) => id === ("s_on" as never),
    rng: createRandom("eval"),
    mode: "formula",
    ...over,
  };
}

function run(src: string, scope: Scope = scopeOf()) {
  const parsed = parse(src);
  if (!parsed.ok) throw new Error(`parse failed: ${src}: ${parsed.error.message}`);
  return evaluate(parsed.value, scope, reg);
}
const value = (src: string, scope?: Scope): Value => {
  const r = run(src, scope);
  if (!r.ok) throw new Error(`eval failed: ${src}: ${r.error.kind} ${r.error.message}`);
  return r.value.value;
};
const errKind = (src: string, scope?: Scope): string => {
  const r = run(src, scope);
  if (r.ok) throw new Error(`expected error: ${src} → ${String(r.value.value)}`);
  return r.error.kind;
};

describe("evaluate: values", () => {
  it.each<[string, Value]>([
    ["1 + 2 * 3", 7],
    ["10 - 4 - 3", 3],
    ["7 % 4", 3],
    ["-5 + 2", -3],
    ["2 * -3", -6],
    ["1 / 4", 0.25],
    ["true && false", false],
    ["true || boom", true], // 短絡: 右辺は評価されない
    ["false && boom", false],
    ["!false", true],
    ["1 < 2", true],
    ["2 <= 2", true],
    ["'a' < 'b'", true],
    ["1 == 1", true],
    ["1 == '1'", false],
    ["'a' != 'b'", true],
    ["true == true", true],
    ["true ? 1 : 2", 1],
    ["false ? boom : 2", 2],
    ["'a' + 'b'", "ab"],
    ["'n=' + 3", "n=3"],
    ["1 + 'x'", "1x"],
    ["'ok:' + true", "ok:true"],
  ])("%s → %j", (src, expected) => {
    expect(value(src)).toEqual(expected);
  });

  it("evaluates RPG Maker MV-style damage formulas", () => {
    expect(value("a.atk * 4 - b.def * 2")).toBe(30 * 4 - 12 * 2);
    expect(value("max(a.atk * 4 - b.def * 2, 1)")).toBe(96);
    expect(value("a.atk * 4 - b.def * 2 > 0 ? a.atk * 4 - b.def * 2 : 1")).toBe(96);
    expect(value("floor(a.mat * 3.5)")).toBe(17);
    expect(value("a.hp >= a.mhp / 2 && a.level >= 5")).toBe(true);
    expect(value("a.name + ' → ' + b.name")).toBe("勇者 → スライム");
  });

  it("reads all whitelisted members", () => {
    for (const m of ["hp", "mhp", "mp", "mmp", "atk", "def", "mat", "mdf", "agi", "luk", "level", "name"]) {
      expect(value(`a.${m}`)).toBe((battler() as never)[m]);
    }
  });
});

describe("evaluate: normalization", () => {
  it.each<[string, number]>([
    ["1 / 0", 0],
    ["0 / 0", 0],
    ["-1 / 0", 0],
    ["5 % 0", 0],
    ["1 / 0 + 3", 3],
    ["9999999999999999999999 * 9999999999999999999999 * 9999999999999999999999 * 9999999999999999999999 * 9999999999999999999999 * 9999999999999999999999 * 9999999999999999999999 * 9999999999999999999999 * 9999999999999999999999 * 9999999999999999999999 * 9999999999999999999999 * 9999999999999999999999 * 9999999999999999999999 * 9999999999999999999999 * 9999999999999999999999 * 9999999999999999999999 * 9999999999999999999999 * 9999999999999999999999 * 9999999999999999999999 * 9999999999999999999999 * 9999999999999999999999 * 9999999999999999999999 * 9999999999999999999999 * 9999999999999999999999 * 9999999999999999999999", 0],
  ])("%s → %d", (src, expected) => {
    expect(value(src)).toBe(expected);
  });

  it("never returns NaN or Infinity for arithmetic on finite numbers", () => {
    fc.assert(
      fc.property(fc.double({ noNaN: true }), fc.double({ noNaN: true }), fc.constantFrom("+", "-", "*", "/", "%"), (x, y, op) => {
        const ast: Ast = {
          kind: "binary",
          op: op as never,
          left: { kind: "ident", name: "x", pos: 0 },
          right: { kind: "ident", name: "y", pos: 0 },
          pos: 0,
        };
        const r = evaluate(ast, scopeOf({ vars: { x, y } }), reg);
        expect(r.ok).toBe(true);
        if (r.ok) expect(Number.isFinite(r.value.value as number)).toBe(true);
      }),
    );
  });

  it("type mismatches are errors, not coercions", () => {
    for (const src of ["1 + true", "true + true", "-'a'", "!1", "1 && true", "false || 1", "'a' * 2", "1 < 'a'", "true < false", "1 ? 2 : 3", "a + 1", "a.atk + a"]) {
      expect(errKind(src), src).toBe("typeMismatch");
    }
  });
});

describe("evaluate: functions", () => {
  it.each<[string, Value]>([
    ["v('v1')", 7],
    ["v('v2')", -3],
    ["v('unknown')", 0],
    ["s('s_on')", true],
    ["s('s_off')", false],
    ["min(3, 1, 2)", 1],
    ["max(3, 1, 2)", 3],
    ["floor(2.7)", 2],
    ["floor(-2.5)", -3],
    ["ceil(2.1)", 3],
    ["round(2.5)", 3],
    ["round(2.4)", 2],
    ["abs(-4)", 4],
    ["clamp(15, 0, 10)", 10],
    ["clamp(-5, 0, 10)", 0],
    ["clamp(5, 0, 10)", 5],
    ["v('v1') * 2 + max(1, v('v2'))", 15],
  ])("%s → %j", (src, expected) => {
    expect(value(src)).toEqual(expected);
  });

  it("reports argument errors", () => {
    expect(errKind("min()")).toBe("argument");
    expect(errKind("floor(1, 2)")).toBe("argument");
    expect(errKind("floor('x')")).toBe("typeMismatch");
    expect(errKind("v(1)")).toBe("typeMismatch");
    expect(errKind("clamp(1, 2)")).toBe("argument");
  });

  it("rand is inclusive, deterministic per rng state, and advances the rng", () => {
    const seq = (seed: string) => {
      const s = scopeOf({ rng: createRandom(seed) });
      return Array.from({ length: 30 }, () => value("rand(1, 6)", s) as number);
    };
    expect(seq("d6")).toEqual(seq("d6"));
    expect(seq("d6")).not.toEqual(seq("d7"));
    const values = seq("d6");
    expect(values.every((n) => Number.isInteger(n) && n >= 1 && n <= 6)).toBe(true);
    expect(new Set(values).size).toBeGreaterThan(1);
    expect(value("rand(6, 1)", scopeOf())).toBeGreaterThanOrEqual(1);
  });

  it("reports unknown functions and non-identifier callees", () => {
    expect(errKind("nope(1)")).toBe("unknownFunction");
    expect(errKind("constructor(1)")).toBe("unknownFunction");
    expect(errKind("toString(1)")).toBe("unknownFunction");
    expect(errKind("(a.atk)(1)")).toBe("notCallable");
    expect(errKind("f(1)(2)")).toBe("notCallable");
  });

  it("converts exceptions thrown by plugin functions into errors", () => {
    const r = createFormulaRegistry();
    r.registerFn("boom", () => {
      throw new Error("kaboom");
    });
    const parsed = parse("boom() + 1");
    if (!parsed.ok) throw new Error();
    const result = evaluate(parsed.value, scopeOf(), r);
    expect(result).toMatchObject({ ok: false, error: { kind: "functionError" } });
  });

  it("rejects duplicate registration and bad names", () => {
    const r = createFormulaRegistry();
    r.registerFn("f", () => 1);
    expect(() => r.registerFn("f", () => 2)).toThrow();
    expect(() => r.registerFn("1bad", () => 2)).toThrow();
    expect(() => r.registerFn("a.b", () => 2)).toThrow();
    expect(r.has("f")).toBe(true);
    expect(r.has("g")).toBe(false);
  });
});

describe("evaluate: security (whitelist)", () => {
  it.each(["a.constructor", "a.__proto__", "a.prototype", "a.toString", "a.hasOwnProperty", "b.valueOf", "a.foo"])("rejects member %s", (src) => {
    expect(errKind(src)).toBe("forbiddenMember");
  });

  it("rejects members on non-battlers", () => {
    expect(errKind("'abc'.length")).toBe("typeMismatch");
    expect(errKind("(1).toFixed")).toBe("typeMismatch");
    expect(errKind("a.hp.toFixed")).toBe("typeMismatch");
    expect(errKind("a.name.length")).toBe("typeMismatch");
  });

  it.each(["constructor", "__proto__", "toString", "hasOwnProperty", "prototype", "globalThis", "process", "window"])("identifier %s is undefined", (src) => {
    expect(errKind(src)).toBe("unknownIdentifier");
  });

  it("does not expose prototype properties through scope.vars", () => {
    const s = scopeOf({ vars: {} });
    expect(errKind("a", s)).toBe("unknownIdentifier");
    expect(errKind("constructor", s)).toBe("unknownIdentifier");
  });

  it("cannot reach Function via any accepted syntax", () => {
    for (const src of ["a.constructor.constructor('return 1')()", "''.constructor", "(a.atk).constructor", "Function('return 1')()"]) {
      expect(run(src).ok, src).toBe(false);
    }
  });
});

describe("evaluate: side effects and modes", () => {
  it("[inv-3] rejects side-effect functions unless mode is script", () => {
    for (const mode of ["formula", "condition"] as const) {
      expect(errKind("setVar('v1', 5)", scopeOf({ mode }))).toBe("sideEffectNotAllowed");
      expect(errKind("setSwitch('s1', true)", scopeOf({ mode }))).toBe("sideEffectNotAllowed");
      expect(errKind("gainItem('potion', 1)", scopeOf({ mode }))).toBe("sideEffectNotAllowed");
    }
  });

  it("collects mutations in script mode and returns the last value", () => {
    const r = run("setVar('v1', 5) + setVar('v2', 6)", scopeOf({ mode: "script" }));
    expect(r).toEqual({
      ok: true,
      value: {
        value: 11,
        mutations: [
          { kind: "setVar", id: "v1", value: 5 },
          { kind: "setVar", id: "v2", value: 6 },
        ],
      },
    });
    expect(run("setSwitch('s1', true)", scopeOf({ mode: "script" }))).toMatchObject({
      ok: true,
      value: { mutations: [{ kind: "setSwitch", id: "s1", value: true }] },
    });
    expect(run("gainItem('potion', 2.9)", scopeOf({ mode: "script" }))).toMatchObject({
      ok: true,
      value: { mutations: [{ kind: "gainItem", id: "potion", count: 2 }] },
    });
  });

  it("mutations do not affect what the same expression reads", () => {
    const r = run("setVar('v1', 99) + v('v1')", scopeOf({ mode: "script" }));
    expect(r).toMatchObject({ ok: true, value: { value: 99 + 7 } });
  });

  it("side-effect functions are evaluated only when reached", () => {
    const r = run("false && setVar('v1', 1) == 1", scopeOf({ mode: "script" }));
    expect(r).toMatchObject({ ok: true, value: { value: false, mutations: [] } });
  });
});

describe("evaluate: purity, determinism, termination", () => {
  it("[inv-2] does not modify the scope (vars deep-frozen)", () => {
    const frozenBattler = Object.freeze(battler());
    const vars = Object.freeze({ a: frozenBattler, b: frozenBattler });
    const scope = { ...scopeOf(), vars };
    expect(() => run("a.atk * 4 - b.def * 2 + v('v1')", scope)).not.toThrow();
    expect(Object.isFrozen(scope.vars)).toBe(true);
  });

  it("[inv-4] same (ast, scope, rng state) → same result", () => {
    fc.assert(
      fc.property(fc.string(), fc.constantFrom("rand(1,100) + rand(1,100)", "a.atk * rand(1, 3)", "max(rand(0, 9), rand(0, 9))"), (seed, src) => {
        const one = run(src, scopeOf({ rng: createRandom(seed) }));
        const two = run(src, scopeOf({ rng: createRandom(seed) }));
        expect(one).toEqual(two);
      }),
    );
  });

  it("[inv-5] exceeds the step budget with an error (not a hang)", () => {
    const one: Ast = { kind: "number", value: 1, pos: 0 };
    const wide: Ast = { kind: "call", callee: { kind: "ident", name: "max", pos: 0 }, args: Array.from({ length: STEP_BUDGET + 1 }, () => one), pos: 0 };
    expect(evaluate(wide, scopeOf(), reg)).toMatchObject({ ok: false, error: { kind: "budget" } });
    const fits: Ast = { ...wide, args: Array.from({ length: STEP_BUDGET - 2 }, () => one) };
    expect(evaluate(fits, scopeOf(), reg)).toMatchObject({ ok: true, value: { value: 1 } });
  });

  it("reports a hand-built, extremely deep AST as an error instead of overflowing the stack", () => {
    let deep: Ast = { kind: "number", value: 1, pos: 0 };
    for (let i = 0; i < 200_000; i++) deep = { kind: "unary", op: "-", arg: deep, pos: 0 };
    expect(evaluate(deep, scopeOf(), reg)).toMatchObject({ ok: false, error: { kind: "budget" } });
  });

  it("[inv-5] every parsable expression terminates with a Result", () => {
    const token = fc.constantFrom("(", ")", "?", ":", ",", "&&", "||", "==", "<", "+", "-", "*", "/", "%", "!", "1", "0", "a", "a.atk", "true", "'s'", "max", "rand", "v", "(1)");
    fc.assert(
      fc.property(fc.array(token, { maxLength: 40 }), (tokens) => {
        const parsed = parse(tokens.join(" "));
        fc.pre(parsed.ok);
        if (parsed.ok) expect(typeof evaluate(parsed.value, scopeOf(), reg).ok).toBe("boolean");
      }),
      { numRuns: 1000 },
    );
  });
});

describe("compile", () => {
  it("parses once and evaluates against many scopes", () => {
    const c = compile("a.atk - b.def", reg);
    if (!c.ok) throw new Error();
    const at = (atk: number, def: number) => c.value(scopeOf({ vars: { a: battler({ atk }), b: battler({ def }) } }));
    expect(at(10, 3)).toMatchObject({ ok: true, value: { value: 7 } });
    expect(at(1, 5)).toMatchObject({ ok: true, value: { value: -4 } });
  });

  it("returns a ParseError with a position for bad source", () => {
    expect(compile("1 +", reg)).toMatchObject({ ok: false, error: { reason: "unexpectedEnd", pos: 3 } });
  });
});
