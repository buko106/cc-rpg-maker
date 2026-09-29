import { describe, expect, it } from "vitest";
import { expandText } from "./text-codec.js";
import type { TextEnv } from "./text-codec.js";

const env: TextEnv = {
  variable: (id) => (id === "gold" ? 120 : id === "neg" ? -5 : 0),
  actorName: (id) => (id === "hero" ? "勇者" : undefined),
};
const plain = (src: string): string[] => expandText(src, env).map((line) => line.map((r) => r.text).join(""));

describe("expandText", () => {
  it.each([
    ["こんにちは", ["こんにちは"]],
    ["", [""]],
    ["a\nb", ["a", "b"]],
    ["\n", ["", ""]],
    ["所持金 \\V[gold] G", ["所持金 120 G"]],
    ["\\v[neg]", ["-5"]], // 小文字も可
    ["\\V[unknown]", ["0"]], // 未定義の変数は 0
    ["\\N[hero]よ", ["勇者よ"]],
    ["\\N[nobody]!", ["!"]], // 未定義のアクターは空
    ["a\\\\b", ["a\\b"]], // \\ はバックスラッシュ
    ["\\X[1]", ["\\X[1]"]], // 未知の制御文字はそのまま
    ["\\V[", ["\\V["]], // 壊れた制御文字でも止まらない
    ["\\V[a b]", ["\\V[a b]"]],
    ["末尾\\", ["末尾\\"]],
  ])("%j → %j", (src, expected) => {
    expect(plain(src)).toEqual(expected);
  });

  it("\\C[n] は以降の文字の色番号を変え、色が変わるところで断片に分ける", () => {
    expect(expandText("a\\C[2]b\\C[0]c", env)).toEqual([
      [
        { text: "a", color: 0 },
        { text: "b", color: 2 },
        { text: "c", color: 0 },
      ],
    ]);
  });

  it("色は改行をまたいで続き、数字でない指定は 0 番になる", () => {
    expect(expandText("\\C[3]x\ny\\C[abc]z", env)).toEqual([[{ text: "x", color: 3 }], [{ text: "y", color: 3 }, { text: "z", color: 0 }]]);
  });

  it("制御文字が展開結果に再展開されない（変数の値に \\ が入っても）", () => {
    const tricky: TextEnv = { variable: () => 1, actorName: () => "\\V[gold]" };
    expect(expandText("\\N[hero]", tricky)[0]?.[0]?.text).toBe("\\V[gold]");
  });
});
