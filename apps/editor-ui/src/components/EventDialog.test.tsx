// @vitest-environment jsdom
import { cmd } from "@rpg/editor-core";
import type { EventId, MapId } from "@rpg/schema";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestEnv } from "../test-env.js";
import type { TestEnv } from "../test-env.js";
import { EventDialog } from "./EventDialog.js";

const M1 = "map_001" as MapId;
const EV = "ev_a" as EventId;
let t: TestEnv;
let closed = 0;

beforeEach(async () => {
  t = await createTestEnv();
  closed = 0;
  act(() => void t.session.execute(cmd.createEvent(M1, 3, 4, EV)));
  render(t.wrap(<EventDialog mapId={M1} eventId={EV} onClose={() => closed++} />));
});
afterEach(cleanup);

const page = (i = 0) => t.session.doc.maps[M1]!.events[EV]!.pages[i]!;
const addCommand = (label: string): void => {
  fireEvent.click(screen.getByRole("button", { name: "コマンドを追加…" }));
  fireEvent.click(within(screen.getByRole("dialog", { name: "コマンドの追加" })).getByRole("button", { name: label }));
};

describe("EventDialog", () => {
  it("名前を変えられる。イベントを削除すると閉じる", () => {
    fireEvent.change(screen.getByDisplayValue("EV001"), { target: { value: "村人" } });
    expect(t.session.doc.maps[M1]!.events[EV]!.name).toBe("村人");
    fireEvent.click(screen.getByRole("button", { name: "イベントを削除" }));
    expect(t.session.doc.maps[M1]!.events).toEqual({});
    expect(closed).toBe(1);
  });

  it("ShowText を追加して本文を編集すると、insertCommands / replaceCommand としてコマンドが増える", () => {
    addCommand("文章の表示");
    expect(page().commands).toEqual([{ code: "ShowText", params: { text: "", position: "bottom", background: "window" }, indent: 0 }]);
    fireEvent.change(screen.getByLabelText("本文"), { target: { value: "こんにちは" } });
    expect(page().commands[0]!.params).toMatchObject({ text: "こんにちは" });
    expect(screen.getByRole("option", { name: /文章：こんにちは/ })).toBeTruthy();
    // 続けて入力しても Undo は 1 段（入力のまとまり）
    fireEvent.change(screen.getByLabelText("本文"), { target: { value: "こんにちは！" } });
    act(() => t.session.undo());
    expect(page().commands[0]!.params).toMatchObject({ text: "" });
  });

  it("分岐のあるコマンドは対になる部品と一緒に入り、分岐ごと消える。部品だけは消せない", () => {
    addCommand("条件分岐");
    expect(page().commands.map((c) => c.code)).toEqual(["ConditionalBranch", "Else", "EndBranch"]);
    // 分岐の開始行が選ばれているので、続けて追加すると分岐の中（字下げ 1）に入る
    addCommand("ウェイト");
    expect(page().commands.map((c) => [c.code, c.indent])).toEqual([["ConditionalBranch", 0], ["Wait", 1], ["Else", 0], ["EndBranch", 0]]);
    fireEvent.click(screen.getByRole("option", { name: /それ以外のとき/ }));
    expect((screen.getByRole("button", { name: "削除" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("option", { name: /条件分岐/ }));
    fireEvent.click(screen.getByRole("button", { name: "削除" }));
    expect(page().commands).toEqual([]);
  });

  it("戦闘の処理は ChoiceBranch 3 つと EndBranch が付く", () => {
    addCommand("戦闘の処理");
    expect(page().commands.map((c) => c.code)).toEqual(["BattleProcessing", "ChoiceBranch", "ChoiceBranch", "ChoiceBranch", "EndBranch"]);
  });

  it("キーボード：矢印で選択、Enter で編集、Delete で削除", () => {
    addCommand("ウェイト");
    addCommand("ウェイト");
    const list = screen.getByRole("listbox", { name: "イベントコマンド" });
    fireEvent.click(screen.getByRole("button", { name: "編集を閉じる" }));
    fireEvent.keyDown(list, { key: "ArrowUp" });
    expect(list.getAttribute("aria-activedescendant")).toBe("cmd-row-0");
    fireEvent.keyDown(list, { key: "ArrowDown" });
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(list.getAttribute("aria-activedescendant")).toBe("cmd-row-1");
    fireEvent.keyDown(list, { key: "Enter" });
    expect(screen.getByLabelText("コマンドの設定")).toBeTruthy();
    fireEvent.keyDown(list, { key: "Delete" });
    expect(page().commands).toHaveLength(1);
    fireEvent.keyDown(list, { key: "Home" }); // 他のキーは何もしない
  });

  it("ページの追加・切り替え・削除（最後の 1 ページは消せない）", () => {
    const remove = screen.getByRole("button", { name: "このページを削除" }) as HTMLButtonElement;
    expect(remove.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "＋ ページ追加" }));
    expect(t.session.doc.maps[M1]!.events[EV]!.pages).toHaveLength(2);
    expect(screen.getByRole("tab", { name: "ページ 2", selected: true })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "ページ 1" }));
    expect(screen.getByRole("tab", { name: "ページ 1", selected: true })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "ページ 2" }));
    fireEvent.click(screen.getByRole("button", { name: "このページを削除" }));
    expect(t.session.doc.maps[M1]!.events[EV]!.pages).toHaveLength(1);
  });

  it("ページの設定（起動条件・すり抜け・優先度・出現条件）を編集すると setEventPage になる", () => {
    fireEvent.change(screen.getByLabelText("起動条件"), { target: { value: "touch" } });
    expect(page().trigger).toBe("touch");
    fireEvent.click(screen.getByLabelText("through"));
    expect(page().through).toBe(true);
    fireEvent.change(screen.getByLabelText("priority"), { target: { value: "above" } });
    expect(page().priority).toBe("above");

    act(() => void t.session.execute(cmd.setSwitchName("sw_a" as never, "スイッチA")));
    fireEvent.click(screen.getByText("＋ conditionsを追加"));
    expect(page().conditions).toEqual([{ kind: "switch", id: "sw_a", value: false }]);
    fireEvent.change(screen.getByLabelText("conditions 1の種類"), { target: { value: "2" } });
    expect(page().conditions[0]).toMatchObject({ kind: "selfSwitch" });
    fireEvent.click(screen.getByLabelText("conditions 1 を削除"));
    expect(page().conditions).toEqual([]);
    // 設定はコマンドを壊さない
    expect(page().commands).toEqual([]);
  });

  it("グラフィックを設定して、外すと page から消える", () => {
    fireEvent.click(screen.getByLabelText("グラフィックを設定"));
    expect(page().graphic).toMatchObject({ index: 0, direction: "up" });
    expect(Object.keys(t.session.doc.project.assets.entries)).toContain(page().graphic!.asset);
    fireEvent.click(screen.getByLabelText("グラフィックを設定"));
    expect(page()).not.toHaveProperty("graphic");
  });

  it("Undo で外から値が変わると、フォームも追随する", () => {
    fireEvent.change(screen.getByLabelText("起動条件"), { target: { value: "autorun" } });
    act(() => t.session.undo());
    expect((screen.getByLabelText("起動条件") as HTMLSelectElement).value).toBe("action");
  });

  it("イベントが消えたら何も出さない", () => {
    act(() => void t.session.execute(cmd.deleteEvent(M1, EV)));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("未知のコマンドは編集できない旨を出す", () => {
    act(() => void t.session.execute(cmd.insertCommands(M1, EV, 0, 0, [{ code: "Mystery", params: {}, indent: 0 }])));
    fireEvent.click(screen.getByRole("option", { name: /Mystery/ }));
    fireEvent.click(screen.getByRole("button", { name: "編集" }));
    expect(screen.getByRole("alert").textContent).toContain("未知のコマンド Mystery");
  });

  it("実行に失敗すると、メッセージを出す", () => {
    fireEvent.change(screen.getByLabelText("起動条件"), { target: { value: "touch" } });
    act(() => void t.session.execute(cmd.deleteEvent(M1, EV)));
  });
});
