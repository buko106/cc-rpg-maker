// @vitest-environment jsdom
import { cmd } from "@rpg/editor-core";
import type { EventId, MapId } from "@rpg/schema";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestEnv } from "../test-env.js";
import type { TestEnv } from "../test-env.js";
import { flattenMaps, MapTree } from "./MapTree.js";
import { Shell } from "./Shell.js";
import { TilePalette } from "./TilePalette.js";
import { ToolBar } from "./ToolBar.js";

const M1 = "map_001" as MapId;
let t: TestEnv;
beforeEach(async () => {
  vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 640, height: 480, right: 640, bottom: 480, x: 0, y: 0, toJSON: () => ({}) });
  t = await createTestEnv();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const doAct = (f: () => unknown): void => void act(() => void f());

describe("flattenMaps", () => {
  it("親子を辿り、order → 名前で並べる。親が無い・循環しているものはルートに出す", () => {
    const m = (id: string, order: number, parent?: string) => ({ id: id as MapId, name: id, order, ...(parent === undefined ? {} : { parent: parent as MapId }) });
    const rows = flattenMaps({ b: m("b", 2), a: m("a", 1), a1: m("a1", 0, "a"), orphan: m("orphan", 3, "gone"), x: m("x", 4, "y"), y: m("y", 5, "x") });
    expect(rows.map((r) => `${"-".repeat(r.depth)}${r.meta.id}`)).toEqual(["a", "-a1", "b", "orphan"]);
  });
});

