import { type ContractFactory, registerContractSkeleton } from "./contract.js";

/**
 * Renderer の契約スイート（骨格）。すべての Renderer アダプタはこれを通さなければならない。
 * 不変条件の定義: docs/07-render.md
 */
export function rendererContract<T = unknown>(name: string, make: ContractFactory<T>): void {
  registerContractSkeleton("Renderer", "07-render.md", name, make);
}
