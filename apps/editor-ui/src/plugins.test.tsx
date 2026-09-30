// @vitest-environment jsdom
import { createNullAudioOut } from "@rpg/audio-null";
import { cmd } from "@rpg/editor-core";
import { createScriptInput } from "@rpg/input-script";
import { customCommandPlugin, hudPlugin, samplePlugins } from "@rpg/plugin-samples";
import type { PluginModule } from "@rpg/plugin-api";
import { createNullRenderer } from "@rpg/render-null";
import type { AssetSource, ImageHandle } from "@rpg/runtime";
import type { EventId, MapId } from "@rpg/schema";
import { createManualScheduler } from "@rpg/test-utils";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { CommandForm } from "./components/CommandList.js";
import { EventDialog } from "./components/EventDialog.js";
import { SystemDialog } from "./components/SystemDialog.js";
import { startPlaytest } from "./playtest.js";
import { createTestEnv } from "./test-env.js";

afterEach(cleanup);
const M1 = "map_001" as MapId;
const EV = "ev_a" as EventId;

describe("システム設定のプラグインタブ", () => {
  const openTab = async (plugins: readonly PluginModule[] = samplePlugins) => {
    const t = await createTestEnv({ plugins });
    render(t.wrap(<SystemDialog onClose={() => {}} />));
    fireEvent.click(screen.getByRole("tab", { name: "プラグイン" }));
    return t;
  };

  it("ビルドに入っているプラグインを一覧し、チェックで有効・無効を切り替える（Undo できる）", async () => {
    const t = await openTab();
    const list = screen.getByRole("list", { name: "プラグインの一覧" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    fireEvent.click(screen.getByRole("checkbox", { name: "hud を有効にする" }));
    expect(t.session.doc.project.system.plugins).toEqual([{ name: "hud", version: "1.0.0", params: {} }]);
    act(() => t.session.undo()); // 有効にした操作を Undo
    expect(t.session.doc.project.system.plugins).toEqual([]);
    act(() => t.session.redo());
    fireEvent.click(screen.getByRole("checkbox", { name: "hud を有効にする" })); // チェックを外す
    expect(t.session.doc.project.system.plugins).toEqual([]);
  });

  it("有効なプラグインは設定（JSON）を編集できる。オブジェクトでない・壊れた JSON は確定しない", async () => {
    const t = await openTab();
    fireEvent.click(screen.getByRole("checkbox", { name: "hud を有効にする" }));
    const field = screen.getByLabelText("hud の設定（JSON）") as HTMLInputElement;
    fireEvent.change(field, { target: { value: '{"label":"金"}' } });
    expect(t.session.doc.project.system.plugins[0]?.params).toEqual({ label: "金" });
    fireEvent.change(screen.getByLabelText("hud の設定（JSON）"), { target: { value: "[1]" } });
    fireEvent.change(screen.getByLabelText("hud の設定（JSON）"), { target: { value: "{oops" } });
    expect(t.session.doc.project.system.plugins[0]?.params).toEqual({ label: "金" });
    expect((screen.getByLabelText("hud の設定（JSON）") as HTMLInputElement).getAttribute("aria-invalid")).toBe("true");
  });

  it("このビルドに入っていないプラグインは別に出して、一覧から外せる。カタログが空ならその旨を出す", async () => {
    const t = await createTestEnv({ plugins: [] });
    act(() => void t.session.execute(cmd.setSystem({ plugins: [{ name: "ghost", version: "9", params: {} }] })));
    render(t.wrap(<SystemDialog onClose={() => {}} />));
    fireEvent.click(screen.getByRole("tab", { name: "プラグイン" }));
    expect(screen.getByText(/プラグインが入っていない/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "ghost を一覧から外す" }));
    expect(t.session.doc.project.system.plugins).toEqual([]);
  });

  it("読み込めなかったプラグインを知らせる", async () => {
    const broken: PluginModule = { name: "broken", version: "1", register: () => { throw new Error("だめ"); } };
    await openTab([broken, hudPlugin]);
    expect(screen.getByRole("alert").textContent).toContain("broken");
  });
});

describe("エディタの中のプラグイン", () => {
  it("プラグインのコマンドがコマンド一覧に出て、標準のフォームで編集できる。使っているのに無効なら診断が警告する", async () => {
    const t = await createTestEnv({ plugins: [customCommandPlugin] });
    act(() => void t.session.execute(cmd.createEvent(M1, 3, 4, EV)));
    render(t.wrap(<EventDialog mapId={M1} eventId={EV} onClose={() => {}} />));
    fireEvent.click(screen.getByRole("button", { name: "コマンドを追加…" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "コマンドの追加" })).getByRole("button", { name: "ランダムな所持金" }));
    const page = () => t.session.doc.maps[M1]!.events[EV]!.pages[0]!;
    expect(page().commands[0]).toMatchObject({ code: "plugin:custom-command/RandomGold" });
    fireEvent.change(screen.getByLabelText("最小"), { target: { value: "30" } });
    fireEvent.change(screen.getByLabelText("最大"), { target: { value: "10" } });
    // 有効になっていない警告と、プラグイン自身の診断（min > max）の両方
    const codes = t.session.validate().map((d) => d.code);
    expect(codes).toEqual(expect.arrayContaining(["pluginNotEnabled", "randomGoldRange"]));
    act(() => void t.session.execute(cmd.setSystem({ plugins: [{ name: "custom-command", version: "1.0.0", params: {} }] })));
    expect(t.session.validate().map((d) => d.code)).not.toContain("pluginNotEnabled");
  });

  it("プラグインの分岐コマンドも meta.block だけで、区切りと終端が一緒に入り、数が合い、ブロックごと消える。区切りは単独で扱えず、一覧にも出ない", async () => {
    const noRefs = () => [];
    const blocks: PluginModule = {
      name: "blocks",
      version: "1.0.0",
      register(h) {
        const run = () => ({});
        h.commands.add({
          code: "Pick",
          params: z.strictObject({ ways: z.number().int().min(1).default(2) }),
          meta: {
            label: "くじの分岐",
            category: "フロー制御",
            describe: (p) => `くじ：${p.ways}通り`,
            refs: noRefs,
            block: { role: "open", close: "plugin:blocks/EndPick", bodyFirst: false, dividers: (p) => Array.from({ length: p.ways }, (_, k) => ({ code: "plugin:blocks/Way", params: { k } })) },
          },
          run,
        });
        h.commands.add({ code: "Way", params: z.strictObject({ k: z.number() }), meta: { label: "くじの道", category: "フロー制御", describe: (p) => `道 ${p.k}`, refs: noRefs, block: { role: "divider" } }, run });
        h.commands.add({ code: "EndPick", params: z.strictObject({}), meta: { label: "くじの終わり", category: "フロー制御", describe: () => "くじ終了", refs: noRefs, block: { role: "close" } }, run });
      },
    };
    const t = await createTestEnv({ plugins: [blocks] });
    act(() => void t.session.execute(cmd.createEvent(M1, 3, 4, EV)));
    render(t.wrap(<EventDialog mapId={M1} eventId={EV} onClose={() => {}} />));
    const page = () => t.session.doc.maps[M1]!.events[EV]!.pages[0]!;
    fireEvent.click(screen.getByRole("button", { name: "コマンドを追加…" }));
    const picker = screen.getByRole("dialog", { name: "コマンドの追加" });
    expect(within(picker).queryByRole("button", { name: "くじの道" })).toBeNull();
    expect(within(picker).queryByRole("button", { name: "くじの終わり" })).toBeNull();
    fireEvent.click(within(picker).getByRole("button", { name: "くじの分岐" }));
    expect(page().commands.map((c) => c.code)).toEqual(["plugin:blocks/Pick", "plugin:blocks/Way", "plugin:blocks/Way", "plugin:blocks/EndPick"]);
    // 数を増やすと、区切りが足される（設定の確定と 1 回の Undo）
    fireEvent.change(screen.getByLabelText("ways"), { target: { value: "3" } });
    expect(page().commands.map((c) => c.code)).toEqual(["plugin:blocks/Pick", "plugin:blocks/Way", "plugin:blocks/Way", "plugin:blocks/Way", "plugin:blocks/EndPick"]);
    expect(page().commands[3]!.params).toEqual({ k: 2 });
    // 区切りだけは削除・コピーできない。開始を選べばブロックごと
    fireEvent.click(screen.getByRole("option", { name: "道 0" }));
    expect((screen.getByRole("button", { name: "削除" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "コマンドをコピー" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("option", { name: "くじ：3通り" }));
    fireEvent.click(screen.getByRole("button", { name: "削除" }));
    expect(page().commands).toEqual([]);
  });

  it("host.editor.commandForm で登録した専用フォームが、標準のフォームの代わりに使われる", async () => {
    const Custom = ({ params }: { params: Record<string, unknown> }) => <div role="group" aria-label="専用フォーム">{JSON.stringify(params)}</div>;
    const borrowed = (await createTestEnv()).env.commands.get("Else")!.params as never; // 空のオブジェクトを受け付ける params を借りる
    const withForm: PluginModule = {
      name: "formed",
      version: "1.0.0",
      register(host) {
        host.commands.add({ code: "Do", params: borrowed, meta: { label: "する", category: "p", describe: () => "する", refs: () => [] }, run: () => ({}) });
        host.editor?.commandForm("Do", Custom);
      },
    };
    const t = await createTestEnv({ plugins: [withForm] });
    expect(t.env.formOverrides["plugin:formed/Do"]).toBe(Custom);
    render(t.wrap(<CommandForm command={{ code: "plugin:formed/Do", params: { a: 1 }, indent: 0 }} onCommit={() => {}} />));
    expect(screen.getByRole("group", { name: "専用フォーム" }).textContent).toBe('{"a":1}');
  });
});

describe("テストプレイ", () => {
  const assets: AssetSource = {
    loadImage: () => Promise.resolve({} as ImageHandle),
    loadAudio: () => Promise.reject(new Error("音声なし")),
    loadJson: () => Promise.reject(new Error("JSON なし")),
    has: () => Promise.resolve(true),
  };

  it("プロジェクトが有効にしているプラグインだけが、ゲームに効く（HUD が出る／出ない）", async () => {
    const t = await createTestEnv({ plugins: samplePlugins });
    const play = async () => {
      const extensions = await t.env.createExtensions(t.session.doc.project.system.plugins);
      const pt = await startPlaytest(t.session, { scheduler: createManualScheduler(), renderer: createNullRenderer(), audio: createNullAudioOut(), input: createScriptInput([]), assets, seed: "s", extensions }, { mapId: M1, x: 1, y: 1 });
      const hud = pt.runtime.project().ui.some((n) => n.kind === "window");
      pt.stop();
      return hud;
    };
    expect(await play()).toBe(false);
    act(() => void t.session.execute(cmd.setSystem({ plugins: [{ name: "hud", version: "1.0.0", params: {} }] })));
    expect(await play()).toBe(true);
  });

  it("createExtensions：入っていないプラグイン・バージョン違いは logger に警告し、読み込めるものは読み込む", async () => {
    const t = await createTestEnv({ plugins: samplePlugins });
    const warnings: string[] = [];
    const ext = await t.env.createExtensions(
      [{ name: "ghost", version: "1", params: {} }, { name: "hud", version: "0.0.1", params: {} }],
      { debug() {}, info() {}, warn: (m) => warnings.push(m), error() {} },
    );
    expect(warnings).toHaveLength(2);
    expect(ext.afterProject).toBeDefined();
  });
});
