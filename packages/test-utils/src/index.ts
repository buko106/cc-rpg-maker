/**
 * @rpg/test-utils — 共通テストユーティリティ（テスト専用）。
 *
 * 設計: docs/16-testing.md
 * M1 時点の内容: arbitraries（schema / state）、契約スイートの骨格、
 * harness（manualScheduler / interpreterHarness / replay / project / freeze）、fixtures ローダ。
 * runtimeHarness は M2 で追加する。
 */
export * from "./contracts/index.js";
export * from "./arbitraries/schema.js";
export * from "./arbitraries/state.js";
export * from "./fixtures.js";
export { deepFreeze, isDeepFrozen } from "./harness/freeze.js";
export { cmd, runCommands } from "./harness/interpreterHarness.js";
export type { RunCommandsOptions, RunCommandsResult } from "./harness/interpreterHarness.js";
export { createManualScheduler, DEFAULT_FRAME_MS } from "./harness/manualScheduler.js";
export type { ManualScheduler, ManualSchedulerOptions } from "./harness/manualScheduler.js";
export { loadFixtureProject } from "./harness/project.js";
export type { LoadedProject } from "./harness/project.js";
export { expandInputs, getPath, hashState, listReplays, loadReplay, runReplay, stableStringify, updateReplayHash } from "./harness/replay.js";
export type { ReplayFixture, ReplayInput, ReplayResult } from "./harness/replay.js";
