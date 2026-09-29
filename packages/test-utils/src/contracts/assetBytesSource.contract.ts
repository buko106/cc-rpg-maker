import { type ContractFactory, registerContractSkeleton } from "./contract.js";

/**
 * AssetBytesSource の契約スイート（骨格）。すべての AssetBytesSource アダプタはこれを通さなければならない。
 * 不変条件の定義: docs/09-assets.md
 */
export function assetBytesSourceContract<T = unknown>(name: string, make: ContractFactory<T>): void {
  registerContractSkeleton("AssetBytesSource", "09-assets.md", name, make);
}
