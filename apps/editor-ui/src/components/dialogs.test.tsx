// @vitest-environment jsdom
import { cmd } from "@rpg/editor-core";
import type { AssetId, EventId, MapId } from "@rpg/schema";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestEnv } from "../test-env.js";
import type { TestEnv } from "../test-env.js";
import { AssetBrowser } from "./AssetBrowser.js";
import { DatabaseDialog, nextId } from "./DatabaseDialog.js";
import { DiagnosticsPanel } from "./DiagnosticsPanel.js";
import { SystemDialog } from "./SystemDialog.js";

const M1 = "map_001" as MapId;
let t: TestEnv;
beforeEach(async () => {
  t = await createTestEnv();
});
afterEach(cleanup);

const doAct = (f: () => unknown): void => void act(() => void f());

describe("nextId", () => {
  it("使われていない最小の連番", () => {
    expect(nextId("actor", [])).toBe("actor_001");
    expect(nextId("actor", ["actor_001", "actor_003"])).toBe("actor_002");
  });
});

describe("DatabaseDialog", () => {
  const open = (): void => void render(t.wrap(<DatabaseDialog onClose={() => {}} />));
  const tab = (name: string): void => void fireEvent.click(screen.getByRole("tab", { name }));
  const add = (): void => void fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "＋ 追加" }));

  it("すべてのテーブルで、追加でき、追加したものが文書に入る（スキーマを通る）", () => {
    open();
    for (const [label, key] of [["アクター", "actors"], ["職業", "classes"], ["スキル", "skills"], ["アイテム", "items"], ["敵", "enemies"], ["敵グループ", "troops"], ["ステート", "states"], ["コモンイベント", "commonEvents"]] as const) {
      tab(label);
      const before = Object.keys(t.session.doc.project.database[key]).length;
      add();
      expect(screen.queryByRole("alert"), `${label}を追加できない`).toBeNull();
      expect(Object.keys(t.session.doc.project.database[key])).toHaveLength(before + 1);
    }
    expect(t.session.validate().filter((d) => d.severity === "error")).toEqual([]);
  });

  it("名前を編集できる。一覧の表示も変わる", () => {
    open();
    add();
    const list = screen.getByRole("list", { name: "アクターの一覧" });
    fireEvent.click(within(list).getByRole("button", { name: "新しいアクター" }));
    fireEvent.change(screen.getByLabelText("名前"), { target: { value: "魔法使い" } });
    expect(t.session.doc.project.database.actors["actor_002" as never]).toMatchObject({ name: "魔法使い" });
    expect(within(list).getByRole("button", { name: "魔法使い" })).toBeTruthy();
  });

  it("入力が不正な間は文書を変えず、問題を表示する", () => {
    open();
    tab("アイテム");
    add();
    const before = t.session.doc;
    fireEvent.change(screen.getByLabelText("価格"), { target: { value: "" } });
    expect(t.session.doc).toBe(before);
    expect(screen.getByRole("alert", { name: "入力の問題" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("価格"), { target: { value: "30" } });
    expect(t.session.doc.project.database.items["item_001" as never]).toMatchObject({ price: 30 });
  });

  it("参照されているものの削除は確認ダイアログが出て、承諾すると参照切れのまま消える", () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: "削除" }));
    const confirm = screen.getByRole("dialog", { name: "削除の確認" });
    expect(within(confirm).getByText(/system.initialParty/)).toBeTruthy();
    fireEvent.click(within(confirm).getByRole("button", { name: "キャンセル" }));
    expect(Object.keys(t.session.doc.project.database.actors)).toEqual(["actor_001"]);
    fireEvent.click(screen.getByRole("button", { name: "削除" }));
    fireEvent.click(screen.getByRole("button", { name: "それでも削除" }));
    expect(t.session.doc.project.database.actors).toEqual({});
    expect(screen.getByText("（まだありません）")).toBeTruthy();
  });

  it("追加できないとき（前提が無い）は理由を出す", () => {
    doAct(() => t.session.execute(cmd.deleteEntity("classes", "class_001"), { force: true }));
    open();
    add();
    expect(screen.getByRole("alert").textContent).toContain("アクターを追加できません");
  });

  it("コモンイベントのコマンド列は専用のリストで編集できる", () => {
    open();
    tab("コモンイベント");
    add();
    fireEvent.click(screen.getByRole("button", { name: "コマンドを追加…" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "コマンドの追加" })).getByRole("button", { name: "文章の表示" }));
    fireEvent.change(screen.getByLabelText("本文"), { target: { value: "共通" } });
    const ce = t.session.doc.project.database.commonEvents["ce_001" as never] as { commands: { code: string; params: Record<string, unknown> }[] };
    expect(ce.commands).toMatchObject([{ code: "ShowText", params: { text: "共通" } }]);
  });

  it("コモンイベントのコマンド列も、並べ替え・コピー・貼り付けができる", () => {
    open();
    tab("コモンイベント");
    add();
    const quick = screen.getByLabelText("文章をすぐ追加");
    fireEvent.change(quick, { target: { value: "一つ目\n\n二つ目" } });
    fireEvent.keyDown(quick, { key: "Enter" });
    const texts = () => t.session.doc.project.database.commonEvents["ce_001" as never]!.commands.map((c) => String(c.params["text"]));
    expect(texts()).toEqual(["一つ目", "二つ目"]);
    fireEvent.click(screen.getByRole("button", { name: "コマンドを上へ" })); // 最後に入れた「二つ目」が選ばれている
    expect(texts()).toEqual(["二つ目", "一つ目"]);
    fireEvent.click(screen.getByRole("button", { name: "コマンドをコピー" }));
    fireEvent.click(screen.getByRole("button", { name: "コマンドを貼り付け" }));
    expect(texts()).toEqual(["二つ目", "二つ目", "一つ目"]);
  });
});

