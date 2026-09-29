import { type ContractFactory, registerContractSkeleton } from "./contract.js";

/**
 * ProjectRepository の契約スイート（骨格）。すべての ProjectRepository アダプタはこれを通さなければならない。
 * 不変条件の定義: docs/10-project-store.md
 */
export function projectRepositoryContract<T = unknown>(name: string, make: ContractFactory<T>): void {
  registerContractSkeleton("ProjectRepository", "10-project-store.md", name, make);
}
