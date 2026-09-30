import { describe, expect, it, vi } from "vitest";
import { inputFrame } from "@rpg/core";
import type { Button, InputFrame } from "@rpg/core";
import { createMemorySaveRepository, createRuntimeHarness, expandInputs } from "@rpg/test-utils";
import type { RuntimeHarness, RuntimeHarnessOptions } from "@rpg/test-utils";
import type { SaveRepository, UiNode } from "./index.js";

const boot = (opts: Partial<RuntimeHarnessOptions> = {}): Promise<RuntimeHarness> => createRuntimeHarness({ project: "minimal", title: true, ...opts });

const tap = (...buttons: Button[]): InputFrame[] => buttons.map((b) => inputFrame([b], [b]));
const textsOf = (nodes: readonly UiNode[]): string[] => nodes.flatMap((n) => (n.kind === "window" ? textsOf(n.children) : n.kind === "text" ? [n.text] : []));
const screenTexts = (h: RuntimeHarness): string[] => textsOf(h.renderer.last()?.ui ?? []);
/** ボタンを 1 つずつ押し、そのたびにループを回す。 */
const press = (h: RuntimeHarness, ...buttons: Button[]): void => h.play(...tap(...buttons).flatMap((f) => [f, inputFrame()]));

/** タイトルからニューゲームして右へ 1 タイル歩く（x: 2 → 3）。 */
async function newGameAndWalk(h: RuntimeHarness): Promise<void> {
  press(h, "ok");
  expect(h.runtime.getState().scene).toEqual({ kind: "map" });
  h.play(...expandInputs([{ hold: "right", frames: 16 }]));
  expect(h.runtime.getState().map.player.x).toBe(3);
}

/** メニューを開いてセーブ画面のスロット `slot`（1 始まり）で決定する。 */
async function saveTo(h: RuntimeHarness, slot: number): Promise<void> {
  press(h, "menu", "down", "down", "ok"); // メイン → セーブ
  press(h, ...Array<Button>(slot - 1).fill("down"), "ok");
  await h.runtime.settled();
}

/** transfer-demo の扉を抜けて map_b へ。マップの読み込みで止まるたびに完了を待つ。 */
async function throughDoor(h: RuntimeHarness): Promise<void> {
  for (const f of expandInputs([{ hold: "right", frames: 128 }, { wait: 2 }, { press: "ok" }, { wait: 40 }, { press: "ok" }, { wait: 20 }])) {
    h.play(f);
    if (h.runtime.status === "loading") await h.runtime.settled();
  }
  expect(h.runtime.getState().map.mapId).toBe("map_b");
}

describe("タイトル", () => {
  it("start するとタイトル画面。ニューゲームでマップに入り、時間が進み始める", async () => {
    const h = await boot();
    expect(h.runtime.getState().scene).toMatchObject({ kind: "title", screen: "main", cursor: 0 });
    expect(screenTexts(h).length).toBe(0); // start 直後はまだ描画していない
    h.advanceFrames(1);
    expect(screenTexts(h)).toEqual(["minimal", "ニューゲーム", "コンティニュー"]);

    h.play(...expandInputs([{ hold: "right", frames: 30 }]));
    expect(h.runtime.getState().map.player.x).toBe(2); // タイトルでは歩けない
    press(h, "ok");
    expect(h.runtime.getState().scene).toEqual({ kind: "map" });
  });

  it("system.bgm.title があればタイトルで流し、ニューゲームで止める", async () => {
    const bgm = { asset: "aaaaaaaaaaaaaaaa" as never, volume: 1, pitch: 1, loop: true };
    const h = await boot({ patchProject: (p) => ({ ...p, system: { ...p.system, bgm: { title: bgm } } }) });
    expect(h.audio.calls).toEqual([{ method: "playBgm", args: [bgm] }]);
    press(h, "ok");
    expect(h.audio.calls.at(-1)).toEqual({ method: "stopBgm", args: [500] });
    const silent = await boot();
    expect(silent.audio.calls).toEqual([]);
  });

  it("title: false ならすぐマップから始まる", async () => {
    const h = await boot({ title: false });
    expect(h.runtime.getState().scene).toEqual({ kind: "map" });
  });
});

