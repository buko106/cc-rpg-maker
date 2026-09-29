import { describe, it } from "vitest";

/** アダプタのインスタンスを作るファクトリ。契約テストはアダプタごとに新しいインスタンスを作る。 */
export type ContractFactory<T> = () => T | Promise<T>;

/**
 * 契約スイートの骨格を登録する。
 *
 * ポートの定義（各マイルストーン）が入るまでは、`it.todo` だけを登録する。
 * ポートを実装するときに、docs の「不変条件」を 1:1 で `it` に置き換える（docs/16-testing.md）。
 * ポート型を変更するときは契約テストの更新を伴う（docs/00-principles.md §6）。
 */
export function registerContractSkeleton<T>(port: string, doc: string, name: string, _make: ContractFactory<T>): void {
  describe(`${port} contract: ${name}`, () => {
    it.todo(`${port} の不変条件を写す（docs/${doc}）`);
  });
}
