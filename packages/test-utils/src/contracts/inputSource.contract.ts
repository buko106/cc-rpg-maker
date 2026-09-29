import { type ContractFactory, registerContractSkeleton } from "./contract.js";

/**
 * InputSource の契約スイート（骨格）。すべての InputSource アダプタはこれを通さなければならない。
 * 不変条件の定義: docs/08-audio-input.md
 */
export function inputSourceContract<T = unknown>(name: string, make: ContractFactory<T>): void {
  registerContractSkeleton("InputSource", "08-audio-input.md", name, make);
}
