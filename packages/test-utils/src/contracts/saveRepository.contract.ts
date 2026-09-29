import { type ContractFactory, registerContractSkeleton } from "./contract.js";

/**
 * SaveRepository の契約スイート（骨格）。すべての SaveRepository アダプタはこれを通さなければならない。
 * 不変条件の定義: docs/11-save-store.md
 */
export function saveRepositoryContract<T = unknown>(name: string, make: ContractFactory<T>): void {
  registerContractSkeleton("SaveRepository", "11-save-store.md", name, make);
}
