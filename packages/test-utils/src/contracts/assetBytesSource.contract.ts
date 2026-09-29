import { describe, expect, it } from "vitest";
import type { ContractFactory } from "./contract.js";

/** 契約テストが必要とする AssetBytesSource の形（`@rpg/assets` の型と構造的に同じ）。 */
export interface BytesSourceLike {
  getBytes(id: never): Promise<ArrayBuffer | undefined>;
  has(id: never): Promise<boolean>;
}

/** テスト用にあらかじめ登録した内容と、登録されていない ID。 */
export interface BytesSourceFixture {
  source: BytesSourceLike;
  entries: Record<string, ArrayBuffer>;
  missingId: string;
}

/** AssetBytesSource の契約スイート（docs/09-assets.md）。 */
export function assetBytesSourceContract(name: string, make: ContractFactory<BytesSourceFixture>): void {
  describe(`AssetBytesSource contract: ${name}`, () => {
    it("登録済みの ID は同じバイト列を返し、has は true（何度呼んでも同じ）", async () => {
      const { source, entries } = await make();
      for (const [id, bytes] of Object.entries(entries)) {
        expect(await source.has(id as never)).toBe(true);
        const a = await source.getBytes(id as never);
        const b = await source.getBytes(id as never);
        expect(a).toBeDefined();
        expect(Array.from(new Uint8Array(a!))).toEqual(Array.from(new Uint8Array(bytes)));
        expect(Array.from(new Uint8Array(b!))).toEqual(Array.from(new Uint8Array(bytes)));
      }
    });

    it("無い ID は getBytes が undefined、has が false", async () => {
      const { source, missingId } = await make();
      expect(await source.has(missingId as never)).toBe(false);
      expect(await source.getBytes(missingId as never)).toBeUndefined();
    });
  });
}
