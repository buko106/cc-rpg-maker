import { createPluginRegistry, loadPlugins } from "@rpg/plugin-api";
import type { PluginDocument } from "@rpg/plugin-api";
import { loadFixtureProject } from "@rpg/test-utils";
import { describe, expect, it } from "vitest";
import { fishingPlugin } from "./index.js";

const { project, maps } = loadFixtureProject("fishing", 2);
const params = project.system.plugins[0]!.params;
const doc = (patch: Record<string, unknown> = {}, extra: Partial<PluginDocument> = {}): PluginDocument => ({
  project: { ...project, system: { ...project.system, plugins: [{ name: "fishing", version: "1.0.0", params: { ...params, ...patch } }] } },
  maps,
  ...extra,
});

async function editorRegistry() {
  const registry = createPluginRegistry();
  const r = await loadPlugins([fishingPlugin], registry, { editor: true });
  expect(r.failed).toEqual([]);
  return registry;
}

describe("エディタ：ひな形", () => {
  it("「釣り場」「つり手帳」「大会の進行役」が足される（ゲームの中では足されない）", async () => {
    expect((await editorRegistry()).editor.eventTemplates.map((t) => t.id)).toEqual(["plugin:fishing/spot", "plugin:fishing/album", "plugin:fishing/controller"]);
    const game = createPluginRegistry();
    await loadPlugins([fishingPlugin], game);
    expect(game.editor.eventTemplates).toEqual([]);
  });

  it("釣り場：決定ボタンで、入力した種類の Cast を呼ぶ", async () => {
    const [spot] = (await editorRegistry()).editor.eventTemplates;
    const { name, pages } = spot!.build(spot!.input.parse({ name: "桟橋", spot: "pier" }), project);
    expect(name).toBe("桟橋");
    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({ trigger: "action", priority: "same", commands: [{ code: "plugin:fishing/Cast", params: { spot: "pier" } }] });
  });

  it("つり手帳：Album を呼ぶ", async () => {
    const [, album] = (await editorRegistry()).editor.eventTemplates;
    expect(album!.build(album!.input.parse({ name: "板" }), project).pages[0]!.commands.map((c) => c.code)).toEqual(["plugin:fishing/Album"]);
  });

  it("大会の進行役：毎フレーム Watch、時間が来たら（設定のイベント用の変数が 1）鐘のセリフ → Result → 発表のあとのセリフ", async () => {
    const [, , controller] = (await editorRegistry()).editor.eventTemplates;
    const input = controller!.input.parse({ name: "c", bell: "カーン！", after: "おしまい。" });
    const { pages } = controller!.build(input, project);
    expect(pages.map((p) => p.trigger)).toEqual(["parallel", "autorun"]);
    expect(pages[0]!.commands.map((c) => c.code)).toEqual(["plugin:fishing/Watch"]);
    expect(pages[1]).toMatchObject({ conditions: [{ kind: "variable", id: "var_fishing_event", op: "==", value: 1 }] });
    expect(pages[1]!.commands.map((c) => c.code)).toEqual(["ShowText", "plugin:fishing/Result", "ShowText"]);
    const renamed = { ...project, system: { ...project.system, plugins: [{ name: "fishing", version: "1", params: { ...params, vars: { event: "var_evt" } } }] } };
    expect(controller!.build(input, renamed).pages[1]).toMatchObject({ conditions: [{ id: "var_evt" }] });
    const none = { ...project, system: { ...project.system, plugins: [] } };
    expect(controller!.build(input, none).pages[1]).toMatchObject({ conditions: [{ id: "var_fishing_event" }] });
  });

  it("コマンドは登録されていて、説明が出て、検証を通る形", async () => {
    const registry = await editorRegistry();
    for (const code of ["Cast", "Start", "Watch", "Result", "Album"]) {
      const c = registry.commands.find((x) => x.code === `plugin:fishing/${code}`)!;
      expect(c, code).toBeDefined();
      expect(c.meta.category).toBe("釣り");
      expect(c.meta.refs(code === "Cast" ? { spot: "pier" } : {})).toEqual([]);
    }
    const cast = registry.commands.find((x) => x.code === "plugin:fishing/Cast")!;
    expect(cast.params.safeParse({ spot: "pier" }).success).toBe(true);
    expect(cast.params.safeParse({ spot: "" }).success).toBe(false);
    expect(cast.meta.describe({ spot: "deep" }, {} as never)).toBe("釣る：deep");
    expect(registry.commands.find((x) => x.code === "plugin:fishing/Start")!.meta.describe({}, {} as never)).toContain("大会");
  });
});