describe("SystemDialog", () => {
  const open = (): void => void render(t.wrap(<SystemDialog onClose={() => {}} />));

  it("開始位置などのシステム設定を編集できる", () => {
    open();
    fireEvent.change(screen.getByLabelText("開始X"), { target: { value: "8" } });
    expect(t.session.doc.project.system.startX).toBe(8);
    fireEvent.change(screen.getByLabelText("開始マップ"), { target: { value: M1 } });
    fireEvent.change(screen.getByLabelText("タイルサイズ"), { target: { value: "2" } }); // 16 | 32 | 48 のうち 48
    expect(t.session.doc.project.system.tileSize).toBe(48);
  });

  it("開始位置は、開始マップのプレビューをクリックしても選べる", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 640, height: 480, right: 640, bottom: 480, x: 0, y: 0, toJSON: () => ({}) });
    open();
    const picker = screen.getByRole("application", { name: /マップ「MAP001」をクリックして位置を選ぶ/ });
    fireEvent.pointerDown(picker, { clientX: 3 * 32 + 16, clientY: 9 * 32 + 16, button: 0, pointerId: 1 });
    expect(t.session.doc.project.system).toMatchObject({ startMap: M1, startX: 3, startY: 9 });
    fireEvent.pointerDown(picker, { clientX: 3 * 32 + 16, clientY: 9 * 32 + 16, button: 2, pointerId: 1 }); // 右ボタンは無視
    fireEvent.pointerDown(picker, { clientX: 700, clientY: 9 * 32 + 16, button: 0, pointerId: 1 }); // マップの外も無視
    expect(t.session.doc.project.system).toMatchObject({ startX: 3, startY: 9 });
    vi.restoreAllMocks();
  });

  it("スイッチの追加・名前変更・削除。使われていれば確認する。変数も同様", () => {
    open();
    fireEvent.click(screen.getByRole("tab", { name: "スイッチ" }));
    expect(screen.getByText("（なし）")).toBeTruthy();
    const add = screen.getByRole("button", { name: "＋ 追加" }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("新しいスイッチのID"), { target: { value: "sw_door" } });
    fireEvent.change(screen.getByLabelText("新しいスイッチの名前"), { target: { value: "扉" } });
    fireEvent.click(add);
    expect(t.session.doc.project.switches["sw_door" as never]).toEqual({ name: "扉" });
    fireEvent.change(screen.getByLabelText("sw_door の名前"), { target: { value: "重い扉" } });
    expect(t.session.doc.project.switches["sw_door" as never]).toEqual({ name: "重い扉" });

    doAct(() => t.session.execute(cmd.createEvent(M1, 1, 1, "ev_a" as EventId)));
    doAct(() => t.session.execute(cmd.insertCommands(M1, "ev_a" as EventId, 0, 0, [{ code: "ControlSwitches", params: { ids: ["sw_door"], value: true }, indent: 0 }])));
    fireEvent.click(screen.getByLabelText("sw_door を削除"));
    expect(screen.getByRole("dialog", { name: "削除の確認" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));
    expect(t.session.doc.project.switches).toHaveProperty("sw_door");

    fireEvent.click(screen.getByRole("tab", { name: "変数" }));
    fireEvent.change(screen.getByLabelText("新しい変数のID"), { target: { value: "v_count" } });
    fireEvent.click(screen.getByRole("button", { name: "＋ 追加" }));
    expect(t.session.doc.project.variables).toHaveProperty("v_count");
    fireEvent.change(screen.getByLabelText("v_count の名前"), { target: { value: "回数" } });
    fireEvent.click(screen.getByLabelText("v_count を削除"));
    expect(t.session.doc.project.variables).toEqual({});
  });

  it("不正な ID や重複した ID は追加できない", () => {
    open();
    fireEvent.click(screen.getByRole("tab", { name: "スイッチ" }));
    const id = screen.getByLabelText("新しいスイッチのID");
    fireEvent.change(id, { target: { value: "a:b" } });
    expect((screen.getByRole("button", { name: "＋ 追加" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("AssetBrowser", () => {
  const png = (): File => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 2])], "new.png", { type: "image/png" });
  const open = (): void => void render(t.wrap(<AssetBrowser onClose={() => {}} />));

  it("テンプレートのアセットを一覧する", () => {
    open();
    const list = screen.getByRole("list", { name: "アセット一覧" });
    expect(within(list).getByText("tileset.png")).toBeTruthy();
    expect(within(list).getByText("hero.png")).toBeTruthy();
  });

  it("ファイルを選ぶと取り込まれる。対応しない形式はメッセージで知らせる", async () => {
    open();
    const input = screen.getByLabelText("アセットのファイル");
    fireEvent.change(input, { target: { files: [png(), new File(["x"], "memo.txt", { type: "text/plain" })] } });
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("new.png：取り込みました"));
    expect(screen.getByRole("status").textContent).toContain("memo.txt：対応していない形式");
    expect(Object.values(t.session.doc.project.assets.entries).map((e) => e.name)).toContain("new.png");
  });

  it("ドロップでも取り込める。ドラッグ中は強調される", async () => {
    open();
    const zone = document.querySelector(".dropzone")!;
    fireEvent.dragOver(zone);
    expect(zone.className).toContain("over");
    fireEvent.dragLeave(zone);
    expect(zone.className).not.toContain("over");
    fireEvent.drop(zone, { dataTransfer: { files: [new File([new Uint8Array([1, 2, 3])], "bgm.ogg", { type: "audio/ogg" }), new File(["{}"], "a.json", { type: "application/json" }), new File([new Uint8Array([1])], "f.woff2", { type: "" })] } });
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("bgm.ogg：取り込みました"));
    expect(Object.values(t.session.doc.project.assets.entries).map((e) => e.kind)).toEqual(expect.arrayContaining(["audio", "data", "font"]));
  });

  it("使われていないアセットは登録を外せ、使われているものは確認が出る", async () => {
    const id = (await t.session.importAsset(new Uint8Array([9, 9]).buffer, "tmp.ogg", "audio").then((r) => (r.ok ? r.value.id : ""))) as AssetId;
    open();
    fireEvent.click(screen.getByLabelText("tmp.ogg の登録を外す"));
    expect(t.session.doc.project.assets.entries[id]).toBeUndefined();
    fireEvent.click(screen.getByLabelText("tileset.png の登録を外す"));
    expect(screen.getByRole("dialog", { name: "削除の確認" })).toBeTruthy();
  });

  it("画像のプレビューは Blob URL があれば出す", async () => {
    const created: string[] = [];
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: (b: Blob) => (created.push(b.type), "blob:test"), revokeObjectURL: () => {} }));
    open();
    await waitFor(() => expect(document.querySelector("img.thumb")).not.toBeNull());
    expect(created).toContain("image/png");
    vi.unstubAllGlobals();
  });
});

