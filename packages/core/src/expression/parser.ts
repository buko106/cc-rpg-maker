import type { Ast, BinaryOp } from "./ast.js";
import type { ParseError } from "./errors.js";
import { errorAt, tokenize } from "./lexer.js";
import type { Token } from "./lexer.js";
import { err, ok } from "@rpg/schema";
import type { Result } from "@rpg/schema";

/** 括弧・単項演算子・三項演算子のネスト上限。再帰によるスタック溢れを防ぐ。 */
const MAX_DEPTH = 100;

/** パーサ内部の中断用。`parse` が捕まえて `Result` に変換するので外へは漏れない。 */
class Abort {
  constructor(readonly error: ParseError) {}
}

class Parser {
  private i = 0;
  private depth = 0;

  constructor(
    private readonly src: string,
    private readonly tokens: readonly Token[],
  ) {}

  private get tok(): Token {
    return this.tokens[this.i]!;
  }

  private fail(reason: ParseError["reason"], message: string, pos = this.tok.pos): never {
    throw new Abort(errorAt(this.src, pos, reason, message));
  }

  private describe(t: Token): string {
    return t.type === "eof" ? "式の終わり" : t.type === "string" ? "文字列" : `'${t.type === "number" ? String(t.value) : t.value}'`;
  }

  private unexpected(): never {
    if (this.tok.type === "eof") this.fail("unexpectedEnd", "式が途中で終わっている");
    return this.fail("unexpectedToken", `想定外のトークン: ${this.describe(this.tok)}`);
  }

  private isOp(...ops: string[]): boolean {
    const t = this.tok;
    return t.type === "op" && ops.includes(t.value);
  }

  private expectOp(op: string): void {
    if (!this.isOp(op)) this.unexpected();
    this.i++;
  }

  private nested<T>(f: () => T): T {
    if (++this.depth > MAX_DEPTH) this.fail("tooDeep", `ネストが深すぎる（最大 ${MAX_DEPTH}）`);
    try {
      return f();
    } finally {
      this.depth--;
    }
  }

  parseAll(): Ast {
    const ast = this.expr();
    if (this.tok.type !== "eof") this.unexpected();
    return ast;
  }

  private expr(): Ast {
    return this.nested(() => this.ternary());
  }

  private ternary(): Ast {
    const cond = this.binary(0);
    if (!this.isOp("?")) return cond;
    const pos = this.tok.pos;
    this.i++;
    const then = this.expr();
    this.expectOp(":");
    const otherwise = this.expr();
    return { kind: "ternary", cond, then, else: otherwise, pos };
  }

  /** 二項演算子の優先順位（低 → 高）。すべて左結合。 */
  private static readonly LEVELS: readonly (readonly BinaryOp[])[] = [
    ["||"],
    ["&&"],
    ["==", "!="],
    ["<", "<=", ">", ">="],
    ["+", "-"],
    ["*", "/", "%"],
  ];

  private binary(level: number): Ast {
    if (level >= Parser.LEVELS.length) return this.unary();
    let left = this.binary(level + 1);
    const ops = Parser.LEVELS[level]!;
    while (this.tok.type === "op" && (ops as readonly string[]).includes(this.tok.value)) {
      const op = this.tok.value as BinaryOp;
      const pos = this.tok.pos;
      this.i++;
      const right = this.binary(level + 1);
      left = { kind: "binary", op, left, right, pos };
    }
    return left;
  }

  private unary(): Ast {
    if (this.isOp("-", "!")) {
      const op = (this.tok as { value: string }).value as "-" | "!";
      const pos = this.tok.pos;
      this.i++;
      const arg = this.nested(() => this.unary());
      return { kind: "unary", op, arg, pos };
    }
    return this.postfix();
  }

  private postfix(): Ast {
    let node = this.primary();
    for (;;) {
      if (this.isOp(".")) {
        const pos = this.tok.pos;
        this.i++;
        const t = this.tok;
        if (t.type !== "ident") this.unexpected();
        this.i++;
        node = { kind: "member", object: node, prop: (t as { value: string }).value, pos };
      } else if (this.isOp("(")) {
        const pos = this.tok.pos;
        this.i++;
        const args: Ast[] = [];
        if (!this.isOp(")")) {
          args.push(this.expr());
          while (this.isOp(",")) {
            this.i++;
            args.push(this.expr());
          }
        }
        this.expectOp(")");
        node = { kind: "call", callee: node, args, pos };
      } else {
        return node;
      }
    }
  }

  private primary(): Ast {
    const t = this.tok;
    switch (t.type) {
      case "number":
        this.i++;
        return { kind: "number", value: t.value, pos: t.pos };
      case "string":
        this.i++;
        return { kind: "string", value: t.value, pos: t.pos };
      case "ident":
        this.i++;
        if (t.value === "true" || t.value === "false") return { kind: "boolean", value: t.value === "true", pos: t.pos };
        return { kind: "ident", name: t.value, pos: t.pos };
      case "op":
        if (t.value === "(") {
          this.i++;
          const inner = this.expr();
          this.expectOp(")");
          return inner;
        }
        return this.unexpected();
      default:
        return this.unexpected();
    }
  }
}

/**
 * 式をパースする。任意の文字列に対して例外を投げず、必ず `Result` を返す。
 * 文法は docs/05-expression.md。
 */
export function parse(src: string): Result<Ast, ParseError> {
  const lexed = tokenize(src);
  if ("error" in lexed) return err(lexed.error);
  try {
    return ok(new Parser(src, lexed.tokens).parseAll());
  } catch (e) {
    if (e instanceof Abort) return err(e.error);
    throw e;
  }
}
