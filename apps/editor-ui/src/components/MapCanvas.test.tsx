// @vitest-environment jsdom
import { cmd } from "@rpg/editor-core";
import type { EventId, MapId } from "@rpg/schema";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestEnv } from "../test-env.js";
import type { TestEnv } from "../test-env.js";
import { MapCanvas } from "./MapCanvas.js";

const M1 = "map_001" as MapId;
let t: TestEnv;
let opened: EventId[];

/** 640×480 の画面に、タイル 32px で描かれているものとする。 */
beforeEach(async () => {
  vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 640, height: 480, right: 640, bottom: 480, x: 0, y: 0, toJSON: () => ({}) });
  t = await createTestEnv();
  opened = [];
  render(t.wrap(<MapCanvas grid onOpenEvent={(id) => opened.push(id)} />));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const canvas = (): HTMLElement => screen.getByRole("application");
/** セル (x, y) の中心 */
const at = (x: number, y: number): { clientX: number; clientY: number; button: number; pointerId: number } => ({ clientX: x * 32 + 16, clientY: y * 32 + 16, button: 0, pointerId: 1 });
const tiles = (): number[] => Array.from(t.session.doc.maps[M1]!.layers[0]!.tiles);
const drag = (from: [number, number], to: [number, number]): void => {
  fireEvent.pointerDown(canvas(), at(...from));
  fireEvent.pointerMove(canvas(), at(...to));
  fireEvent.pointerUp(canvas(), at(...to));
};

describe("MapCanvas：ツール", () => {
  it("鉛筆：ドラッグした経路を選んだタイルで塗る（飛ばしたセルも埋める）。1 回の Undo で戻る", () => {
    act(() => void t.session.setUi({ tile: 3 }));
    drag([0, 0], [4, 2]);
    expect(tiles().slice(0, 5)).toEqual([3, 3, 1, 1, 1]);
    expect(tiles()[2 * 20 + 4]).toBe(3);
    act(() => void t.session.undo());
    expect(tiles().every((x) => x === 1)).toBe(true);
    expect(t.session.canUndo).toBe(false);
  });

  it("消しゴム：現在のレイヤのタイルを 0 にする", () => {
    act(() => void t.session.setUi({ tool: "eraser" }));
    fireEvent.pointerDown(canvas(), at(1, 0));
    expect(tiles().slice(0, 3)).toEqual([1, 0, 1]);
  });

  it("塗りつぶし：現在のレイヤの、つながった同じタイルを塗る。レイヤを切り替えれば別のレイヤ", () => {
    act(() => void t.session.setUi({ tool: "fill", tile: 4 }));
    fireEvent.pointerDown(canvas(), at(3, 3));
    expect(tiles().every((x) => x === 4)).toBe(true);
    act(() => void t.session.setUi({ currentLayer: 1, tile: 2 }));
    fireEvent.pointerDown(canvas(), at(0, 0));
    expect(Array.from(t.session.doc.maps[M1]!.layers[1]!.tiles).every((x) => x === 2)).toBe(true);
  });

  it("イベント：空きセルのクリックで作って選択し、既存のイベントのクリックは選ぶだけ。ドラッグで動かす", () => {
    act(() => void t.session.setUi({ tool: "event" }));
    fireEvent.pointerDown(canvas(), at(5, 6));
    fireEvent.pointerUp(canvas(), at(5, 6));
    const events = Object.values(t.session.doc.maps[M1]!.events);
    expect(events).toHaveLength(1);
    const id = events[0]!.id;
    expect(t.session.ui.selection).toEqual({ kind: "event", eventId: id });

    fireEvent.pointerDown(canvas(), at(5, 6)); // もう作らない
    expect(Object.keys(t.session.doc.maps[M1]!.events)).toHaveLength(1);
    fireEvent.pointerMove(canvas(), at(7, 6));
    fireEvent.pointerMove(canvas(), at(7, 4));
    fireEvent.pointerUp(canvas(), at(7, 4));
    expect(t.session.doc.maps[M1]!.events[id]).toMatchObject({ x: 7, y: 4 });
    t.session.undo(); // ドラッグは 1 回の Undo
    expect(t.session.doc.maps[M1]!.events[id]).toMatchObject({ x: 5, y: 6 });
  });

  it("選択ツール：空きセルでは選択を外し、イベントは作らない", () => {
    act(() => void t.session.execute(cmd.createEvent(M1, 2, 2, "ev_a" as EventId)));
    act(() => void t.session.setUi({ tool: "select" }));
    fireEvent.pointerDown(canvas(), at(2, 2));
    expect(t.session.ui.selection).toEqual({ kind: "event", eventId: "ev_a" });
    fireEvent.pointerUp(canvas(), at(2, 2));
    fireEvent.pointerDown(canvas(), at(9, 9));
    expect(t.session.ui.selection).toEqual({ kind: "none" });
    expect(Object.keys(t.session.doc.maps[M1]!.events)).toEqual(["ev_a"]);
  });

  it("ダブルクリックでイベントを開く（イベントの無いセルでは何もしない）", () => {
    act(() => void t.session.execute(cmd.createEvent(M1, 2, 2, "ev_a" as EventId)));
    fireEvent.doubleClick(canvas(), at(2, 2));
    fireEvent.doubleClick(canvas(), at(8, 8));
    expect(opened).toEqual(["ev_a"]);
  });

  it("左ボタン以外・キャンバスの外は無視する", () => {
    fireEvent.pointerDown(canvas(), { ...at(1, 1), button: 2 });
    fireEvent.pointerDown(canvas(), { clientX: 9999, clientY: 9999, button: 0, pointerId: 1 });
    expect(t.session.canUndo).toBe(false);
  });

  it("ホバー中のセルの座標を表示する。外に出ると消える", () => {
    fireEvent.pointerMove(canvas(), at(3, 4));
    expect(screen.getByText("(3, 4)")).toBeTruthy();
    fireEvent.pointerLeave(canvas());
    expect(screen.queryByText("(3, 4)")).toBeNull();
  });
});

