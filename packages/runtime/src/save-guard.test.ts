import { describe, expect, it } from "vitest";
import type { SlotMeta } from "./ports/saves.js";
import { loadNeedsConfirm, saveNeedsConfirm } from "./save-guard.js";

const meta = (slot: number): SlotMeta => ({ slot, savedAt: "2026-01-01T00:00:00.000Z", playtimeTicks: 0, preview: { mapName: "m", partyNames: [], level: 1 }, version: 1, projectHash: "h", compatible: "yes" });

describe("saveNeedsConfirm", () => {
  const slots = [meta(1), meta(2)];

  it("空きスロットへの保存は確認しない", () => {
    expect(saveNeedsConfirm(slots, 3, undefined)).toBe(false);
    expect(saveNeedsConfirm(slots, 3, { slot: 1, fingerprint: "a" })).toBe(false);
  });

  it("データのあるスロットは、いまのプレイの元のスロットでなければ確認する", () => {
    expect(saveNeedsConfirm(slots, 2, undefined)).toBe(true); // 何もロード/セーブしていない
    expect(saveNeedsConfirm(slots, 2, { slot: 1, fingerprint: "a" })).toBe(true); // 別のスロットをロードした
  });

  it("ロード/セーブしたのと同じスロットへの保存は確認しない", () => {
    expect(saveNeedsConfirm(slots, 2, { slot: 2, fingerprint: "a" })).toBe(false);
  });

  it("読み込めないデータ（compatible: no）が入っているスロットも確認する", () => {
    expect(saveNeedsConfirm([{ ...meta(4), compatible: "no" }], 4, undefined)).toBe(true);
  });
});

describe("loadNeedsConfirm", () => {
  const slots = [meta(1), { ...meta(2), compatible: "no" as const }];

  it("最後にセーブ/ロードした状態から進んでいれば確認する", () => {
    expect(loadNeedsConfirm(slots, 1, { slot: 1, fingerprint: "a" }, "b")).toBe(true);
  });

  it("セーブ/ロードした直後（進行が同じ）は確認しない", () => {
    expect(loadNeedsConfirm(slots, 1, { slot: 1, fingerprint: "a" }, "a")).toBe(false);
  });

  it("まだ一度もセーブ/ロードしていなければ確認する", () => {
    expect(loadNeedsConfirm(slots, 1, undefined, "a")).toBe(true);
  });

  it("空きや読み込めないスロットは（失敗するだけなので）確認しない", () => {
    expect(loadNeedsConfirm(slots, 3, undefined, "a")).toBe(false);
    expect(loadNeedsConfirm(slots, 2, undefined, "a")).toBe(false);
  });
});