describe("セーブ", () => {
  it("メニューのセーブ画面で決定すると、そのスロットに保存され、お知らせが出て消える", async () => {
    const h = await boot({ clock: () => Date.UTC(2026, 4, 6, 7, 8, 9) });
    await newGameAndWalk(h);
    const at = h.runtime.getState();
    await saveTo(h, 3);

    expect(h.effects.filter((e) => e.kind === "requestSave")).toEqual([{ kind: "requestSave", slot: 3 }]);
    const slots = await h.saves.listSlots();
    expect(slots).toHaveLength(1);
    expect(slots[0]).toMatchObject({ slot: 3, savedAt: "2026-05-06T07:08:09.000Z", compatible: "yes", preview: { mapName: "map_start", partyNames: ["勇者"], level: 1 } });
    const read = await h.saves.read(3);
    expect(read.ok && read.value.state.map.player).toMatchObject({ x: 3, y: 2, direction: "right" });
    expect(read.ok && read.value.state.scene).toEqual({ kind: "map" }); // メニューは保存されない
    expect(h.runtime.getState().scene).toMatchObject({ kind: "menu", screen: "save" }); // 保存しても画面はそのまま
    expect(h.runtime.getState().tick).toBeGreaterThan(at.tick);

    h.advanceFrames(1);
    expect(screenTexts(h)).toContain("セーブしました");
    expect(screenTexts(h).some((t) => t.includes("map_start") && t.includes("Lv1"))).toBe(true); // 一覧に反映
    h.advanceFrames(120);
    expect(screenTexts(h)).not.toContain("セーブしました");
  });

  it("保存に失敗したら失敗のお知らせ。ゲームは続く", async () => {
    const failing: SaveRepository = {
      ...createMemorySaveRepository({ projectId: "x", projectHash: "y" }),
      write: () => Promise.resolve({ ok: false, error: { kind: "quota" } }),
    };
    const h = await boot({ saves: failing });
    await newGameAndWalk(h);
    await saveTo(h, 1);
    h.advanceFrames(1);
    expect(screenTexts(h)).toContain("セーブに失敗しました");
    expect(h.warnings.some((w) => w.includes("quota"))).toBe(true);
    expect(h.runtime.status).toBe("running");
  });

  it("write が例外を投げても失敗のお知らせにとどまる", async () => {
    const throwing: SaveRepository = { ...createMemorySaveRepository({ projectId: "x", projectHash: "y" }), write: () => Promise.reject(new Error("boom")) };
    const h = await boot({ saves: throwing });
    await newGameAndWalk(h);
    await saveTo(h, 1);
    h.advanceFrames(1);
    expect(screenTexts(h)).toContain("セーブに失敗しました");
    expect(h.warnings.some((w) => w.includes("boom"))).toBe(true);
  });
});

