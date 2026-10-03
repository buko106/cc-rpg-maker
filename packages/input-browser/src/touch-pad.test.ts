import { describe, expect, it } from "vitest";
import { shouldShowTouchPad } from "./touch-pad.js";

describe("shouldShowTouchPad", () => {
  it("on / off は端末に依らず、auto は指が主入力のときだけ", () => {
    expect(shouldShowTouchPad("on", () => false)).toBe(true);
    expect(shouldShowTouchPad("off", () => true)).toBe(false);
    expect(shouldShowTouchPad("auto", () => true)).toBe(true);
    expect(shouldShowTouchPad("auto", () => false)).toBe(false);
    expect(shouldShowTouchPad(undefined, () => true)).toBe(true);
  });
});
