import { describe, expect, it } from "vitest";
import type { Effect } from "@rpg/core";
import type { AudioOut } from "./ports/audio.js";
import { distributeEffect } from "./effects.js";
import type { EffectSinks } from "./effects.js";

const audio = { asset: "aaaaaaaaaaaaaaaa" as never, volume: 1, pitch: 1, loop: false };
const white = { r: 255, g: 255, b: 255, a: 1 };

function setup() {
  const calls: { method: string; args: unknown[] }[] = [];
  const rec =
    (method: string) =>
    (...args: unknown[]): void => {
      calls.push({ method, args });
    };
  const out: AudioOut & { calls: typeof calls } = { calls, playBgm: rec("playBgm"), stopBgm: rec("stopBgm"), playSe: rec("playSe"), setMasterVolume: rec("setMasterVolume"), dispose: rec("dispose") };
  const logs: string[] = [];
  const visual: string[] = [];
  const loads: string[] = [];
  const saves: string[] = [];
  const logger = {
    debug: (m: string) => logs.push(`debug:${m}`),
    info: (m: string) => logs.push(`info:${m}`),
    warn: (m: string) => logs.push(`warn:${m}`),
    error: (m: string) => logs.push(`error:${m}`),
  };
  const sinks: EffectSinks = { audio: out, logger, visual: (e) => visual.push(e.kind), loadMap: (id) => loads.push(id),
    save: (slot) => saves.push(`save:${String(slot)}`),
    load: (slot) => saves.push(`load:${String(slot)}`),
  };
  return { out, logs, visual, loads, saves, sinks };
}

describe("distributeEffect", () => {
  it("[inv-5] 音の Effect は AudioOut に届く", () => {
    const { out, sinks } = setup();
    distributeEffect({ kind: "playSe", audio }, sinks);
    distributeEffect({ kind: "playBgm", audio, fadeMs: 500 }, sinks);
    distributeEffect({ kind: "stopBgm", fadeMs: 200 }, sinks);
    distributeEffect({ kind: "stopBgm" }, sinks);
    expect(out.calls.map((c) => [c.method, ...c.args])).toEqual([
      ["playSe", audio],
      ["playBgm", audio, 500],
      ["stopBgm", 200],
      ["stopBgm", undefined],
    ]);
  });

  it("[inv-5] 画面効果・マップ要求・ログはそれぞれの届け先へ", () => {
    const { logs, visual, loads, sinks } = setup();
    distributeEffect({ kind: "screenShake", power: 1, durationTicks: 1 }, sinks);
    distributeEffect({ kind: "screenFlash", color: white, durationTicks: 1 }, sinks);
    distributeEffect({ kind: "requestMapData", mapId: "map_b" as never }, sinks);
    distributeEffect({ kind: "log", level: "warn", message: "w" }, sinks);
    distributeEffect({ kind: "log", level: "info", message: "i" }, sinks);
    distributeEffect({ kind: "log", level: "debug", message: "d" }, sinks);
    expect(visual).toEqual(["screenShake", "screenFlash"]);
    expect(loads).toEqual(["map_b"]);
    expect(logs).toEqual(["warn:w", "info:i", "debug:d"]);
  });

  it("[inv-5] セーブ/ロードの要求はスロット番号つきで届く（省略もそのまま）", () => {
    const { logs, saves, sinks } = setup();
    distributeEffect({ kind: "requestSave", slot: 3 }, sinks);
    distributeEffect({ kind: "requestSave" }, sinks);
    distributeEffect({ kind: "requestLoad", slot: 1 }, sinks);
    expect(saves).toEqual(["save:3", "save:undefined", "load:1"]);
    expect(logs).toEqual([]);
  });

  it("[inv-5] 未対応の Effect（プラグイン・未知の種類）は warn に流れる", () => {
    const { logs, sinks } = setup();
    distributeEffect({ kind: "plugin", name: "p", payload: 1 }, sinks);
    distributeEffect({ kind: "somethingNew" } as unknown as Effect, sinks);
    expect(logs).toHaveLength(2);
    expect(logs.every((l) => l.startsWith("warn:"))).toBe(true);
    expect(logs[1]).toContain("somethingNew");
  });
});
