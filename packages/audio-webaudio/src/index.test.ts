import type { AssetSource, AudioRef } from "@rpg/runtime";
import { audioOutContract } from "@rpg/test-utils";
import { describe, expect, it } from "vitest";
import { createDecodeAudio, createWebAudioOut } from "./index.js";

// ---- 最小限の AudioContext モック（ノードの接続・パラメータの呼び出しを記録する） ----
class MockParam {
  value = 1;
  readonly calls: [string, ...number[]][] = [];
  setValueAtTime(v: number, t: number): void {
    this.value = v;
    this.calls.push(["set", v, t]);
  }
  linearRampToValueAtTime(v: number, t: number): void {
    this.calls.push(["ramp", v, t]);
  }
  cancelScheduledValues(t: number): void {
    this.calls.push(["cancel", t]);
  }
}
class MockGain {
  readonly gain = new MockParam();
  readonly connected: unknown[] = [];
  disconnected = false;
  connect(n: unknown): void {
    this.connected.push(n);
  }
  disconnect(): void {
    this.disconnected = true;
  }
}
class MockSource {
  buffer: unknown = null;
  loop = false;
  readonly playbackRate = new MockParam();
  onended: (() => void) | null = null;
  started = 0;
  stops: number[] = [];
  connected: unknown[] = [];
  connect(n: unknown): void {
    this.connected.push(n);
  }
  disconnect(): void {}
  start(): void {
    this.started++;
  }
  stop(t: number): void {
    this.stops.push(t);
  }
}
class MockContext {
  state: "running" | "suspended" | "closed" = "running";
  currentTime = 10;
  readonly destination = { kind: "destination" };
  readonly gains: MockGain[] = [];
  readonly sources: MockSource[] = [];
  resumed = 0;
  private listeners = new Set<() => void>();
  createGain(): MockGain {
    const g = new MockGain();
    this.gains.push(g);
    return g;
  }
  createBufferSource(): MockSource {
    const s = new MockSource();
    this.sources.push(s);
    return s;
  }
  resume(): Promise<void> {
    this.resumed++;
    this.setState("running");
    return Promise.resolve();
  }
  addEventListener(_: string, cb: () => void): void {
    this.listeners.add(cb);
  }
  removeEventListener(_: string, cb: () => void): void {
    this.listeners.delete(cb);
  }
  setState(s: MockContext["state"]): void {
    this.state = s;
    for (const cb of [...this.listeners]) cb();
  }
  decodeAudioData(bytes: ArrayBuffer): Promise<unknown> {
    return Promise.resolve({ decoded: bytes.byteLength });
  }
  get master(): MockGain {
    return this.gains[0]!;
  }
}

const buffers = new Map<string, { id: string }>();
function make(state: MockContext["state"] = "running", load?: AssetSource["loadAudio"]) {
  const ctx = new MockContext();
  ctx.state = state;
  const loads: string[] = [];
  const assets: AssetSource = {
    loadImage: () => Promise.reject(new Error("no image")),
    loadAudio: load ?? ((id) => (loads.push(id), Promise.resolve(buffers.get(id) ?? { id }) as never)),
    loadJson: () => Promise.reject(new Error("no json")),
    has: () => Promise.resolve(true),
  };
  const warnings: string[] = [];
  const out = createWebAudioOut(ctx as unknown as AudioContext, assets, { logger: { debug() {}, info() {}, warn: (m) => warnings.push(m), error() {} } });
  return { ctx, out, loads, warnings };
}
const ref = (asset: string, over: Partial<AudioRef> = {}): AudioRef => ({ asset: asset as never, volume: 0.8, pitch: 1, loop: true, ...over });
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

audioOutContract("webaudio (mock AudioContext)", () => make().out);
audioOutContract("webaudio (suspended)", () => make("suspended").out);

