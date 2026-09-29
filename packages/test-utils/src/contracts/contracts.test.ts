import { assetBytesSourceContract, audioOutContract, inputSourceContract, projectRepositoryContract, rendererContract, saveRepositoryContract } from "./index.js";

// M0: ポートがまだ無いので、契約スイートは骨格（todo）のみ。ここでは全スイートが登録・実行できることを確認する。
// ポートを実装するマイルストーンで、各アダプタのテストから契約スイートを呼び出す。
rendererContract("skeleton", () => ({}));
audioOutContract("skeleton", () => ({}));
inputSourceContract("skeleton", () => ({}));
assetBytesSourceContract("skeleton", () => ({}));
projectRepositoryContract("skeleton", () => ({}));
saveRepositoryContract("skeleton", () => ({}));