describe("ロード", () => {
  /** 1 つ目のセッションで歩いてセーブし、同じセーブ置き場を使う 2 つ目のセッションを返す。 */
  async function saved(): Promise<{ first: RuntimeHarness; second: RuntimeHarness }> {
    const first = await boot();
    await newGameAndWalk(first);
    await saveTo(first, 2);
    const second = await boot({ saves: first.saves });
    return { first, second };
  }

  it("タイトルのコンティニューから読み込むと、保存した位置・状態から再開する", async () => {
    const { first, second } = await saved();
    press(second, "down", "ok"); // コンティニュー
    expect(second.runtime.getState().scene).toMatchObject({ kind: "title", screen: "continue" });
    second.advanceFrames(1);
    expect(screenTexts(second).some((t) => t.includes("map_start"))).toBe(true); // 起動時に一覧を取得済み
    press(second, "down"); // スロット 2
    second.play(...tap("ok"));
    expect(second.runtime.status).toBe("loading");
    await second.runtime.settled();
    expect(second.runtime.status).toBe("running");

    const s = second.runtime.getState();
    expect(s.scene).toEqual({ kind: "map" });
    expect(s.map.player).toEqual(first.runtime.getState().map.player);
    expect(s.rng).toEqual(first.runtime.getState().rng);
    expect(s.playtimeTicks).toBeGreaterThan(0);
    // 再開後に歩ける
    second.play(...expandInputs([{ hold: "down", frames: 16 }]));
    expect(second.runtime.getState().map.player.y).toBe(3);
  });

  it("メニューのロード画面から読み込むと、その後の歩きが巻き戻る", async () => {
    const h = await boot();
    await newGameAndWalk(h);
    await saveTo(h, 1);
    press(h, "cancel", "cancel");
    h.play(...expandInputs([{ hold: "down", frames: 16 }]));
    expect(h.runtime.getState().map.player.y).toBe(3);

    press(h, "menu", "down", "down", "down", "ok", "ok"); // ロード → スロット 1（歩いた後なので確認が出る）
    expect(h.runtime.getState().scene).toMatchObject({ kind: "menu", screen: "load", confirm: { kind: "load", slot: 1, cursor: 1 } });
    press(h, "up", "ok"); // はい
    await h.runtime.settled();
    const s = h.runtime.getState();
    expect(s.scene).toEqual({ kind: "map" });
    expect(s.map.player).toMatchObject({ x: 3, y: 2 });
  });

  it("空のスロットは読み込めず、お知らせだけでタイトルに留まる", async () => {
    const h = await boot();
    press(h, "down", "ok", "ok");
    await h.runtime.settled();
    h.advanceFrames(1);
    expect(h.runtime.status).toBe("running");
    expect(h.runtime.getState().scene).toMatchObject({ kind: "title", screen: "continue" });
    expect(screenTexts(h)).toContain("ロードに失敗しました");
    expect(h.warnings.some((w) => w.includes("notFound"))).toBe(true);
  });

  it("プロジェクトが変わったセーブ（projectHash 不一致）は読み込めない", async () => {
    const { first } = await saved();
    const changed = await boot({ saves: createMemorySaveRepository({ projectId: first.loaded.project.meta.id, projectHash: "different" }) });
    press(changed, "down", "ok", "down", "ok");
    await changed.runtime.settled();
    expect(changed.runtime.getState().scene.kind).toBe("title");
  });

  it("壊れたスナップショット（core が拒否）はお知らせだけ", async () => {
    const h = await boot();
    await newGameAndWalk(h);
    await saveTo(h, 1);
    const read = await h.saves.read(1);
    if (!read.ok) throw new Error("setup");
    const broken: SaveRepository = { ...h.saves, read: () => Promise.resolve({ ok: true, value: { ...read.value, state: { ...read.value.state, tick: -1 } } }) };
    const second = await boot({ saves: broken });
    press(second, "down", "ok", "ok");
    await second.runtime.settled();
    second.advanceFrames(1);
    expect(second.runtime.getState().scene.kind).toBe("title");
    expect(screenTexts(second)).toContain("ロードに失敗しました");
    expect(second.warnings.some((w) => w.includes("invalid"))).toBe(true);
  });

  it("別のマップで保存したセーブは、そのマップを遅延ロードしてから再開する", async () => {
    const first = await boot({ project: "transfer-demo", title: false });
    await throughDoor(first);
    press(first, "menu", "down", "down", "ok", "ok");
    await first.runtime.settled();
    expect((await first.saves.listSlots())[0]?.preview.mapName).toBe(first.runtime.getState().map.name);

    const second = await boot({ project: "transfer-demo", saves: first.saves, deferMaps: ["map_b"] });
    press(second, "down", "ok");
    second.play(...tap("ok"));
    expect(second.runtime.status).toBe("loading");
    await vi.waitFor(() => expect(second.projectSource.requested).toEqual(["map_b"]));
    second.projectSource.release("map_b");
    await second.runtime.settled();
    expect(second.runtime.status).toBe("running");
    expect(second.runtime.getState().map.mapId).toBe("map_b");
    second.advanceFrames(2);
    expect(second.runtime.project().layers.length).toBeGreaterThan(0);
  });

  it("保存されたマップを読み込めなければお知らせだけ（ゲームは止まらない）", async () => {
    const first = await boot({ project: "transfer-demo", title: false });
    await throughDoor(first);
    press(first, "menu", "down", "down", "ok", "ok");
    await first.runtime.settled();

    const second = await boot({ project: "transfer-demo", saves: first.saves, failMaps: ["map_b"] });
    press(second, "down", "ok", "ok");
    await second.runtime.settled();
    second.advanceFrames(1);
    expect(second.runtime.status).toBe("running");
    expect(second.errors).toEqual([]);
    expect(second.runtime.getState().scene.kind).toBe("title");
    expect(screenTexts(second)).toContain("ロードに失敗しました");
  });
});