describe("createWebAudioOut: BGM", () => {
  it("plays a loaded BGM through a gain node into the master gain, with volume, pitch and loop", async () => {
    const { ctx, out } = make();
    out.playBgm(ref("aaaa", { volume: 0.5, pitch: 1.5 }));
    await flush();
    const [source] = ctx.sources;
    expect(ctx.sources).toHaveLength(1);
    expect(source).toMatchObject({ loop: true, started: 1, buffer: { id: "aaaa" } });
    expect(source!.playbackRate.value).toBe(1.5);
    const gain = ctx.gains[1]!;
    expect(gain.gain.calls).toEqual([["set", 0.5, 10]]);
    expect(source!.connected).toEqual([gain]);
    expect(gain.connected).toEqual([ctx.master]);
    expect(ctx.master.connected).toEqual([ctx.destination]);
  });

  it("[inv-1] does not restart the same BGM: repeated calls only update volume and pitch", async () => {
    const { ctx, out, loads } = make();
    out.playBgm(ref("aaaa"));
    await flush();
    out.playBgm(ref("aaaa"));
    out.playBgm(ref("aaaa", { volume: 0.3, pitch: 2 }), 500);
    await flush();
    expect(ctx.sources).toHaveLength(1);
    expect(loads).toEqual(["aaaa"]);
    expect(ctx.sources[0]!.playbackRate.value).toBe(2);
    expect(ctx.gains[1]!.gain.calls.at(-1)).toEqual(["ramp", 0.3, 10.5]);
  });

  it("[inv-1] rapid repeats before the first load finishes still start a single source", async () => {
    const { ctx, out } = make();
    for (let i = 0; i < 5; i++) out.playBgm(ref("aaaa"));
    await flush();
    expect(ctx.sources.length).toBe(1);
    expect(ctx.sources.filter((s) => s.stops.length === 0)).toHaveLength(1);
  });

  it("switching songs fades the old one out and the new one in; only the latest request wins", async () => {
    const { ctx, out } = make();
    out.playBgm(ref("aaaa"));
    await flush();
    out.playBgm(ref("bbbb"), 1000);
    out.playBgm(ref("cccc"), 1000); // bbbb の読み込み中に次が来た
    await flush();
    expect(ctx.sources).toHaveLength(2); // aaaa と cccc（bbbb は鳴らない）
    expect(ctx.sources[0]!.stops).toEqual([11]);
    expect(ctx.gains[1]!.gain.calls.at(-1)).toEqual(["ramp", 0, 11]);
    expect(ctx.sources[1]!.buffer).toEqual({ id: "cccc" });
    expect(ctx.gains[2]!.gain.calls).toEqual([["set", 0, 10], ["ramp", 0.8, 11]]);
  });

  it("stopBgm fades out and stops the source at the end of the fade; a stop during loading cancels the start", async () => {
    const { ctx, out } = make();
    out.playBgm(ref("aaaa"));
    await flush();
    out.stopBgm(2000);
    expect(ctx.sources[0]!.stops).toEqual([12]);
    expect(ctx.gains[1]!.gain.calls.at(-1)).toEqual(["ramp", 0, 12]);
    out.playBgm(ref("bbbb"));
    out.stopBgm();
    await flush();
    expect(ctx.sources).toHaveLength(1); // bbbb は鳴らない
    out.stopBgm(); // 何も鳴っていなくても平気
  });

  it("a BGM that fails to load is reported and does not break later playback", async () => {
    let n = 0;
    const { ctx, out, warnings } = make("running", (id) => (n++ === 0 ? Promise.reject(new Error("404")) : Promise.resolve({ id } as never)));
    out.playBgm(ref("aaaa"));
    await flush();
    expect(warnings).toEqual(["BGM aaaa を読み込めない: 404"]);
    out.playBgm(ref("aaaa"));
    await flush();
    expect(ctx.sources).toHaveLength(1);
  });
});

