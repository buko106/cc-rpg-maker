import { describe, expect, it } from "vitest";
import { computeCamera } from "./camera.js";
import { newCharacter } from "./character.js";

const system = { tileSize: 32, screen: { width: 320, height: 256 } } as never; // 10 x 8 タイル
const map = (width: number, height: number) => ({ width, height }) as never;

describe("computeCamera", () => {
  it("centers on the player", () => {
    expect(computeCamera(newCharacter(10, 10, "down"), map(30, 30), system)).toEqual({ x: 10 + 0.5 - 5, y: 10 + 0.5 - 4 });
  });
  it("clamps at the top-left and bottom-right of the map", () => {
    expect(computeCamera(newCharacter(0, 0, "down"), map(30, 30), system)).toEqual({ x: 0, y: 0 });
    expect(computeCamera(newCharacter(29, 29, "down"), map(30, 30), system)).toEqual({ x: 20, y: 22 });
  });
  it("is fixed at 0 when the map is smaller than the screen", () => {
    expect(computeCamera(newCharacter(3, 3, "down"), map(6, 4), system)).toEqual({ x: 0, y: 0 });
  });
  it("follows the interpolated position", () => {
    const moving = { ...newCharacter(11, 10, "right"), realX: 10.5, moving: true };
    expect(computeCamera(moving, map(30, 30), system).x).toBe(10.5 + 0.5 - 5);
  });
});
