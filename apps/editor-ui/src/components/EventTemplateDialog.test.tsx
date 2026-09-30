// @vitest-environment jsdom
import { BUILTIN_EVENT_TEMPLATES, cmd } from "@rpg/editor-core";
import { customCommandPlugin } from "@rpg/plugin-samples";
import type { EventId, MapId } from "@rpg/schema";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestEnv } from "../test-env.js";
import type { TestEnv } from "../test-env.js";
import { MapCanvas } from "./MapCanvas.js";
import { ToolBar } from "./ToolBar.js";

const M1 = "map_001" as MapId;
const HERO = "bb2e23b45d1f4d4d";
let t: TestEnv;
let opened: EventId[];

/** キャンバスはどれも 640×480（20×15 マス、1 マス 32px）に描かれているものとする。 */
async function setup(opts: Parameters<typeof createTestEnv>[0] = {}): Promise<void> {
  vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 640, height: 480, right: 640, bottom: 480, x: 0, y: 0, toJSON: () => ({}) });
  t = await createTestEnv(opts);
  opened = [];
  render(
    t.wrap(
      <>
        <ToolBar grid onGrid={() => {}} />
        <MapCanvas grid onOpenEvent={(id) => opened.push(id)} />
      </>,
    ),
  );
}
beforeEach(() => setup());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** セル (x, y) の中心 */
const at = (x: number, y: number) => ({ clientX: x * 32 + 16, clientY: y * 32 + 16, button: 0, pointerId: 1 });
const mapCanvas = (): HTMLElement => screen.getByRole("application", { name: /の編集キャンバス/ });
const events = () => Object.values(t.session.doc.maps[M1]!.events);
const choose = (label: string): void => {
  const select = screen.getByLabelText("置くイベント") as HTMLSelectElement;
  const option = within(select).getByRole("option", { name: label }) as HTMLOptionElement;
  fireEvent.change(select, { target: { value: option.value } });
};
/** ひな形を選んで、空いたセルをクリックする（入力のダイアログが開く）。 */
const place = (label: string, x = 5, y = 6): HTMLElement => {
  choose(label);
  fireEvent.pointerDown(mapCanvas(), at(x, y));
  fireEvent.pointerUp(mapCanvas(), at(x, y));
  return screen.getByRole("dialog", { name: `ひな形から作成：${label}` });
};
const button = (dialog: HTMLElement, name: string) => within(dialog).getByRole("button", { name }) as HTMLButtonElement;

