import type { ParseError, ParseErrorReason } from "./errors.js";

export type Token =
  | { type: "number"; value: number; pos: number }
  | { type: "string"; value: string; pos: number }
  | { type: "ident"; value: string; pos: number }
  | { type: "op"; value: string; pos: number }
  | { type: "eof"; pos: number };

/** ソースの最大長。深い左結合の連鎖（`1+1+1+…`）で評価器の再帰が深くなりすぎるのを防ぐ。 */
export const MAX_SOURCE_LENGTH = 2000;

const TWO_CHAR_OPS = ["||", "&&", "==", "!=", "<=", ">="];
const ONE_CHAR_OPS = "()?:,.<>+-*/%!";

export function errorAt(src: string, pos: number, reason: ParseErrorReason, message: string): ParseError {
  let line = 1;
  let column = 1;
  for (let i = 0; i < Math.min(pos, src.length); i++) {
    if (src[i] === "\n") {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return { reason, message, pos, line, column };
}

const isDigit = (c: string): boolean => c >= "0" && c <= "9";
const isIdentStart = (c: string): boolean => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_";
const isIdentPart = (c: string): boolean => isIdentStart(c) || isDigit(c);

/** 字句解析。失敗時は ParseError を返す（例外は投げない）。 */
export function tokenize(src: string): { tokens: Token[] } | { error: ParseError } {
  if (src.length > MAX_SOURCE_LENGTH) {
    return { error: errorAt(src, MAX_SOURCE_LENGTH, "tooLong", `式が長すぎる（最大 ${MAX_SOURCE_LENGTH} 文字）`) };
  }
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
    } else if (isDigit(c)) {
      const start = i;
      while (i < src.length && isDigit(src[i]!)) i++;
      if (src[i] === "." && i + 1 < src.length && isDigit(src[i + 1]!)) {
        i++;
        while (i < src.length && isDigit(src[i]!)) i++;
      }
      const value = Number(src.slice(start, i));
      if (!Number.isFinite(value)) return { error: errorAt(src, start, "invalidNumber", "数値が大きすぎる") };
      tokens.push({ type: "number", value, pos: start });
    } else if (isIdentStart(c)) {
      const start = i;
      while (i < src.length && isIdentPart(src[i]!)) i++;
      tokens.push({ type: "ident", value: src.slice(start, i), pos: start });
    } else if (c === '"' || c === "'") {
      const start = i;
      i++;
      let value = "";
      let closed = false;
      while (i < src.length) {
        const d = src[i]!;
        if (d === c) {
          closed = true;
          i++;
          break;
        }
        if (d === "\\" && i + 1 < src.length) {
          const e = src[i + 1]!;
          value += e === "n" ? "\n" : e === "t" ? "\t" : e;
          i += 2;
        } else {
          value += d;
          i++;
        }
      }
      if (!closed) return { error: errorAt(src, start, "unterminatedString", "文字列が閉じられていない") };
      tokens.push({ type: "string", value, pos: start });
    } else {
      const two = src.slice(i, i + 2);
      if (TWO_CHAR_OPS.includes(two)) {
        tokens.push({ type: "op", value: two, pos: i });
        i += 2;
      } else if (ONE_CHAR_OPS.includes(c)) {
        tokens.push({ type: "op", value: c, pos: i });
        i++;
      } else {
        return { error: errorAt(src, i, "unexpectedChar", `想定外の文字: ${JSON.stringify(c)}`) };
      }
    }
  }
  tokens.push({ type: "eof", pos: src.length });
  return { tokens };
}
