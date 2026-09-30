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

  it("選択肢の表示は「はい / いいえ」で始まり、ChoiceBranch と EndBranch が付く。選択肢を増減すると分岐も 1 回の Undo で増減する", () => {
    addCommand("選択肢の表示");
    expect(page().commands.map((c) => c.code)).toEqual(["ShowChoices", "ChoiceBranch", "ChoiceBranch", "EndBranch"]);
    expect(page().commands[0]!.params).toMatchObject({ choices: ["はい", "いいえ"] });
    fireEvent.click(screen.getByRole("button", { name: /^＋ 選択肢を追加$/ }));
    expect(page().commands.map((c) => c.code)).toEqual(["ShowChoices", "ChoiceBranch", "ChoiceBranch", "ChoiceBranch", "EndBranch"]);
    expect((page().commands[0]!.params["choices"] as string[]).length).toBe(3);
    act(() => t.session.undo());
    expect(page().commands.map((c) => c.code)).toEqual(["ShowChoices", "ChoiceBranch", "ChoiceBranch", "EndBranch"]);
    expect(page().commands.map((c) => c.params).at(0)).toMatchObject({ choices: ["はい", "いいえ"] });
  });

  it("ループは EndLoop と一緒に入り、ループごと消える。MoveStep は選べない", () => {
    addCommand("ループ");
    expect(page().commands.map((c) => c.code)).toEqual(["Loop", "EndLoop"]);
    addCommand("ループの中断");
    expect(page().commands.map((c) => [c.code, c.indent])).toEqual([["Loop", 0], ["BreakLoop", 1], ["EndLoop", 0]]);
    fireEvent.click(screen.getByRole("button", { name: "コマンドを追加…" }));
    expect(within(screen.getByRole("dialog", { name: "コマンドの追加" })).queryByRole("button", { name: "移動ルートの 1 歩" })).toBeNull();
    fireEvent.click(within(screen.getByRole("dialog", { name: "コマンドの追加" })).getByRole("button", { name: "コマンドの追加を閉じる" }));
    fireEvent.click(screen.getByRole("option", { name: /^ループ$/ }));
    fireEvent.click(screen.getByRole("button", { name: "削除" }));
    expect(page().commands).toEqual([]);
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
    fireEvent.click(screen.getByLabelText("すり抜け"));
    expect(page().through).toBe(true);
    fireEvent.change(screen.getByLabelText("プライオリティ"), { target: { value: "above" } });
    expect(page().priority).toBe("above");

    act(() => void t.session.execute(cmd.setSwitchName("sw_a" as never, "スイッチA")));
    fireEvent.click(screen.getByText("＋ 出現条件を追加"));
    expect(page().conditions).toEqual([{ kind: "switch", id: "sw_a", value: true }]);
    fireEvent.change(screen.getByLabelText("出現条件 1の種類"), { target: { value: "2" } });
    expect(page().conditions[0]).toMatchObject({ kind: "selfSwitch", key: "A", value: true });
    fireEvent.click(screen.getByLabelText("出現条件 1 を削除"));
    expect(page().conditions).toEqual([]);
    // 設定はコマンドを壊さない
    expect(page().commands).toEqual([]);
  });

  it("自律移動：入れると初期ルートが付き、手順を編集でき、外すと moveRoute が消える。Undo で戻せる", () => {
    expect(page().moveRoute).toBeUndefined();
    const box = screen.getByRole("checkbox", { name: /自律移動する/ });
    fireEvent.click(box);
    expect(page().moveRoute).toEqual({ repeat: true, skippable: true, steps: [{ kind: "move", dir: "random" }, { kind: "wait", frames: 60 }] });
    fireEvent.click(screen.getByLabelText("繰り返す"));
    expect(page().moveRoute?.repeat).toBe(false);
    // ページの他の設定を変えても、ルートは残る
    fireEvent.change(screen.getByLabelText("起動条件"), { target: { value: "touch" } });
    expect(page()).toMatchObject({ trigger: "touch", moveRoute: { repeat: false } });
    fireEvent.click(screen.getByRole("checkbox", { name: /自律移動する/ }));
    expect(page().moveRoute).toBeUndefined();
    expect(page().trigger).toBe("touch");
    // 続けて編集した分は 1 回の Undo にまとまる（setEventPage の coalesce）
    act(() => void t.session.undo());
    expect(page().moveRoute).toBeUndefined();
    expect(page().trigger).toBe("action");
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

  it("分岐の行は、中身の分かる見出しで出る（選択肢の文言・戦闘の結果）", () => {
    addCommand("選択肢の表示");
    const rows = (): (string | null)[] => within(screen.getByRole("listbox", { name: "イベントコマンド" })).getAllByRole("option").map((o) => o.textContent);
    expect(rows()).toEqual(["選択肢：はい / いいえ", "[はい] のとき", "[いいえ] のとき", "分岐終了"]);
    fireEvent.change(screen.getByRole("textbox", { name: "選択肢 1" }), { target: { value: "泊まる" } });
    expect(screen.getByRole("option", { name: "[泊まる] のとき" })).toBeTruthy();
    fireEvent.click(screen.getByRole("option", { name: "分岐終了" }));
    act(() => void t.session.execute(cmd.insertCommands(M1, EV, 0, 4, [{ code: "BattleProcessing", params: { troop: "tr_x" }, indent: 0 }, ...[0, 1, 2].map((index) => ({ code: "ChoiceBranch", params: { index }, indent: 0 })), { code: "EndBranch", params: {}, indent: 0 }])));
    expect(rows().slice(5, 8)).toEqual(["勝ったとき", "逃げたとき", "負けたとき"]);
  });

  it("追加したコマンドは有効な初期値で入り、設定の最初の欄にフォーカスが移る", () => {
    addCommand("文章の表示");
    expect(document.activeElement).toBe(screen.getByLabelText("本文"));
    addCommand("条件分岐");
    expect(page().commands[1]).toMatchObject({ code: "ConditionalBranch", params: { condition: { kind: "switch", id: "", value: true } } });
    expect(document.activeElement).toBe(screen.getByLabelText("条件の種類"));
    addCommand("選択肢の表示");
    const first = screen.getByRole("textbox", { name: "選択肢 1" }) as HTMLInputElement;
    expect(document.activeElement).toBe(first);
    expect([first.selectionStart, first.selectionEnd]).toEqual([0, 2]); // 「はい」を選択して、すぐ打ち替えられる
  });

  it("コマンドの追加：文字で絞り込み、Enter で先頭を追加する。追加したものは「最近使ったもの」に出る", () => {
    fireEvent.click(screen.getByRole("button", { name: "コマンドを追加…" }));
    const picker = screen.getByRole("dialog", { name: "コマンドの追加" });
    const search = within(picker).getByLabelText("コマンドを絞り込む");
    expect(document.activeElement).toBe(search);
    expect(within(picker).queryByRole("region", { name: "最近使ったもの" })).toBeNull();
    fireEvent.change(search, { target: { value: "ウェイ" } });
    expect(within(picker).getAllByRole("button").map((b) => b.textContent)).toEqual(["×", "ウェイト"]);
    fireEvent.keyDown(search, { key: "Enter", keyCode: 229, isComposing: true }); // 変換の確定では追加しない
    expect(page().commands).toEqual([]);
    fireEvent.keyDown(search, { key: "Enter" });
    expect(page().commands.map((c) => c.code)).toEqual(["Wait"]);
    expect(screen.queryByRole("dialog", { name: "コマンドの追加" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "コマンドを追加…" }));
    const again = screen.getByRole("dialog", { name: "コマンドの追加" });
    fireEvent.change(within(again).getByLabelText("コマンドを絞り込む"), { target: { value: "存在しない" } });
    expect(within(again).getByText("「存在しない」に当てはまるコマンドはありません。")).toBeTruthy();
    fireEvent.change(within(again).getByLabelText("コマンドを絞り込む"), { target: { value: "" } });
    fireEvent.click(within(within(again).getByRole("region", { name: "最近使ったもの" })).getByRole("button", { name: "最近使った ウェイト" }));
    expect(page().commands.map((c) => c.code)).toEqual(["Wait", "Wait"]);
    expect(t.session.ui.recentCommands).toEqual(["Wait"]);
  });

  it("文章をすぐ追加：Enter で「文章の表示」が入り、続けると後ろに並ぶ。Shift+Enter・変換中の Enter では入らない。空行で分かれる", () => {
    const quick = screen.getByLabelText("文章をすぐ追加");
    fireEvent.change(quick, { target: { value: "こんにちは" } });
    fireEvent.keyDown(quick, { key: "Enter", shiftKey: true });
    fireEvent.keyDown(quick, { key: "Enter", isComposing: true });
    expect(page().commands).toEqual([]);
    fireEvent.keyDown(quick, { key: "Enter" });
    expect(page().commands).toEqual([{ code: "ShowText", params: { text: "こんにちは", position: "bottom", background: "window" }, indent: 0 }]);
    expect((quick as HTMLTextAreaElement).value).toBe("");
    fireEvent.change(quick, { target: { value: "2つ目\n2行目\n\n3つ目" } });
    fireEvent.click(screen.getByRole("button", { name: "文章を追加" }));
    expect(page().commands.map((c) => c.params["text"])).toEqual(["こんにちは", "2つ目\n2行目", "3つ目"]);
    expect(screen.getByRole("option", { name: "文章：3つ目" }).getAttribute("aria-selected")).toBe("true");
    // 入力欄の中の Delete などは、行の操作にならない
    fireEvent.keyDown(quick, { key: "Delete" });
    expect(page().commands).toHaveLength(3);
    // 1 回の追加は 1 回の Undo
    act(() => t.session.undo());
    expect(page().commands).toHaveLength(1);
  });

  it("文章をすぐ追加：分岐の開始行を選んでいれば、分岐の中に入る", () => {
    addCommand("条件分岐");
    fireEvent.click(screen.getByRole("button", { name: "編集を閉じる" }));
    fireEvent.change(screen.getByLabelText("文章をすぐ追加"), { target: { value: "中" } });
    fireEvent.keyDown(screen.getByLabelText("文章をすぐ追加"), { key: "Enter" });
    expect(page().commands.map((c) => [c.code, c.indent])).toEqual([["ConditionalBranch", 0], ["ShowText", 1], ["Else", 0], ["EndBranch", 0]]);
  });

  it("スイッチをその場で作って選べる。作成と選択は 1 回の Undo で戻る", () => {
    addCommand("スイッチの操作");
    expect(page().commands[0]!.params).toEqual({ ids: [""], value: true });
    fireEvent.change(screen.getByRole("combobox", { name: "対象 1" }), { target: { value: ":new" } });
    fireEvent.change(screen.getByLabelText("新しいスイッチの名前"), { target: { value: "扉を開けた" } });
    fireEvent.click(screen.getByRole("button", { name: "作成" }));
    expect(t.session.doc.project.switches).toEqual({ sw_001: { name: "扉を開けた" } });
    expect(page().commands[0]!.params).toEqual({ ids: ["sw_001"], value: true });
    expect(screen.getByRole("option", { name: "スイッチ 扉を開けた = ON" })).toBeTruthy();
    act(() => t.session.undo());
    expect(t.session.doc.project.switches).toEqual({});
    expect(page().commands[0]!.params).toEqual({ ids: [""], value: true });
    act(() => t.session.redo());
    expect(t.session.doc.project.switches).toEqual({ sw_001: { name: "扉を開けた" } });
    expect(page().commands[0]!.params).toEqual({ ids: ["sw_001"], value: true });
  });

  it("入力の問題は、フォームと同じ呼び名の場所と「未設定です」で出る", () => {
    fireEvent.click(screen.getByText("＋ 出現条件を追加"));
    expect(screen.getByRole("alert", { name: "入力の問題" }).textContent).toBe("出現条件 1 ID：未設定です");
    addCommand("ウェイト");
    fireEvent.change(screen.getByLabelText("フレーム数"), { target: { value: "-1" } });
    expect(within(screen.getByLabelText("コマンドの設定")).getByRole("alert", { name: "入力の問題" }).textContent).toMatch(/^フレーム数：/);
  });

  it("出現条件の変数もその場で作れる（空いている連番）", () => {
    act(() => void t.session.execute(cmd.setVariableName("var_001" as never, "既存")));
    fireEvent.click(screen.getByText("＋ 出現条件を追加"));
    fireEvent.change(screen.getByLabelText("出現条件 1の種類"), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText("出現条件 1 ID"), { target: { value: ":new" } });
    fireEvent.change(screen.getByLabelText("新しい変数の名前"), { target: { value: "所持数" } });
    fireEvent.submit(screen.getByLabelText("新しい変数の名前").closest("form")!);
    expect(t.session.doc.project.variables).toMatchObject({ var_002: { name: "所持数" } });
    expect(page().conditions[0]).toMatchObject({ kind: "variable", id: "var_002" });
  });

  it("実行に失敗すると、メッセージを出す", () => {
    fireEvent.change(screen.getByLabelText("起動条件"), { target: { value: "touch" } });
    act(() => void t.session.execute(cmd.deleteEvent(M1, EV)));
  });
});