/** メニューを（開いていれば閉じてから）開き直し、セーブ/ロード画面の `slot`（1 始まり）にカーソルを合わせて決定する。 */
function choose(h: RuntimeHarness, screen: "save" | "load", slot: number): void {
  if (h.runtime.getState().scene.kind === "menu") press(h, "menu");
  press(h, "menu", ...Array<Button>(screen === "save" ? 2 : 3).fill("down"), "ok", ...Array<Button>(slot - 1).fill("down"), "ok");
}
const confirmOf = (h: RuntimeHarness): unknown => {
  const scene = h.runtime.getState().scene;
  return scene.kind === "menu" ? scene.confirm : undefined;
};
const walkDown = (h: RuntimeHarness): void => {
  if (h.runtime.getState().scene.kind === "menu") press(h, "menu");
  h.play(...expandInputs([{ hold: "down", frames: 16 }]));
};
/** 確認ダイアログで「はい」（初期カーソルは「いいえ」）。 */
const yes = (h: RuntimeHarness): void => press(h, "up", "ok");

describe("セーブの上書き確認", () => {
  it("空きスロットには確認なしで保存する", async () => {
    const h = await boot();
    await newGameAndWalk(h);
    choose(h, "save", 3);
    await h.runtime.settled();
    expect(confirmOf(h)).toBeUndefined();
    expect(await h.saves.listSlots()).toHaveLength(1);
  });

  it("ロード/セーブの元になっていないスロットへの保存は確認が挟まる。いいえなら保存しない", async () => {
    const h = await boot();
    await newGameAndWalk(h);
    choose(h, "save", 1);
    await h.runtime.settled();
    choose(h, "save", 2); // 空き
    await h.runtime.settled();
    walkDown(h);
    const before = await h.saves.read(1);

    choose(h, "save", 1); // 直近に保存したのは 2 → 1 は確認
    expect(confirmOf(h)).toEqual({ kind: "save", slot: 1, cursor: 1 });
    h.advanceFrames(1);
    expect(screenTexts(h)).toEqual(expect.arrayContaining(["スロット1 に上書きしますか？", "はい", "いいえ"]));

    press(h, "ok"); // いいえ
    await h.runtime.settled();
    expect(confirmOf(h)).toBeUndefined();
    expect(h.runtime.getState().scene).toMatchObject({ kind: "menu", screen: "save" });
    expect(await h.saves.read(1)).toEqual(before);
  });

  it("はいを選ぶと上書きされ、そのスロットが元になる（次は確認なし）", async () => {
    const h = await boot();
    await newGameAndWalk(h);
    choose(h, "save", 1);
    await h.runtime.settled();
    choose(h, "save", 2);
    await h.runtime.settled();
    walkDown(h);

    choose(h, "save", 1);
    yes(h);
    await h.runtime.settled();
    const read = await h.saves.read(1);
    expect(read.ok && read.value.state.map.player.y).toBe(3);
    expect(confirmOf(h)).toBeUndefined();

    choose(h, "save", 1); // 直近に保存したのは 1 → 確認なし
    expect(confirmOf(h)).toBeUndefined();
  });

  it("保存したばかりの同じスロットには確認なしで上書きできる", async () => {
    const h = await boot();
    await newGameAndWalk(h);
    choose(h, "save", 1);
    await h.runtime.settled();
    walkDown(h);
    choose(h, "save", 1);
    await h.runtime.settled();
    expect(confirmOf(h)).toBeUndefined();
    const read = await h.saves.read(1);
    expect(read.ok && read.value.state.map.player.y).toBe(3);
  });

  it("ロードしたスロットには確認なしで上書きでき、別のスロットには確認が出る", async () => {
    const first = await boot();
    await newGameAndWalk(first);
    choose(first, "save", 1);
    await first.runtime.settled();
    choose(first, "save", 2);
    await first.runtime.settled();

    const second = await boot({ saves: first.saves });
    press(second, "down", "ok", "ok"); // コンティニュー → スロット 1
    await second.runtime.settled();
    walkDown(second);

    choose(second, "save", 2);
    expect(confirmOf(second)).toEqual({ kind: "save", slot: 2, cursor: 1 });
    press(second, "cancel"); // やめる
    choose(second, "save", 1);
    await second.runtime.settled();
    expect(confirmOf(second)).toBeUndefined();
    const read = await second.saves.read(1);
    expect(read.ok && read.value.state.map.player.y).toBe(3);
  });

  it("保存に失敗したら、元のスロットは変わらない", async () => {
    const memory = (await boot()).saves; // このプロジェクト用のセーブ置き場
    let failing = false;
    const saves: SaveRepository = { ...memory, write: (slot, snap) => (failing ? Promise.resolve({ ok: false, error: { kind: "quota" } }) : memory.write(slot, snap)) };
    const h = await boot({ saves });
    await newGameAndWalk(h);
    choose(h, "save", 1);
    await h.runtime.settled();
    choose(h, "save", 2);
    await h.runtime.settled();
    failing = true;
    choose(h, "save", 1);
    yes(h);
    await h.runtime.settled(); // 失敗 → 元は 2 のまま
    choose(h, "save", 1);
    expect(confirmOf(h)).toMatchObject({ kind: "save", slot: 1 });
  });
});