describe("エディタ：診断", () => {
  it("デモのプロジェクトは、診断なし。プラグインを使っていないプロジェクトも何も言わない", async () => {
    const [diag] = (await editorRegistry()).editor.diagnostics;
    expect(diag!(doc())).toEqual([]);
    expect(diag!({ project: { ...project, system: { ...project.system, plugins: [] } }, maps })).toEqual([]);
  });

  it("設定が不正・アイテムがデータベースに無い・釣れる魚の無い釣り場・進行役が無い、を知らせる", async () => {
    const [diag] = (await editorRegistry()).editor.diagnostics;
    expect(diag!(doc({ fish: [] }))).toEqual([expect.objectContaining({ severity: "error", code: "fishingConfig" })]);
    expect(diag!(doc({ baseZone: 5 }))[0]).toMatchObject({ code: "fishingConfig" });
    const fish = (params["fish"] as { key: string; size: number[] }[]).map((f) => (f.key === "aji" ? { ...f, size: [30, 10] } : f));
    expect(diag!(doc({ fish }))[0]).toMatchObject({ code: "fishingConfig", message: expect.stringContaining("size") });
    expect(diag!(doc({ fish: [...(params["fish"] as object[]), ...(params["fish"] as object[]).slice(0, 1)] }))[0]).toMatchObject({ code: "fishingConfig", message: expect.stringContaining("重なっ") });

    expect(diag!(doc({ rods: [{ item: "item_ghost", name: "幻の竿", zone: 0.5 }] }))).toEqual([expect.objectContaining({ code: "fishingItem", message: expect.stringContaining("item_ghost") })]);
    expect(diag!(doc({ baits: [{ item: "item_ghost" , name: "x" }] }))).toEqual([expect.objectContaining({ code: "fishingItem" })]);
    expect(diag!(doc({ tournament: { trophy: "item_ghost" } }))).toEqual([expect.objectContaining({ code: "fishingItem", message: expect.stringContaining("トロフィー") })]);

    // 釣り場の種類に釣れる魚が無い
    const only = (params["fish"] as { spots: string[] }[]).map((f) => ({ ...f, spots: f.spots.filter((s) => s !== "rocks").length > 0 ? f.spots.filter((s) => s !== "rocks") : ["pier"] }));
    expect(diag!(doc({ fish: only })).some((d) => d.code === "fishingSpot" && d.message.includes("rocks"))).toBe(true);

    // 大会を始めるのに、進行役（Watch）が無い
    const harbor = maps["map_harbor" as never] as { events: Record<string, { pages: { commands: { code: string }[] }[] }> };
    const noWatch = { ...maps, map_harbor: { ...harbor, events: Object.fromEntries(Object.entries(harbor.events).map(([id, ev]) => [id, { ...ev, pages: ev.pages.map((p) => ({ ...p, commands: p.commands.filter((c) => c.code !== "plugin:fishing/Watch") })) }])) } } as PluginDocument["maps"];
    expect(diag!(doc({}, { maps: noWatch }))).toEqual([expect.objectContaining({ severity: "warning", code: "fishingNoController" })]);
  });
});

describe("プラグインの読み込み", () => {
  it("設定なしでも読み込める（エディタ）。不正な設定は警告を出すが、読み込みは成功する", async () => {
    const warnings: string[] = [];
    const logger = { debug() {}, info() {}, warn: (m: string) => warnings.push(m), error() {} };
    const bad = await loadPlugins([fishingPlugin], createPluginRegistry(), { params: { fishing: { baseZone: 5 } }, logger });
    expect(bad.failed).toEqual([]);
    expect(warnings[0]).toContain("plugin fishing の設定が不正");
    warnings.length = 0;
    await loadPlugins([fishingPlugin], createPluginRegistry(), { logger });
    expect(warnings).toEqual([]);
  });
});
