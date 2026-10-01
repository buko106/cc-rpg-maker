/**
 * @rpg/test-utils — 共通テストユーティリティ（テスト専用）。
 *
 * 設計: docs/16-testing.md
 * M2 時点の内容: arbitraries（schema / state）、契約スイート（Renderer / AudioOut / InputSource / AssetBytesSource は実装済み、
 * 残りは骨格）、harness（manualScheduler / interpreterHarness / replay / project / freeze / runtimeHarness / frame）、fixtures ローダ。
 */
export * from "./contracts/index.js";
export * from "./arbitraries/schema.js";
export { editorCommandArb } from "./arbitraries/editorCommands.js";
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
export { createMemorySaveRepository } from "@rpg/save-store"; // runtime のテストはアダプタを直接 import できないので、ここから使う
export { createMemoryStorage, quotaError } from "./harness/memoryStorage.js";
export type { MemoryStorage } from "./harness/memoryStorage.js";
export { createFakeDirectory } from "./harness/fakeDirectory.js";
export type { FakeDirectory } from "./harness/fakeDirectory.js";
export { summarizeFrame } from "./harness/frame.js";
export { createRuntimeHarness } from "./harness/runtimeHarness.js";
export type { RuntimeHarness, RuntimeHarnessOptions, TestProjectSource } from "./harness/runtimeHarness.js";
export { autoBattle, battleKit, battleProject, beginBattle, drive, driveUntil, idleFrames, press } from "./harness/battle.js";
export type { AutoBattleChoice, AutoBattlePolicy, AutoBattleTurn, BattleKit, DriveResult } from "./harness/battle.js";
