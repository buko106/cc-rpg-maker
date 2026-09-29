import { projectRepositoryContract, saveRepositoryContract } from "./index.js";

// ポートの実装（M3 の SaveRepository、M1 以降の ProjectRepository）が入るまでは骨格（todo）のみ。
// Renderer / AudioOut / InputSource / AssetBytesSource の契約は実装済みで、各アダプタのテストから呼び出す。
projectRepositoryContract("skeleton", () => ({}));
saveRepositoryContract("skeleton", () => ({}));