describe("MapTree", () => {
  it("マップを追加すると選択され、選択を切り替えられる。名前が空なら既定名", () => {
    render(t.wrap(<MapTree />));
    fireEvent.click(screen.getByRole("button", { name: "＋ 追加" }));
    expect(Object.values(t.session.doc.project.maps).map((m) => m.name)).toEqual(["MAP001", "新しいマップ"]);
    const created = t.session.ui.currentMap!;
    expect(created).not.toBe(M1);
    fireEvent.click(screen.getByRole("button", { name: "MAP001" }));
    expect(t.session.ui.currentMap).toBe(M1);
    fireEvent.change(screen.getByLabelText("新しいマップの名前"), { target: { value: "洞窟" } });
    fireEvent.click(screen.getByRole("button", { name: "＋ 追加" }));
    expect(Object.values(t.session.doc.project.maps).map((m) => m.name)).toContain("洞窟");
  });

  it("開始マップの削除は確認され、強制すると消える。追加したマップは確認なしで消える", () => {
    render(t.wrap(<MapTree />));
    fireEvent.click(screen.getByRole("button", { name: "マップを削除" }));
    expect(screen.getByRole("dialog", { name: "削除の確認" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));
    expect(Object.keys(t.session.doc.project.maps)).toEqual([M1]);

    fireEvent.click(screen.getByRole("button", { name: "＋ 追加" }));
    fireEvent.click(screen.getByRole("button", { name: "マップを削除" }));
    expect(Object.keys(t.session.doc.project.maps)).toEqual([M1]);
  });

  it("マップ設定：名前・タイルセット・BGM・サイズ変更", () => {
    doAct(() => t.session.execute(cmd.registerAsset("aaaaaaaaaaaaaaaa" as never, { name: "bgm.ogg", kind: "audio", mime: "audio/ogg", size: 1 })));
    render(t.wrap(<MapTree />));
    fireEvent.click(screen.getByRole("button", { name: "マップ設定…" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("名前"), { target: { value: "村" } });
    expect(t.session.doc.project.maps[M1]!.name).toBe("村");
    fireEvent.change(within(dialog).getByLabelText("BGM"), { target: { value: "aaaaaaaaaaaaaaaa" } });
    expect(t.session.doc.maps[M1]!.bgm).toMatchObject({ asset: "aaaaaaaaaaaaaaaa", loop: true });
    fireEvent.change(within(dialog).getByLabelText("BGM"), { target: { value: "" } });
    expect(t.session.doc.maps[M1]!.bgm).toBeUndefined();
    fireEvent.change(within(dialog).getByLabelText("タイルセット"), { target: { value: "ts_default" } });

    fireEvent.change(within(dialog).getByLabelText("幅"), { target: { value: "12" } });
    fireEvent.change(within(dialog).getByLabelText("高さ"), { target: { value: "9" } });
    fireEvent.change(within(dialog).getByLabelText("固定する位置"), { target: { value: "se" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "サイズを変更" }));
    expect(t.session.doc.maps[M1]).toMatchObject({ width: 12, height: 9 });
    fireEvent.change(within(dialog).getByLabelText("幅"), { target: { value: "0" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "サイズを変更" }));
    expect(within(dialog).getByRole("alert")).toBeTruthy();
  });
});

describe("TilePalette / ToolBar", () => {
  it("タイルを選ぶと ui.tile が変わり、消しゴムからは鉛筆に戻る", () => {
    render(t.wrap(<TilePalette />));
    expect(screen.getAllByRole("button", { name: /^タイル / })).toHaveLength(6); // 0 は空
    doAct(() => t.session.setUi({ tool: "eraser" }));
    fireEvent.click(screen.getByRole("button", { name: "タイル 4" }));
    expect(t.session.ui).toMatchObject({ tile: 4, tool: "pencil" });
    expect(screen.getByRole("button", { name: "タイル 4" }).getAttribute("aria-pressed")).toBe("true");
    doAct(() => t.session.setUi({ tool: "fill" }));
    fireEvent.click(screen.getByRole("button", { name: "タイル 2" }));
    expect(t.session.ui.tool).toBe("fill");
  });

  it("選んだタイルの通行方向を切り替えると、タイルセットの passage が更新される（足りない分は全方向通行可）", () => {
    render(t.wrap(<TilePalette />));
    fireEvent.click(screen.getByRole("button", { name: "タイル 2" }));
    const boxes = (): HTMLInputElement[] => screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes().map((b) => b.checked)).toEqual([false, false, false, false]); // 石壁（0）
    fireEvent.click(screen.getByLabelText("下から入れる"));
    expect(t.session.doc.project.tilesets["ts_default" as never]!.passage[2]).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "タイル 1" }));
    fireEvent.click(screen.getByLabelText("上から入れる"));
    expect(t.session.doc.project.tilesets["ts_default" as never]!.passage[1]).toBe(7);
    // 範囲外のタイルは 15 から始まる
    doAct(() => t.session.setUi({ tile: 9 }));
    fireEvent.click(screen.getByLabelText("左から入れる"));
    const passage = t.session.doc.project.tilesets["ts_default" as never]!.passage;
    expect(passage).toHaveLength(10);
    expect(passage[9]).toBe(13);
    expect(passage[8]).toBe(15);
  });

  it("タイルセットに画像が無ければ案内を出す", () => {
    doAct(() => t.session.execute(cmd.upsertTileset({ id: "ts_default", name: "基本", passage: [] } as never)));
    render(t.wrap(<TilePalette />));
    expect(screen.getByText(/画像がありません/)).toBeTruthy();
  });

  it("ツール・レイヤ・拡大率・グリッドを切り替える", () => {
    let grid = true;
    render(t.wrap(<ToolBar grid={grid} onGrid={(g) => (grid = g)} />));
    for (const [name, tool] of [["消しゴム", "eraser"], ["塗りつぶし", "fill"], ["イベント", "event"], ["選択", "select"], ["鉛筆", "pencil"]] as const) {
      fireEvent.click(screen.getByRole("radio", { name }));
      expect(t.session.ui.tool).toBe(tool);
    }
    fireEvent.click(screen.getByRole("radio", { name: "上層" }));
    expect(t.session.ui.currentLayer).toBe(1);
    fireEvent.click(screen.getByRole("radio", { name: "×2" }));
    expect(t.session.ui.zoom).toBe(2);
    fireEvent.click(screen.getByRole("checkbox", { name: "グリッド" }));
    expect(grid).toBe(false);
  });
});

