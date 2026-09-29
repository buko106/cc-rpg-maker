import { describe, expect, it, vi } from "vitest";
import { createRuntimeHarness, expandInputs, hashState, listReplays, loadReplay } from "@rpg/test-utils";
import type { RuntimeHarness } from "@rpg/test-utils";
import { inputFrame } from "@rpg/core";
import { MAX_FRAME_MS, MAX_STEPS_PER_FRAME, STEP_MS } from "./runtime.js";

const boot = (project = "minimal", extra: Partial<Parameters<typeof createRuntimeHarness>[0]> = {}): Promise<RuntimeHarness> =>
  createRuntimeHarness({ project, ...extra });

describe("Runtime のループ", () => {
  it("start 前の getState は例外。start すると初期状態と最初の描画が得られる", async () => {
    const h = await boot();
    expect(h.runtime.status).toBe("running");
    expect(h.runtime.getState().tick).toBe(0);
    expect(h.renderer.initOpts?.width).toBe(320);
    expect(h.renderer.size).toEqual({ width: 320, height: 256 });
  });

  it("[inv-1] frame を呼ばない限り getState は変化しない", async () => {
    const h = await boot();
    const before = h.runtime.getState();
    h.input.push(...expandInputs([{ hold: "right", frames: 5 }]));
    expect(h.runtime.getState()).toBe(before);
    h.advanceFrames(0);
    expect(h.runtime.getState()).toBe(before);
    expect(h.renderer.frames).toHaveLength(0);
  });

  it("フレーム境界ごとに 1 ステップ進み、毎回描画する（advance(16.67 * 3) で tick が 3 増える）", async () => {
    const h = await boot();
    h.scheduler.advance(16.67 * 3);
    expect(h.runtime.getState().tick).toBe(3);
    expect(h.renderer.frames).toHaveLength(3);
    h.advanceFrames(7);
    expect(h.runtime.getState().tick).toBe(10);
  });

  it("端数の経過時間は次のフレームに持ち越す（1.5 ステップ分 → 1、さらに 0.5 → 2）", async () => {
    const h = await boot();
    await h.runtime.frame(STEP_MS * 1.5);
    expect(h.runtime.getState().tick).toBe(1);
    await h.runtime.frame(STEP_MS * 2);
    expect(h.runtime.getState().tick).toBe(2);
  });

  it("[inv-4] 250ms を超える経過は切り捨て、1 回の frame で core.step は最大 15 回", async () => {
    const h = await boot();
    await h.runtime.frame(10_000);
    expect(h.runtime.getState().tick).toBe(MAX_STEPS_PER_FRAME);
    expect(MAX_STEPS_PER_FRAME * STEP_MS).toBeCloseTo(MAX_FRAME_MS, 5);
    await h.runtime.frame(20_000);
    expect(h.runtime.getState().tick).toBe(MAX_STEPS_PER_FRAME * 2);
  });

  it("ステップが無いフレームでは入力を poll しない（押下が失われない）", async () => {
    const h = await boot();
    h.input.push(inputFrame(["ok"], ["ok"]));
    await h.runtime.frame(1); // 1ms しか経っていない
    expect(h.input.remaining()).toBe(1);
    await h.runtime.frame(STEP_MS + 1);
    expect(h.input.remaining()).toBe(0);
  });

  it("時間が戻っても（負の経過）ステップは進まない", async () => {
    const h = await boot();
    await h.runtime.frame(100);
    const tick = h.runtime.getState().tick;
    await h.runtime.frame(50);
    expect(h.runtime.getState().tick).toBe(tick);
  });

  it("stop するとループが止まり、frame も何もしない。start の二重呼び出しは例外", async () => {
    const h = await boot();
    h.advanceFrames(2);
    h.runtime.stop();
    expect(h.runtime.status).toBe("stopped");
    h.advanceFrames(5);
    await h.runtime.frame(99_999);
    expect(h.runtime.getState().tick).toBe(2);
    expect(h.scheduler.pendingCount).toBe(0);
    h.runtime.stop();
    await expect(h.runtime.start()).rejects.toThrow(/stopped/);
  });

  it("[inv-2] 同じ入力列からは同じ最終状態（決定論）", async () => {
    const run = async (): Promise<string> => {
      const h = await boot("minimal", { seed: "same" });
      h.play(...expandInputs([{ hold: "right", frames: 40 }, { hold: "down", frames: 20 }, { press: "ok" }]));
      return hashState(h.runtime.getState());
    };
    expect(await run()).toBe(await run());
  });

  it("リプレイ（core だけで作った期待ハッシュ）を Runtime 経由で実行しても最終状態が一致する", async () => {
    // door-transfer は遅延ロードでステップ数がずれるので、別テストで確かめる
    for (const name of listReplays().filter((n) => n !== "door-transfer")) {
      const replay = loadReplay(name);
      const h = await boot(replay.project.split("/").pop(), { seed: replay.seed });
      h.play(...expandInputs(replay.inputs));
      expect(hashState(h.runtime.getState()), name).toBe(replay.expect.finalStateHash);
    }
  });
});