describe("createWebAudioOut: autoplay restriction (suspended AudioContext)", () => {
  it("[inv-3] queues only the latest BGM while suspended and plays it after resume()", async () => {
    const { ctx, out, loads } = make("suspended");
    expect(() => {
      out.playBgm(ref("aaaa"));
      out.playBgm(ref("bbbb"));
      out.playSe(ref("cccc", { loop: false }));
    }).not.toThrow();
    await flush();
    expect(loads).toEqual([]);
    expect(ctx.sources).toHaveLength(0);
    await out.resume();
    await flush();
    expect(ctx.resumed).toBe(1);
    expect(loads).toEqual(["bbbb"]);
    expect(ctx.sources).toHaveLength(1);
  });

  it("also starts the queued BGM when the context becomes running on its own (statechange)", async () => {
    const { ctx, out } = make("suspended");
    out.playBgm(ref("aaaa"));
    ctx.setState("running");
    await flush();
    expect(ctx.sources).toHaveLength(1);
    expect(ctx.sources[0]!.buffer).toEqual({ id: "aaaa" });
  });

  it("stopBgm clears a queued BGM", async () => {
    const { ctx, out } = make("suspended");
    out.playBgm(ref("aaaa"));
    out.stopBgm();
    await out.resume();
    await flush();
    expect(ctx.sources).toHaveLength(0);
  });

  it("resume() on a running context does not call resume again, and a failing resume is only a warning", async () => {
    const running = make();
    await running.out.resume();
    expect(running.ctx.resumed).toBe(0);
    const failing = make("suspended");
    failing.ctx.resume = () => Promise.reject(new Error("blocked"));
    await failing.out.resume();
    expect(failing.warnings).toEqual(["AudioContext を再開できない: blocked"]);
  });
});

describe("createWebAudioOut: sound effects, master volume and dispose", () => {
  it("plays a one-shot SE with its volume and pitch, and disconnects when it ends", async () => {
    const { ctx, out } = make();
    out.playSe(ref("sesesese", { volume: 0.4, pitch: 2, loop: false }));
    await flush();
    const [source] = ctx.sources;
    expect(source).toMatchObject({ started: 1, loop: false });
    expect(source!.playbackRate.value).toBe(2);
    expect(ctx.gains[1]!.gain.value).toBe(0.4);
    source!.onended?.();
    expect(ctx.gains[1]!.disconnected).toBe(true);
  });

  it("SEs overlap (each plays on its own source)", async () => {
    const { ctx, out } = make();
    out.playSe(ref("se1", { loop: false }));
    out.playSe(ref("se2", { loop: false }));
    await flush();
    expect(ctx.sources).toHaveLength(2);
  });

  it("a failing SE is only a warning", async () => {
    const { out, warnings } = make("running", () => Promise.reject(new Error("bad")));
    out.playSe(ref("se1", { loop: false }));
    await flush();
    expect(warnings).toEqual(["SE se1 を再生できない: bad"]);
  });

  it("master volume is clamped to [0, 1] and treats NaN as 0", () => {
    const { ctx, out } = make();
    out.setMasterVolume(0.25);
    expect(ctx.master.gain.value).toBe(0.25);
    out.setMasterVolume(5);
    expect(ctx.master.gain.value).toBe(1);
    out.setMasterVolume(-1);
    expect(ctx.master.gain.value).toBe(0);
    out.setMasterVolume(Number.NaN);
    expect(ctx.master.gain.value).toBe(0);
  });

  it("[inv-2] dispose stops the BGM, detaches from the context and turns every call into a no-op", async () => {
    const { ctx, out } = make();
    out.playBgm(ref("aaaa"));
    await flush();
    out.dispose();
    expect(ctx.sources[0]!.stops).toEqual([10]);
    expect(ctx.master.disconnected).toBe(true);
    out.playBgm(ref("bbbb"));
    out.playSe(ref("cc", { loop: false }));
    out.setMasterVolume(0.1);
    await out.resume();
    ctx.setState("suspended");
    ctx.setState("running");
    await flush();
    expect(ctx.sources).toHaveLength(1);
    expect(ctx.master.gain.value).toBe(1);
    out.dispose();
  });

  it("dispose while a load is in flight never starts the sound", async () => {
    const { ctx, out } = make();
    out.playBgm(ref("aaaa"));
    out.dispose();
    await flush();
    expect(ctx.sources).toHaveLength(0);
  });
});

describe("createDecodeAudio", () => {
  it("decodes a copy of the bytes so the cached original stays intact", async () => {
    const ctx = new MockContext();
    const seen: ArrayBuffer[] = [];
    ctx.decodeAudioData = (b) => (seen.push(b), Promise.resolve({ ok: true }));
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    const handle = await createDecodeAudio(ctx as unknown as AudioContext)(bytes);
    expect(handle).toEqual({ ok: true });
    expect(seen[0]).not.toBe(bytes);
    expect(new Uint8Array(seen[0]!)).toEqual(new Uint8Array([1, 2, 3]));
  });
});