describe("Shell", () => {
  it("Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y / Ctrl+S が session に届く。Ctrl の無いキーは無視", async () => {
    render(t.wrap(<Shell onExit={() => {}} />));
    doAct(() => t.session.execute(cmd.paintTiles(M1, 0, [{ x: 0, y: 0, tile: 4 }])));
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    expect(t.session.canUndo).toBe(false);
    fireEvent.keyDown(window, { key: "z", ctrlKey: true, shiftKey: true });
    expect(Array.from(t.session.doc.maps[M1]!.layers[0]!.tiles)[0]).toBe(4);
    fireEvent.keyDown(window, { key: "z", metaKey: true });
    fireEvent.keyDown(window, { key: "y", ctrlKey: true });
    expect(Array.from(t.session.doc.maps[M1]!.layers[0]!.tiles)[0]).toBe(4);
    fireEvent.keyDown(window, { key: "z" });
    expect(t.session.canUndo).toBe(true);
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    await waitFor(() => expect(t.session.dirty).toBe(false));
    fireEvent.keyDown(window, { key: "q", ctrlKey: true });
  });

  it("未保存で閉じようとすると確認される（beforeunload）", () => {
    render(t.wrap(<Shell onExit={() => {}} />));
    const clean = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);
    doAct(() => t.session.execute(cmd.paintTiles(M1, 0, [{ x: 0, y: 0, tile: 4 }])));
    const dirty = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);
  });

  it("メニューから各ダイアログが開く。保存状態が出る。元に戻す／やり直すの有効・無効", () => {
    render(t.wrap(<Shell onExit={() => {}} />));
    expect(screen.getByRole("status").textContent).toBe("保存済み");
    expect((screen.getByRole("button", { name: "元に戻す" }) as HTMLButtonElement).disabled).toBe(true);
    doAct(() => t.session.execute(cmd.paintTiles(M1, 0, [{ x: 0, y: 0, tile: 4 }])));
    expect(screen.getByRole("status").textContent).toBe("未保存の変更あり");
    expect(screen.getByRole("button", { name: "元に戻す" }).getAttribute("title")).toContain("タイルを描く");
    fireEvent.click(screen.getByRole("button", { name: "元に戻す" }));
    fireEvent.click(screen.getByRole("button", { name: "やり直す" }));
    for (const [button, title] of [["データベース", "データベース"], ["システム", "システム"], ["アセット", "アセット"], ["診断", "診断"]] as const) {
      fireEvent.click(screen.getByRole("button", { name: button }));
      expect(screen.getByRole("dialog", { name: title })).toBeTruthy();
      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
      expect(screen.queryByRole("dialog")).toBeNull();
    }
  });

  it("イベントを選ぶと編集ボタンが出て、ダイアログが開く。診断から開くこともできる", () => {
    doAct(() => t.session.execute(cmd.createEvent(M1, 2, 3, "ev_a" as EventId)));
    doAct(() => t.session.setUi({ selection: { kind: "event", eventId: "ev_a" as EventId } }));
    render(t.wrap(<Shell onExit={() => {}} />));
    fireEvent.click(screen.getByRole("button", { name: "イベントを編集…" }));
    expect(screen.getByRole("dialog", { name: "イベント：EV001" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^イベント：.*を閉じる$/ }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("テストプレイ：タイトルから／選択位置から。閉じるとダイアログが消える", async () => {
    doAct(() => t.session.execute(cmd.createEvent(M1, 2, 3, "ev_a" as EventId)));
    doAct(() => t.session.setUi({ selection: { kind: "event", eventId: "ev_a" as EventId } }));
    render(t.wrap(<Shell onExit={() => {}} />));
    fireEvent.click(screen.getByRole("button", { name: /^テストプレイ$/ }));
    await waitFor(() => expect(t.playtests).toHaveLength(1));
    expect(t.playtests[0]!.start).toBeUndefined();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    fireEvent.click(screen.getByRole("button", { name: "選択位置からテストプレイ" }));
    await waitFor(() => expect(t.playtests).toHaveLength(2));
    expect(t.playtests[1]!.start).toEqual({ mapId: M1, x: 2, y: 3 });
    // テストプレイ中は Ctrl+Z をゲームに任せる
    doAct(() => t.session.execute(cmd.paintTiles(M1, 0, [{ x: 0, y: 0, tile: 4 }])));
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    expect(Array.from(t.session.doc.maps[M1]!.layers[0]!.tiles)[0]).toBe(4);
  });

  it("競合したら上書き保存のボタンが出る。一覧へ戻るボタン", async () => {
    let exited = 0;
    render(t.wrap(<Shell onExit={() => exited++} />));
    await t.repo.save(t.session.doc); // 先に保存された
    doAct(() => t.session.execute(cmd.paintTiles(M1, 0, [{ x: 0, y: 0, tile: 4 }])));
    fireEvent.click(screen.getByRole("button", { name: /^保存$/ }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("他の場所で更新されています"));
    fireEvent.click(screen.getByRole("button", { name: "上書き保存" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("保存済み"));
    fireEvent.click(screen.getByRole("button", { name: "← プロジェクト一覧" }));
    expect(exited).toBe(1);
  });

  it("保存に失敗したら失敗と表示する", async () => {
    render(t.wrap(<Shell onExit={() => {}} />));
    vi.spyOn(t.repo, "save").mockResolvedValue({ ok: false, error: { kind: "quota" } });
    doAct(() => t.session.execute(cmd.paintTiles(M1, 0, [{ x: 0, y: 0, tile: 4 }])));
    fireEvent.click(screen.getByRole("button", { name: /^保存$/ }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("保存に失敗しました（quota）"));
  });
});