describe("DiagnosticsPanel", () => {
  it("問題が無ければそう言う。あれば一覧し、場所を開ける", () => {
    const opened: [string, string][] = [];
    const { unmount } = render(t.wrap(<DiagnosticsPanel onClose={() => {}} onOpenEvent={(m, e) => opened.push([m, e])} />));
    expect(screen.getByRole("status").textContent).toBe("問題は見つかりませんでした。");
    unmount();

    doAct(() => t.session.execute(cmd.createEvent(M1, 1, 1, "ev_a" as EventId)));
    doAct(() => t.session.execute(cmd.insertCommands(M1, "ev_a" as EventId, 0, 0, [{ code: "Nope", params: {}, indent: 0 }])));
    doAct(() => t.session.execute(cmd.setSystem({ initialParty: [] })));
    render(t.wrap(<DiagnosticsPanel onClose={() => {}} onOpenEvent={(m, e) => opened.push([m, e])} />));
    expect(screen.getByRole("status").textContent).toBe("エラー 1 件、警告 1 件");
    const list = screen.getByRole("list", { name: "診断結果" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    fireEvent.click(within(list).getByRole("button", { name: "開く" }));
    expect(opened).toEqual([[M1, "ev_a"]]);
    expect(t.session.ui.selection).toEqual({ kind: "event", eventId: "ev_a" });
  });
});
