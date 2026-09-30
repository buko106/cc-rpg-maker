// @vitest-environment jsdom
import { cmd } from "@rpg/editor-core";
import type { EventCommand, EventId, MapId } from "@rpg/schema";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestEnv } from "../test-env.js";
import type { TestEnv } from "../test-env.js";
import { EventDialog } from "./EventDialog.js";

const M1 = "map_001" as MapId;
const EV = "ev_a" as EventId;
let t: TestEnv;

const text = (s: string, indent = 0): EventCommand => ({ code: "ShowText", params: { text: s, position: "bottom", background: "window" }, indent });
const code = (c: string, indent = 0, params: Record<string, unknown> = {}): EventCommand => ({ code: c, params, indent });
/** a / b / 条件分岐（c / それ以外で d）/ e */
const seed = (): EventCommand[] => [text("a"), text("b"), code("ConditionalBranch", 0, { condition: "true" }), text("c", 1), code("Else"), text("d", 1), code("EndBranch"), text("e")];

beforeEach(async () => {
  t = await createTestEnv();
  act(() => void t.session.execute(cmd.createEvent(M1, 3, 4, EV)));
  act(() => void t.session.execute(cmd.insertCommands(M1, EV, 0, 0, seed())));
  render(t.wrap(<EventDialog mapId={M1} eventId={EV} onClose={() => {}} />));
});
afterEach(cleanup);

const commands = (page = 0) => t.session.doc.maps[M1]!.events[EV]!.pages[page]!.commands;
/** 並びを 字下げ + 内容 で読む（ShowText は本文） */
const order = (page = 0): string[] => commands(page).map((c) => `${" ".repeat(c.indent)}${c.code === "ShowText" ? String(c.params["text"]) : c.code}`);
const list = (): HTMLElement => screen.getByRole("listbox", { name: "イベントコマンド" });
const row = (label: string | RegExp): HTMLElement => screen.getByRole("option", { name: label });
const pick = (label: string | RegExp, shiftKey = false): void => void fireEvent.click(row(label), { shiftKey });
const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;
const chosen = (): string[] => screen.getAllByRole("option").filter((o) => o.getAttribute("aria-selected") === "true").map((o) => o.textContent ?? "");
const key = (k: string, init: Record<string, unknown> = {}): void => void fireEvent.keyDown(list(), { key: k, ...init });
const SEED = ["a", "b", "ConditionalBranch", " c", "Else", " d", "EndBranch", "e"];
const A = "文章：a";
const B = "文章：b";
const E = "文章：e";

describe("並べ替え", () => {
  it("「上へ」「下へ」で 1 つ前・後と入れ替わり、選択も一緒に動く。1 回の Undo で戻る", () => {
    pick(B);
    fireEvent.click(button("コマンドを上へ"));
    expect(order().slice(0, 2)).toEqual(["b", "a"]);
    expect(chosen()).toEqual([B]);
    expect(row(B).id).toBe("cmd-row-0");
    expect(t.session.undoLabel).toBe("コマンドの移動");
    fireEvent.click(button("コマンドを下へ"));
    expect(order().slice(0, 2)).toEqual(["a", "b"]);
    act(() => t.session.undo());
    expect(order().slice(0, 2)).toEqual(["b", "a"]);
    act(() => t.session.undo());
    expect(order()).toEqual(SEED);
  });

  it("分岐の開始を選んでいれば、ブロックごと動く（選択も追従する）", () => {
    pick(/条件分岐/);
    fireEvent.click(button("コマンドを下へ"));
    expect(order()).toEqual(["a", "b", "e", "ConditionalBranch", " c", "Else", " d", "EndBranch"]);
    expect(row(/条件分岐/).id).toBe("cmd-row-3");
    fireEvent.click(button("コマンドを上へ"));
    expect(order()).toEqual(SEED);
    expect(row(/条件分岐/).id).toBe("cmd-row-2");
  });

  it("分岐の直後の行は、ブロック全体を飛び越えて上へ動く", () => {
    pick(E);
    fireEvent.click(button("コマンドを上へ"));
    expect(order()).toEqual(["a", "b", "e", "ConditionalBranch", " c", "Else", " d", "EndBranch"]);
    expect(row(E).id).toBe("cmd-row-2");
  });

  it("端・区切り・終端は越えない。区切りや終端の行だけを選んでいるときは動かせない", () => {
    pick(A);
    expect(button("コマンドを上へ").disabled).toBe(true);
    expect(button("コマンドを下へ").disabled).toBe(false);
    pick(E);
    expect(button("コマンドを下へ").disabled).toBe(true);
    pick("文章：c"); // 分岐の本体の先頭・末尾
    expect(button("コマンドを上へ").disabled).toBe(true);
    expect(button("コマンドを下へ").disabled).toBe(true);
    pick("それ以外のとき");
    expect(button("コマンドを上へ").disabled).toBe(true);
    expect(button("コマンドを下へ").disabled).toBe(true);
    pick("分岐終了");
    expect(button("コマンドを下へ").disabled).toBe(true);
    key("ArrowUp", { altKey: true }); // キーボードでも動かない
    key("ArrowDown", { altKey: true });
    expect(order()).toEqual(SEED);
    expect(t.session.undoLabel).not.toBe("コマンドの移動");
  });

  it("キーボード：Alt+↑ / Alt+↓ で動く。Alt の無い矢印は選択の移動", () => {
    pick(B);
    key("ArrowUp", { altKey: true });
    expect(order().slice(0, 2)).toEqual(["b", "a"]);
    key("ArrowDown", { altKey: true });
    key("ArrowDown", { altKey: true }); // 分岐を飛び越える
    expect(order()).toEqual(["a", "ConditionalBranch", " c", "Else", " d", "EndBranch", "b", "e"]);
    expect(chosen()).toEqual([B]);
    key("ArrowDown");
    expect(chosen()).toEqual([E]);
  });
});

