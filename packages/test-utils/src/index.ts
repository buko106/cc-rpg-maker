/**
 * @rpg/test-utils — 共通テストユーティリティ（テスト専用）。
 *
 * 設計: docs/16-testing.md
 * M0 時点の内容: manualScheduler、契約スイートの骨格。
 * arbitraries / runtimeHarness / interpreterHarness / replay は各マイルストーンで追加する。
 */
export * from "./contracts/index.js";
export { createManualScheduler, DEFAULT_FRAME_MS } from "./harness/manualScheduler.js";
export type { ManualScheduler, ManualSchedulerOptions } from "./harness/manualScheduler.js";
