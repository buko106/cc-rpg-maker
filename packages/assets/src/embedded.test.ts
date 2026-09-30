import { describe, expect, it } from "vitest";
import { createEmbeddedBytesSource } from "./embedded.js";

const id = (s: string) => s as never;

describe("createEmbeddedBytesSource", () => {
  const bytes = Uint8Array.from({ length: 1000 }, (_, i) => (i * 13) % 256);
  const source = createEmbeddedBytesSource({ "0123456789abcdef": Buffer.from(bytes).toString("base64"), fedcba9876543210: "" });

  it("base64 をバイト列に戻す。空のアセットも扱える", async () => {
    expect(new Uint8Array((await source.getBytes(id("0123456789abcdef")))!)).toEqual(bytes);
    expect((await source.getBytes(id("fedcba9876543210")))?.byteLength).toBe(0);
  });

  it("無い ID は undefined（has は false）。Object のプロトタイプのキーは ID として扱わない", async () => {
    expect(await source.getBytes(id("0000000000000000"))).toBeUndefined();
    expect(await source.has(id("0000000000000000"))).toBe(false);
    expect(await source.has(id("0123456789abcdef"))).toBe(true);
    expect(await source.has(id("constructor"))).toBe(false);
    expect(await source.getBytes(id("toString"))).toBeUndefined();
  });

  it("呼ぶたびに別の ArrayBuffer を返す（片方を変えても、もう片方に影響しない）", async () => {
    const a = (await source.getBytes(id("0123456789abcdef")))!;
    new Uint8Array(a).fill(0);
    const b = (await source.getBytes(id("0123456789abcdef")))!;
    expect(new Uint8Array(b)).toEqual(bytes);
  });
});