describe("置くイベント（ToolBar）", () => {
  it("空のイベントと、組み込みのひな形 5 種類が並ぶ。ひな形を選ぶとイベントツールになり、空のイベントに戻せる", () => {
    const options = within(screen.getByLabelText("置くイベント")).getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual(["空のイベント", "話しかける人", "扉・場所移動", "宝箱", "商人", "敵シンボル"]);
    expect(t.session.ui.tool).toBe("pencil");
    choose("宝箱");
    expect(t.session.ui).toMatchObject({ tool: "event", eventTemplate: "chest" });
    choose("空のイベント");
    expect(t.session.ui).toMatchObject({ tool: "event", eventTemplate: undefined });
    // 空のイベントなら、これまでどおりクリックでそのまま置く
    fireEvent.pointerDown(mapCanvas(), at(1, 1));
    expect(events()).toHaveLength(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("プラグインが足したひな形も並び、同じように置ける", async () => {
    cleanup();
    await setup({ plugins: [customCommandPlugin] });
    const dialog = place("くじ引き");
    fireEvent.change(within(dialog).getByLabelText("最大"), { target: { value: "50" } });
    fireEvent.click(button(dialog, "作成"));
    expect(events()[0]).toMatchObject({ name: "くじ引き", pages: [{ commands: [{ code: "ShowText" }, { code: "plugin:custom-command/RandomGold", params: { min: 10, max: 50 } }, { code: "ControlSelfSwitch" }] }, {}] });
  });
});

describe("EventTemplateDialog", () => {
  it("扉：移動先はマップのプレビューのクリックと矢印キーで選ぶ。作成するとそのセルに置いて選び、1 回の Undo で消える", () => {
    const dialog = place("扉・場所移動");
    expect(events()).toEqual([]); // 置くのは「作成」のとき
    const picker = within(dialog).getByRole("application");
    expect(picker.getAttribute("aria-label")).toContain("移動先：マップ「MAP001」をクリックして位置を選ぶ");
    fireEvent.pointerDown(picker, at(12, 3));
    expect((within(dialog).getByLabelText("移動先 X") as HTMLInputElement).value).toBe("12");
    expect((within(dialog).getByLabelText("移動先 Y") as HTMLInputElement).value).toBe("3");
    fireEvent.keyDown(picker, { key: "ArrowDown" });
    fireEvent.keyDown(picker, { key: "ArrowLeft" });
    fireEvent.keyDown(picker, { key: "Enter" }); // 矢印以外は無視
    expect(within(dialog).getByText("選んでいる位置：(11, 4)")).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText("移動するとき"), { target: { value: "step" } });
    fireEvent.click(button(dialog, "作成"));

    expect(screen.queryByRole("dialog")).toBeNull();
    const [door] = events();
    expect(door).toMatchObject({ name: "扉", x: 5, y: 6, pages: [{ trigger: "touch", priority: "below", commands: [{ code: "TransferPlayer", params: { mapId: M1, x: 11, y: 4 } }] }] });
    expect(t.session.ui.selection).toEqual({ kind: "event", eventId: door!.id });
    expect(t.session.undoLabel).toBe("イベントの作成（扉・場所移動）");
    act(() => t.session.undo());
    expect(events()).toEqual([]);
    expect(t.session.canUndo).toBe(false);
  });

  it("やめる・Esc では何も置かない。イベントのあるセルのクリックは、これまでどおり選ぶだけ", () => {
    fireEvent.click(button(place("宝箱"), "やめる"));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.keyDown(place("宝箱"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(events()).toEqual([]);

    act(() => void t.session.execute(cmd.createEvent(M1, 2, 2, "ev_x" as EventId)));
    fireEvent.pointerDown(mapCanvas(), at(2, 2));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(t.session.ui.selection).toEqual({ kind: "event", eventId: "ev_x" });
  });

  it("入力が正しくない間は作成できず、問題をひな形の見出しで出す（アイテムが無ければ案内も出す）。お金に切り替えれば作れる", () => {
    const dialog = place("宝箱");
    expect(button(dialog, "作成").disabled).toBe(true);
    expect(button(dialog, "作成して編集…").disabled).toBe(true);
    expect(within(dialog).getByRole("alert", { name: "入力の問題" }).textContent).toBe("中身 アイテム：未設定です");
    expect(within(dialog).getByText(/まだアイテムがありません/)).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText("中身の種類"), { target: { value: "1" } });
    fireEvent.change(within(dialog).getByLabelText("中身 金額"), { target: { value: "250" } });
    expect(within(dialog).queryByRole("alert", { name: "入力の問題" })).toBeNull();
    fireEvent.click(button(dialog, "作成"));
    expect(events()[0]!.pages[0]!.commands.map((c) => c.code)).toEqual(["ShowText", "ChangeGold", "ControlSelfSwitch"]);
    expect(events()[0]!.pages[0]!.commands[1]!.params).toMatchObject({ amount: { kind: "constant", value: 250 } });
  });

  it("話しかける人：見た目は歩行グラフィックらしい画像が最初から入る。「作成して編集…」で編集画面を開く", () => {
    const dialog = place("話しかける人");
    expect((within(dialog).getByLabelText("見た目を設定") as HTMLInputElement).checked).toBe(true);
    expect((within(dialog).getByLabelText("見た目 アセット") as HTMLSelectElement).value).toBe(HERO);
    fireEvent.change(within(dialog).getByRole("textbox", { name: "セリフ" }), { target: { value: "やあ。\n\nいい天気だね。" } });
    fireEvent.click(within(dialog).getByLabelText("2 回目からのセリフを設定"));
    fireEvent.change(within(dialog).getByRole("textbox", { name: "2 回目からのセリフ" }), { target: { value: "また来たね。" } });
    fireEvent.click(button(dialog, "作成して編集…"));
    const [npc] = events();
    expect(opened).toEqual([npc!.id]);
    expect(npc!.pages.map((p) => p.commands.map((c) => c.code))).toEqual([["ShowText", "ShowText", "ControlSelfSwitch"], ["ShowText"]]);
    expect(npc!.pages[0]).toMatchObject({ graphic: { asset: HERO, index: 0, direction: "down" } });
  });

  it("キーボード：キャンバスで Enter を押すと、カーソルのあるセルに置くダイアログが出る", () => {
    choose("商人");
    fireEvent.keyDown(mapCanvas(), { key: "ArrowRight" });
    fireEvent.keyDown(mapCanvas(), { key: "Enter" });
    expect(screen.getByRole("dialog", { name: "ひな形から作成：商人" }).textContent).toContain("置く位置：(1, 0)");
  });

  it("ひな形の initial が例外を投げても、既定値のまま開ける", async () => {
    cleanup();
    await setup({
      plugins: [
        {
          name: "broken",
          version: "1.0.0",
          register(h) {
            h.editor!.eventTemplate({ ...BUILTIN_EVENT_TEMPLATES[0]!, id: "oops", label: "壊れた初期値", initial: () => { throw new Error("だめ"); } });
          },
        },
      ],
    });
    const dialog = place("壊れた初期値");
    expect((within(dialog).getByLabelText("見た目を設定") as HTMLInputElement).checked).toBe(false);
    expect((within(dialog).getByLabelText("イベント名") as HTMLInputElement).value).toBe("村人");
  });

  it("開いている間にそのセルがふさがったら、作成せずにメッセージを出す", () => {
    const dialog = place("扉・場所移動");
    act(() => void t.session.execute(cmd.createEvent(M1, 5, 6, "ev_y" as EventId)));
    fireEvent.click(button(dialog, "作成"));
    expect(within(dialog).getByRole("alert").textContent).toContain("(5,6) には既にイベント");
    expect(events()).toHaveLength(1);
  });
});
