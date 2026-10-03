import { describe, expect, it } from "vitest";
import { getVar, heroOf, setVar } from "./index.js";
import type { GameState } from "./index.js";

describe("getVar / setVar（ゲーム変数）", () => {
  const s0 = { variables: {} } as never as GameState;
  it("未設定は 0、setVar の後は値を返す（元の状態は変えない）", () => {
    expect(getVar(s0, "n")).toBe(0);
    const s1 = setVar(s0, "n", 5);
    expect(getVar(s1, "n")).toBe(5);
    expect(getVar(s0, "n")).toBe(0);
  });
});

describe("heroOf", () => {
  it("パーティの先頭とそのアクターを返す。空なら undefined", () => {
    const id = "a1" as never;
    const actor = { id, name: "勇者" } as never;
    const s = { party: { members: [id] }, actors: { a1: actor } } as never;
    expect(heroOf(s)).toEqual({ id: "a1", actor });
    expect(heroOf({ party: { members: [] }, actors: {} } as never)).toBeUndefined();
    expect(heroOf({ party: { members: [id] }, actors: {} } as never)).toBeUndefined();
  });
});