describe("複数選択", () => {
  it("Shift+クリックで範囲を選べる。選んだ範囲は「N 行を選択中」と出て、編集はできず、Delete でまとめて消える（1 回の Undo）", () => {
    pick(A);
    pick(B, true);
    expect(chosen()).toEqual([A, B]);
    expect(screen.getByRole("status").textContent).toBe("2 行を選択中");
    expect(button("編集").disabled).toBe(true);
    key("Enter"); // 範囲選択中の Enter は編集を開かない
    expect(screen.queryByLabelText("コマンドの設定")).toBeNull();
    key("Delete");
    expect(order()).toEqual(["ConditionalBranch", " c", "Else", " d", "EndBranch", "e"]);
    expect(t.session.undoLabel).toBe("コマンドの削除");
    act(() => t.session.undo());
    expect(order()).toEqual(SEED);
  });

  it("範囲が分岐の区切りや終端にかかると、ブロックを切らないよう分岐全体まで広がる", () => {
    pick("文章：c");
    pick("文章：d", true); // Else をまたぐ
    expect(chosen()).toEqual([/条件分岐/, /c/, /それ以外/, /d/, /分岐終了/].map((re) => screen.getAllByRole("option").find((o) => re.test(o.textContent ?? ""))!.textContent));
    fireEvent.click(button("削除"));
    expect(order()).toEqual(["a", "b", "e"]);
  });

  it("Shift+↑ / Shift+↓ で範囲を広げ・縮める。ふつうの矢印や、通常のクリックで範囲は解ける", () => {
    pick(A);
    key("ArrowDown", { shiftKey: true });
    expect(chosen()).toEqual([A, B]);
    key("ArrowDown", { shiftKey: true }); // 分岐の開始に届くと、分岐全体が入る
    expect(chosen()).toHaveLength(7);
    key("ArrowUp", { shiftKey: true });
    expect(chosen()).toEqual([A, B]);
    key("ArrowDown");
    expect(chosen()).toEqual(["条件分岐：true"]); // 開始の行だけ（ブロックの行は薄く示されるだけ）
    pick(A, true); // 起点は今選んでいる行。開始の行にかかるので分岐全体が入る
    expect(chosen()).toHaveLength(7);
    pick(E);
    expect(chosen()).toEqual([E]);
  });

  it("範囲ごと並べ替えられる（ブロックを飛び越えても、範囲の選択は保たれる）", () => {
    pick(A);
    pick(B, true);
    fireEvent.click(button("コマンドを下へ"));
    expect(order()).toEqual(["ConditionalBranch", " c", "Else", " d", "EndBranch", "a", "b", "e"]);
    expect(chosen()).toEqual([A, B]);
    expect(row(A).id).toBe("cmd-row-5");
    expect(t.session.undoLabel).toBe("コマンドの移動");
  });

  it("分岐の開始を選ぶと、ブロックの行が薄く示され、削除はブロックごと", () => {
    pick(/条件分岐/);
    const inBlock = screen.getAllByRole("option").filter((o) => o.classList.contains("in-block"));
    expect(inBlock).toHaveLength(4);
    expect(inBlock.every((o) => o.getAttribute("aria-selected") === "false")).toBe(true);
    expect(screen.queryByRole("status")?.textContent).toBe("5 行を選択中");
    fireEvent.click(button("削除"));
    expect(order()).toEqual(["a", "b", "e"]);
  });
});

