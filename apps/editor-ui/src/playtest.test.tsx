// @vitest-environment jsdom
import { createNullAudioOut } from "@rpg/audio-null";
import { cmd } from "@rpg/editor-core";
import { createScriptInput } from "@rpg/input-script";
import { createNullRenderer } from "@rpg/render-null";
import type { AssetSource, ImageHandle } from "@rpg/runtime";
import type { EventId, MapId } from "@rpg/schema";
import { createManualScheduler } from "@rpg/test-utils";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlaytestPanel } from "./components/PlaytestPanel.js";
import { startPlaytest } from "./playtest.js";
import type { PlaytestDeps } from "./playtest.js";
import { createTestEnv } from "./test-env.js";
import type { TestEnv } from "./test-env.js";

const M1 = "map_001" as MapId;
let t: TestEnv;
beforeEach(async () => {
  t = await createTestEnv();
});
afterEach(cleanup);

const assets: AssetSource = {
  loadImage: () => Promise.resolve({} as ImageHandle),
  loadAudio: () => Promise.reject(new Error("音声なし")),
  loadJson: () => Promise.reject(new Error("JSON なし")),
  has: () => Promise.resolve(true),
};
const deps = (): PlaytestDeps & { scheduler: ReturnType<typeof createManualScheduler> } => ({
  scheduler: createManualScheduler(),
  renderer: createNullRenderer(),
  audio: createNullAudioOut(),
  input: createScriptInput([]),
  assets,
  seed: "seed",
});

describe("startPlaytest", () => {
  it("編集中の文書でゲームが始まる（既定はタイトルから）", async () => {
    const d = deps();
    const pt = await startPlaytest(t.session, d);
    expect(pt.runtime.status).toBe("running");
    expect(pt.runtime.getState().scene.kind).toBe("title");
    pt.stop();
    expect(pt.runtime.status).toBe("stopped");
  });

  it("start を渡すと、タイトルを飛ばしてその位置から始まる。編集内容も反映される", async () => {
    act(() => void t.session.execute(cmd.createMap({ name: "洞窟", order: 1 }, { width: 8, height: 8 }, "map_cave" as MapId)));
    act(() => void t.session.execute(cmd.createEvent("map_cave" as MapId, 1, 1, "ev_c" as EventId)));
    const d = deps();
    const pt = await startPlaytest(t.session, d, { mapId: "map_cave" as MapId, x: 3, y: 4 });
    const state = pt.runtime.getState();
    expect(state.scene.kind).toBe("map");
    expect(state.map.mapId).toBe("map_cave");
    expect(state.map.player).toMatchObject({ x: 3, y: 4 });
    expect(Object.keys(state.map.events)).toEqual(["ev_c"]);
    pt.stop();
  });

  it("本番のセーブには触れない（セーブ先はメモリ）", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const d = deps();
    const pt = await startPlaytest(t.session, d, { mapId: M1, x: 1, y: 1 });
    // 決定キーでメニューを開いてセーブ画面へ進むまでは行かないが、ループを回してもストレージに書かない
    d.scheduler.advance(500);
    await pt.runtime.settled();
    expect(setItem).not.toHaveBeenCalled();
    expect(pt.runtime.getState().tick).toBeGreaterThan(0);
    pt.stop();
  });

  it("起動に失敗したら reject する（存在しない開始マップ）", async () => {
    await expect(startPlaytest(t.session, deps(), { mapId: "nope" as MapId, x: 0, y: 0 })).rejects.toThrow("プロジェクトに無い");
  });
});

describe("PlaytestPanel", () => {
  it("開くと起動し、閉じると止める。開始位置を表示する", async () => {
    let stopped = 0;
    t.env.startPlaytest = (_s, canvas, start, padRoot) => {
      t.playtests.push({ canvas, start, padRoot });
      return Promise.resolve({ runtime: { getState: () => ({}) } as never, stop: () => void stopped++ });
    };
    const { unmount } = render(t.wrap(<PlaytestPanel start={{ mapId: M1, x: 2, y: 3 }} onClose={() => {}} />));
    await waitFor(() => expect(t.playtests).toHaveLength(1));
    expect(screen.getByText(/開始位置：MAP001 \(2, 3\)/)).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/操作：矢印キー/)).toBeTruthy());
    expect((window as unknown as { __rpgPlaytest?: unknown }).__rpgPlaytest).toBeDefined();
    // 操作パッドを載せる場所（ダイアログの中）を渡す
    expect(t.playtests[0]!.padRoot).toBeInstanceOf(HTMLElement);
    expect(screen.getByRole("dialog").contains(t.playtests[0]!.padRoot!)).toBe(true);
    unmount();
    expect(stopped).toBe(1);
    expect((window as unknown as { __rpgPlaytest?: unknown }).__rpgPlaytest).toBeUndefined();
  });

  it("起動に失敗したらメッセージを出す", async () => {
    t.env.startPlaytest = () => Promise.reject(new Error("壊れた"));
    render(t.wrap(<PlaytestPanel onClose={() => {}} />));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("壊れた"));
  });

  it("起動が終わる前に閉じたら、起動したものをすぐ止める", async () => {
    let resolve!: (pt: { runtime: never; stop: () => void }) => void;
    let stopped = 0;
    t.env.startPlaytest = () => new Promise((r) => (resolve = r as never));
    const { unmount } = render(t.wrap(<PlaytestPanel onClose={() => {}} />));
    unmount();
    resolve({ runtime: {} as never, stop: () => void stopped++ });
    await waitFor(() => expect(stopped).toBe(1));
  });

  it("指が主入力の端末では、タッチ操作の案内を出す", async () => {
    const original = window.matchMedia;
    window.matchMedia = ((q: string) => ({ matches: q === "(pointer: coarse)", media: q }) as MediaQueryList) as typeof window.matchMedia;
    try {
      render(t.wrap(<PlaytestPanel onClose={() => {}} />));
      await waitFor(() => expect(screen.getByText(/操作：画面下の十字キー/)).toBeTruthy());
    } finally {
      window.matchMedia = original;
    }
  });
});