describe("歩行と会話（投影まで通した確認）", () => {
  it("右へ歩くとプレイヤーが動き、Renderer には現在の状態の投影が渡される", async () => {
    const h = await boot();
    h.play(...expandInputs([{ hold: "right", frames: 32 }]));
    expect(h.runtime.getState().map.player.x).toBe(4);
    expect(h.renderer.last()).toEqual(h.runtime.project());
  });

  it("NPC に話しかけるとメッセージウィンドウが FrameSpec に現れ、決定で閉じる", async () => {
    const h = await boot();
    h.play(...expandInputs([{ hold: "right", frames: 100 }, { press: "ok" }, { wait: 1 }]));
    const open = h.renderer.last()!;
    expect(h.runtime.getState().message.open).toBe(true);
    const win = open.ui[0];
    expect(win?.kind).toBe("window");
    expect(JSON.stringify(open.ui)).toContain("こんにちは！");

    h.play(...expandInputs([{ press: "ok" }, { wait: 2 }]));
    expect(h.renderer.last()!.ui).toEqual([]);
  });
});

describe("Effect の分配", () => {
  it("onEffect で観測でき、解除できる", async () => {
    const h = await boot();
    const seen: string[] = [];
    const off = h.runtime.onEffect((e) => seen.push(e.kind));
    h.runtime.dispatch({ type: "loadSnapshot", snapshot: { version: 999 } as never });
    off();
    h.runtime.dispatch({ type: "loadSnapshot", snapshot: { version: 999 } as never });
    expect(seen).toEqual(["log"]);
    expect(h.effects.map((e) => e.kind)).toEqual(["log", "log"]);
    expect(h.warnings).toHaveLength(2); // log(warn) は logger.warn に届く
  });

  it("dispatch は状態を進め（tick は進めない）、インタプリタの開始 Action も受け付ける", async () => {
    const h = await boot();
    h.runtime.dispatch({ type: "interpreter", op: "start", origin: { kind: "plugin", name: "test" }, commands: [], mode: "normal" });
    expect(h.runtime.getState().interpreters).toHaveLength(1);
    expect(h.runtime.getState().tick).toBe(0);
  });
});

describe("マップの遅延ロード", () => {
  const doorInputs = expandInputs([
    { hold: "right", frames: 128 },
    { wait: 2 },
    { press: "ok" },
    { wait: 40 },
    { press: "ok" },
    { wait: 20 },
  ]);

  it("未ロードのマップへ移動すると paused(loading) になり、解決したら再開して移動が完了する", async () => {
    const h = await boot("transfer-demo", { deferMaps: ["map_b"] });
    let sent = 0;
    for (const f of doorInputs) {
      if (h.runtime.status === "loading") break;
      h.play(f);
      sent++;
    }
    expect(h.runtime.status).toBe("loading");
    expect(h.projectSource.requested).toEqual(["map_b"]);
    expect(h.runtime.getState().map.mapId).toBe("map_a");

    // ロード中は時間が進まず、入力も消費されない。要求も 1 回だけ。
    const frozenTick = h.runtime.getState().tick;
    h.input.push(...doorInputs.slice(sent));
    const remaining = h.input.remaining();
    h.advanceFrames(30);
    expect(h.runtime.getState().tick).toBe(frozenTick);
    expect(h.input.remaining()).toBe(remaining);
    expect(h.projectSource.requested).toEqual(["map_b"]);
    expect(h.renderer.frames.length).toBeGreaterThan(0); // 画面は描き続ける

    h.projectSource.release("map_b");
    await vi.waitFor(() => expect(h.runtime.status).toBe("running"));
    h.advanceFrames(3);
    expect(h.runtime.getState().map.mapId).toBe("map_b");
    expect(h.runtime.getState().tick).toBeGreaterThan(frozenTick);
    // ロードされたマップが FrameSpec に反映される
    expect(h.runtime.project().layers.length).toBeGreaterThan(0);
  });

  it("frame() はロードの完了まで待つ", async () => {
    const h = await boot("transfer-demo", { deferMaps: ["map_b"] });
    h.input.push(...doorInputs);
    let now = 0;
    let done = false;
    let pending: Promise<void> | undefined;
    while (pending === undefined) {
      now += STEP_MS;
      const p = h.runtime.frame(now).then(() => {
        done = true;
      });
      if (h.runtime.status === "loading") pending = p;
      else await p;
    }
    done = false;
    await Promise.resolve();
    expect(done).toBe(false);
    h.projectSource.release("map_b");
    await pending;
    expect(done).toBe(true);
    expect(h.runtime.status).toBe("running");
  });

  it("マップの読み込みに失敗したら onError が呼ばれ、ループは止まる", async () => {
    const h = await boot("transfer-demo", { failMaps: ["map_b"] });
    h.input.push(...doorInputs);
    h.advanceFrames(doorInputs.length);
    await vi.waitFor(() => expect(h.runtime.status).toBe("failed"));
    expect(h.errors).toHaveLength(1);
    expect(String(h.errors[0])).toContain("map_b");
    expect(h.warnings.some((w) => w.includes("map_b"))).toBe(true);
    const tick = h.runtime.getState().tick;
    h.advanceFrames(5);
    expect(h.runtime.getState().tick).toBe(tick);
    expect(h.scheduler.pendingCount).toBe(0);
  });
});