describe("MapCanvas：キーボード", () => {
  it("矢印でセルを移動し、Enter でツールを適用、O でイベントを開き、Delete で選択中のイベントを削除する", () => {
    act(() => void t.session.setUi({ tile: 5 }));
    const c = canvas();
    fireEvent.keyDown(c, { key: "ArrowRight" });
    fireEvent.keyDown(c, { key: "ArrowRight" });
    fireEvent.keyDown(c, { key: "ArrowDown" });
    fireEvent.keyDown(c, { key: "Enter" });
    expect(tiles()[1 * 20 + 2]).toBe(5);
    expect(screen.getByText("(2, 1)")).toBeTruthy();
    fireEvent.keyDown(c, { key: "ArrowLeft", shiftKey: false });
    fireEvent.keyDown(c, { key: "ArrowUp" });
    fireEvent.keyDown(c, { key: " " });
    expect(tiles()[0 * 20 + 1]).toBe(5);

    act(() => void t.session.setUi({ tool: "event" }));
    fireEvent.keyDown(c, { key: "Enter" }); // (1,0) にイベントを作る
    const [ev] = Object.values(t.session.doc.maps[M1]!.events);
    expect(ev).toMatchObject({ x: 1, y: 0 });
    fireEvent.keyDown(c, { key: "o" });
    expect(opened).toEqual([ev!.id]);
    fireEvent.keyDown(c, { key: "Delete" });
    expect(t.session.doc.maps[M1]!.events).toEqual({});
    fireEvent.keyDown(c, { key: "x" }); // 他のキーは無視
  });

  it("端でとどまる", () => {
    const c = canvas();
    for (let i = 0; i < 3; i++) fireEvent.keyDown(c, { key: "ArrowLeft" });
    fireEvent.keyDown(c, { key: "ArrowUp" });
    expect(screen.getByText("(0, 0)")).toBeTruthy();
    for (let i = 0; i < 30; i++) fireEvent.keyDown(c, { key: "ArrowRight" });
    expect(screen.getByText("(19, 0)")).toBeTruthy();
  });
});

describe("MapCanvas：表示", () => {
  it("マップが選ばれていなければ案内を出す", async () => {
    cleanup();
    const empty = await createTestEnv();
    empty.session.setUi({ currentMap: undefined });
    render(empty.wrap(<MapCanvas grid={false} onOpenEvent={() => {}} />));
    expect(screen.getByText(/マップがありません/)).toBeTruthy();
    expect(screen.queryByRole("application")).toBeNull();
  });

  it("失敗した操作はメッセージで知らせる", () => {
    act(() => void t.session.setUi({ tool: "event" }));
    act(() => void t.session.execute(cmd.createEvent(M1, 4, 4, "ev_x" as EventId)));
    vi.spyOn(t.session, "execute").mockReturnValue({ ok: false, error: { kind: "invalid", message: "だめです" } });
    fireEvent.pointerDown(canvas(), at(9, 9));
    expect(screen.getByRole("alert").textContent).toBe("だめです");
  });
});
