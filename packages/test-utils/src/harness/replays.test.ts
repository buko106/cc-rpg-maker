import { describe, expect, it } from "vitest";
import { listReplays, loadReplay, runReplay, updateReplayHash } from "./replay.js";

const UPDATE = process.env["UPDATE_REPLAYS"] === "1";

// fixtures/replays/*.json を全件実行する（docs/16-testing.md）。
// finalStateHash を更新するときは UPDATE_REPLAYS=1 pnpm test を実行し、差分をレビューすること。
describe("replay fixtures", () => {
  it("has at least 3 replays (M1 completion criterion)", () => {
    expect(listReplays().length).toBeGreaterThanOrEqual(3);
  });

  describe.each(listReplays())("%s", (name) => {
    const fixture = loadReplay(name);
    const result = runReplay(fixture);

    it("satisfies its tick assertions", () => {
      expect(fixture.assertions?.length ?? 0).toBeGreaterThan(0);
      expect(result.assertionFailures).toEqual([]);
    });

    it("emits the expected effects", () => {
      for (const [kind, count] of Object.entries(fixture.expect.effects ?? {})) {
        expect(result.effectCounts[kind] ?? 0, `effect ${kind}`).toBe(count);
      }
    });

    it("ends in the expected state (finalStateHash)", () => {
      if (UPDATE) updateReplayHash(name, result.finalStateHash);
      else expect(result.finalStateHash).toBe(fixture.expect.finalStateHash);
    });

    it("is deterministic: a second run gives an identical final state and effects", () => {
      const again = runReplay(fixture);
      expect(again.state).toEqual(result.state);
      expect(again.effects).toEqual(result.effects);
    });
  });
});
