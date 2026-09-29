import { describe, expect, it } from "vitest";
import { audioOutContract } from "@rpg/test-utils";
import { createNullAudioOut } from "./index.js";

audioOutContract("null", () => createNullAudioOut());

const ref = { asset: "aaaaaaaaaaaaaaaa" as never, volume: 1, pitch: 1, loop: true };

describe("createNullAudioOut", () => {
  it("呼び出しを順に記録する", () => {
    const a = createNullAudioOut();
    a.playBgm(ref, 300);
    a.playSe(ref);
    a.stopBgm();
    a.setMasterVolume(0.5);
    expect(a.calls.map((c) => c.method)).toEqual(["playBgm", "playSe", "stopBgm", "setMasterVolume"]);
    expect(a.calls[0]?.args).toEqual([ref, 300]);
    a.clear();
    expect(a.calls).toEqual([]);
  });

  it("[inv-2] dispose は記録されるが、その後の呼び出しは記録されない", () => {
    const a = createNullAudioOut();
    a.dispose();
    a.playSe(ref);
    expect(a.calls.map((c) => c.method)).toEqual(["dispose"]);
  });
});
