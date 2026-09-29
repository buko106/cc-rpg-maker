import { type ContractFactory, registerContractSkeleton } from "./contract.js";

/**
 * AudioOut の契約スイート（骨格）。すべての AudioOut アダプタはこれを通さなければならない。
 * 不変条件の定義: docs/08-audio-input.md
 */
export function audioOutContract<T = unknown>(name: string, make: ContractFactory<T>): void {
  registerContractSkeleton("AudioOut", "08-audio-input.md", name, make);
}