describe("コピー・切り取り・貼り付け", () => {
  it("コピーした行を別の行の後ろに貼れる。貼った行が選ばれ、1 回の Undo で消える", () => {
    expect(button("コマンドを貼り付け").disabled).toBe(true);
    pick(A);
    fireEvent.click(button("コマンドをコピー"));
    expect(screen.getByRole("status").textContent).toBe("クリップボード：1 行");
    expect(order()).toEqual(SEED); // コピーでは文書は変わらない
    pick(E);
    fireEvent.click(button("コマンドを貼り付け"));
    expect(order()).toEqual([...SEED, "a"]);
    expect(chosen()).toEqual([A]);
    expect(document.getElementById("cmd-row-8")?.getAttribute("aria-selected")).toBe("true");
    expect(t.session.undoLabel).toBe("コマンドの貼り付け");
    act(() => t.session.undo());
    expect(order()).toEqual(SEED);
  });

  it("分岐をコピーすると、ブロックごと（字下げを保って）コピーされ、貼った行の範囲が選ばれる", () => {
    pick(/条件分岐/);
    fireEvent.click(button("コマンドをコピー"));
    expect(screen.getByRole("status").textContent).toBe("5 行を選択中　クリップボード：5 行");
    pick(E);
    fireEvent.click(button("コマンドを貼り付け"));
    expect(order()).toEqual([...SEED, "ConditionalBranch", " c", "Else", " d", "EndBranch"]);
    expect(chosen()).toHaveLength(5);
    expect(document.getElementById("cmd-row-8")?.getAttribute("aria-selected")).toBe("true");
    expect(document.getElementById("cmd-row-12")?.getAttribute("aria-selected")).toBe("true");
  });

  it("開始の行・区切りの行を選んでいれば、ブロックの中に貼る（字下げが合う）。ブロックの終端の行なら、その後ろ", () => {
    pick(A);
    key("c", { ctrlKey: true });
    pick(/条件分岐/);
    key("v", { ctrlKey: true });
    expect(order()).toEqual(["a", "b", "ConditionalBranch", " a", " c", "Else", " d", "EndBranch", "e"]);
    act(() => t.session.undo());
    pick("それ以外のとき");
    key("v", { metaKey: true });
    expect(order()).toEqual(["a", "b", "ConditionalBranch", " c", "Else", " a", " d", "EndBranch", "e"]);
    act(() => t.session.undo());
    pick("分岐終了");
    key("v", { ctrlKey: true });
    expect(order()).toEqual(["a", "b", "ConditionalBranch", " c", "Else", " d", "EndBranch", "a", "e"]);
  });

  it("範囲を選んでいるときは範囲の後ろに貼る。何も選んでいなければ末尾に貼る", () => {
    pick(A);
    fireEvent.click(button("コマンドをコピー"));
    pick(A);
    pick(B, true);
    fireEvent.click(button("コマンドを貼り付け"));
    expect(order()).toEqual(["a", "b", "a", "ConditionalBranch", " c", "Else", " d", "EndBranch", "e"]);
    act(() => t.session.undo());
    pick(E);
    fireEvent.click(button("削除")); // 選択が無くなる
    fireEvent.click(button("コマンドを貼り付け"));
    expect(order()).toEqual(["a", "b", "ConditionalBranch", " c", "Else", " d", "EndBranch", "a"]);
  });

  it("切り取りは、クリップボードに入れて消す（1 回の Undo で戻る）。貼ると元に戻せる", () => {
    pick(B);
    key("x", { ctrlKey: true });
    expect(order()).toEqual(["a", "ConditionalBranch", " c", "Else", " d", "EndBranch", "e"]);
    expect(t.session.undoLabel).toBe("コマンドの切り取り");
    expect(chosen()).toEqual([]);
    pick(A);
    fireEvent.click(button("コマンドを貼り付け"));
    expect(order()).toEqual(["a", "b", "ConditionalBranch", " c", "Else", " d", "EndBranch", "e"]);
    act(() => t.session.undo());
    act(() => t.session.undo());
    expect(order()).toEqual(SEED);
    pick(/条件分岐/);
    fireEvent.click(button("コマンドを切り取り"));
    expect(order()).toEqual(["a", "b", "e"]);
    expect(screen.getByRole("status").textContent).toBe("クリップボード：5 行");
  });

  it("クリップボードはイベントのページをまたいで貼れる", () => {
    pick(A);
    fireEvent.click(button("コマンドをコピー"));
    fireEvent.click(screen.getByRole("button", { name: "＋ ページ追加" }));
    expect(commands(1)).toEqual([]);
    fireEvent.click(button("コマンドを貼り付け"));
    expect(order(1)).toEqual(["a"]);
  });

  it("区切り・終端の行は、コピー・切り取り・削除はできない（貼り付けはできる）。入力欄の中のキーは行の操作にしない", () => {
    pick(A);
    fireEvent.click(button("コマンドをコピー"));
    pick("それ以外のとき");
    for (const name of ["コマンドをコピー", "コマンドを切り取り", "削除"]) expect(button(name).disabled).toBe(true);
    expect(button("コマンドを貼り付け").disabled).toBe(false);
    key("c", { ctrlKey: true });
    key("x", { ctrlKey: true });
    key("Delete");
    expect(order()).toEqual(SEED);
    // 文章をすぐ追加の欄の Ctrl+V・Delete は、行の操作にならない
    const quick = screen.getByLabelText("文章をすぐ追加");
    fireEvent.keyDown(quick, { key: "v", ctrlKey: true });
    fireEvent.keyDown(quick, { key: "Delete" });
    expect(order()).toEqual(SEED);
  });

  it("Shift や Alt を伴う C / X / V は、コピーなどにならない", () => {
    pick(A);
    key("c", { ctrlKey: true, shiftKey: true });
    key("c", { ctrlKey: true, altKey: true });
    expect(screen.getByRole("status").textContent).toBe("");
    key("Home");
  });
});
