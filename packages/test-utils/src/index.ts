/**
 * @rpg/test-utils — 共通テストユーティリティ（テスト専用）。
 *
 * 設計: docs/16-testing.md
 */
export * from "./contracts/index.js";
export * from "./arbitraries/schema.js";
export * from "./fixtures.js";
export { createManualScheduler, DEFAULT_FRAME_MS } from "./harness/manualScheduler.js";
export type { ManualScheduler, ManualSchedulerOptions } from "./harness/manualScheduler.js";