describe("ロードの確認", () => {
  it("セーブした直後（進行が変わっていない）は確認なしでロードできる", async () => {
    const h = await boot();
    await newGameAndWalk(h);
    choose(h, "save", 1);
    await h.runtime.settled();
    choose(h, "load", 1);
    expect(confirmOf(h)).toBeUndefined();
    await h.runtime.settled();
    expect(h.runtime.getState().scene).toEqual({ kind: "map" });
  });

  it("セーブしたあとに進んでいたら確認が出る。いいえならロードしない・はいならロードする", async () => {
    const h = await boot();
    await newGameAndWalk(h);
    choose(h, "save", 1);
    await h.runtime.settled();
    walkDown(h);

    choose(h, "load", 1);
    expect(confirmOf(h)).toEqual({ kind: "load", slot: 1, cursor: 1 });
    h.advanceFrames(1);
    expect(screenTexts(h)).toContain("未セーブの進行は失われます。ロードしますか？");

    press(h, "ok"); // いいえ
    await h.runtime.settled();
    expect(h.runtime.getState().scene).toMatchObject({ kind: "menu", screen: "load" });
    expect(h.runtime.getState().map.player.y).toBe(3);

    press(h, "ok");
    yes(h);
    await h.runtime.settled();
    expect(h.runtime.getState().scene).toEqual({ kind: "map" });
    expect(h.runtime.getState().map.player.y).toBe(2);
  });

  it("一度もセーブ/ロードしていないプレイからのロードは確認が出る", async () => {
    const first = await boot();
    await newGameAndWalk(first);
    choose(first, "save", 1);
    await first.runtime.settled();
    const second = await boot({ saves: first.saves, title: false });
    choose(second, "load", 1);
    expect(confirmOf(second)).toMatchObject({ kind: "load", slot: 1 });
  });

  it("ロードした直後は、確認なしで別のスロットもロードできる（進行が変わるまで）", async () => {
    const first = await boot();
    await newGameAndWalk(first);
    choose(first, "save", 1);
    await first.runtime.settled();
    choose(first, "save", 2);
    await first.runtime.settled();

    const second = await boot({ saves: first.saves });
    press(second, "down", "ok", "ok"); // タイトルからのロードは確認なし
    await second.runtime.settled();
    expect(second.runtime.getState().scene).toEqual({ kind: "map" });
    choose(second, "load", 2);
    expect(confirmOf(second)).toBeUndefined();
    await second.runtime.settled();
    expect(second.runtime.getState().scene).toEqual({ kind: "map" });
  });

  it("空のスロットを選んだときは確認せず、ロードに失敗するだけ（進行は守られる）", async () => {
    const h = await boot();
    await newGameAndWalk(h);
    choose(h, "save", 1);
    await h.runtime.settled();
    walkDown(h);
    choose(h, "load", 2);
    expect(confirmOf(h)).toBeUndefined();
    await h.runtime.settled();
    expect(h.runtime.getState().scene).toMatchObject({ kind: "menu", screen: "load" });
    expect(h.runtime.getState().map.player.y).toBe(3);
  });

  it("タイトルに戻ったら、前のプレイの元のセーブは忘れる", async () => {
    const h = await boot();
    await newGameAndWalk(h);
    choose(h, "save", 1);
    await h.runtime.settled();
    press(h, "cancel", "cancel");

    h.runtime.dispatch({ type: "interpreter", op: "start", origin: { kind: "plugin", name: "test" }, commands: [{ code: "ReturnToTitle", params: {}, indent: 0 }], mode: "normal" });
    h.advanceFrames(2);
    expect(h.runtime.getState().scene.kind).toBe("title");
    press(h, "ok"); // ニューゲーム
    choose(h, "save", 1); // 新しいプレイなので、スロット 1 は元ではない → 確認
    expect(confirmOf(h)).toMatchObject({ kind: "save", slot: 1 });
  });
});
