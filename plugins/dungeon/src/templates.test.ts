import { createPluginRegistry, loadPlugins } from "@rpg/plugin-api";
import type { PluginDocument } from "@rpg/plugin-api";
import { loadFixtureProject } from "@rpg/test-utils";
import { describe, expect, it } from "vitest";
import { dungeonPlugin } from "./index.js";

const { project, maps } = loadFixtureProject("dungeon", 2);
const params = project.system.plugins[0]!.params;
const doc = (patch: Record<string, unknown> = {}, extra: Partial<PluginDocument> = {}): PluginDocument => ({
  project: { ...project, system: { ...project.system, plugins: [{ name: "dungeon", version: "1.0.0", params: { ...params, ...patch } }] } },
  maps,
  ...extra,
});

async function editorRegistry() {
  const registry = createPluginRegistry();
  const r = await loadPlugins([dungeonPlugin], registry, { editor: true });
  expect(r.failed).toEqual([]);
  return registry;
}

describe("エディタ：ひな形", () => {
  it("「ダンジョンの入口」「ダンジョンのコントローラ」が足される（ゲームの中では足されない）", async () => {
    const registry = await editorRegistry();
    expect(registry.editor.eventTemplates.map((t) => t.id)).toEqual(["plugin:dungeon/entrance", "plugin:dungeon/controller"]);
    const game = createPluginRegistry();
    await loadPlugins([dungeonPlugin], game);
    expect(game.editor.eventTemplates).toEqual([]);
  });

  it("入口：セリフを 1 つずつの文章にして、最後に Enter を呼ぶ", async () => {
    const [entrance] = (await editorRegistry()).editor.eventTemplates;
    const input = entrance!.input.parse({ name: "洞窟", message: "暗い穴だ。\n\n入ってみよう。" });
    const { name, pages } = entrance!.build(input, project);
    expect(name).toBe("洞窟");
    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({ trigger: "action", priority: "same" });
    expect(pages[0]!.commands.map((c) => c.code)).toEqual(["ShowText", "ShowText", "plugin:dungeon/Enter"]);
  });

  it("コントローラ：3 ページ（毎フレーム Tick / 倒れた / 宝）。ページの条件は、設定のイベント用の変数を見る", async () => {
    const [, controller] = (await editorRegistry()).editor.eventTemplates;
    const input = controller!.input.parse({ name: "c", dead: "やられた。", clear: "やった！" });
    const { pages } = controller!.build(input, project);
    expect(pages.map((p) => p.trigger)).toEqual(["parallel", "autorun", "autorun"]);
    expect(pages[0]!.commands.map((c) => c.code)).toEqual(["plugin:dungeon/Tick"]);
    expect(pages[1]).toMatchObject({ conditions: [{ kind: "variable", id: "var_dungeon_event", op: "==", value: 1 }] });
    expect(pages[1]!.commands.at(-1)).toMatchObject({ code: "plugin:dungeon/Finish", params: { result: "dead" } });
    expect(pages[2]!.commands.at(-1)).toMatchObject({ code: "plugin:dungeon/Finish", params: { result: "clear" } });
    // 変数名を変えた設定ならそれを使う。設定が無いプロジェクトでは既定の名前
    const renamed = { ...project, system: { ...project.system, plugins: [{ name: "dungeon", version: "1", params: { ...params, vars: { event: "var_evt" } } }] } };
    expect(controller!.build(input, renamed).pages[1]).toMatchObject({ conditions: [{ id: "var_evt" }] });
    const none = { ...project, system: { ...project.system, plugins: [] } };
    expect(controller!.build(input, none).pages[1]).toMatchObject({ conditions: [{ id: "var_dungeon_event" }] });
  });

  it("ひな形で作ったコマンドは、実際に登録されているコマンドと、検証を通る形", async () => {
    const registry = await editorRegistry();
    for (const code of ["plugin:dungeon/Enter", "plugin:dungeon/Tick", "plugin:dungeon/Finish"]) expect(registry.commands.map((c) => c.code)).toContain(code);
    const finish = registry.commands.find((c) => c.code === "plugin:dungeon/Finish")!;
    expect(finish.params.safeParse({ result: "dead" }).success).toBe(true);
    expect(finish.params.safeParse({ result: "x" }).success).toBe(false);
    expect(finish.meta.describe({ result: "clear" }, {} as never)).toContain("宝");
    expect(finish.meta.describe({ result: "dead" }, {} as never)).toContain("失う");
    for (const code of ["plugin:dungeon/Enter", "plugin:dungeon/Tick"]) {
      const c = registry.commands.find((x) => x.code === code)!;
      expect(c.meta.describe({}, {} as never)).not.toBe("");
      expect(c.meta.refs({})).toEqual([]);
    }
  });
});

describe("エディタ：診断", () => {
  it("デモのプロジェクトは、診断なし。プラグインを使っていないプロジェクトも何も言わない", async () => {
    const [diag] = (await editorRegistry()).editor.diagnostics;
    expect(diag!(doc())).toEqual([]);
    expect(diag!({ project: { ...project, system: { ...project.system, plugins: [] } }, maps })).toEqual([]);
  });

  it("設定が不正・ひな形のマップが無い・大きさが違う・コントローラが無い・敵やアイテムがデータベースに無い、を知らせる", async () => {
    const [diag] = (await editorRegistry()).editor.diagnostics;
    expect(diag!(doc({ goalFloor: 0 }))).toEqual([expect.objectContaining({ severity: "error", code: "dungeonConfig" })]);
    expect(diag!(doc({ floorMap: "map_none" }))).toEqual([expect.objectContaining({ code: "dungeonFloorMap" })]);
    expect(diag!(doc({ width: 40 }))).toEqual([expect.objectContaining({ code: "dungeonFloorSize", message: expect.stringContaining("39×27") })]);
    const noController = { ...maps, map_floor: { ...maps["map_floor" as never], events: {} } } as PluginDocument["maps"];
    expect(diag!(doc({}, { maps: noController }))).toEqual([expect.objectContaining({ severity: "warning", code: "dungeonNoController" })]);
    const enemies = [...(params["enemies"] as object[]), { enemy: "enemy_ghost", sprite: { sx: 0, sy: 0 } }];
    expect(diag!(doc({ enemies }))).toEqual([expect.objectContaining({ code: "dungeonEnemy", message: expect.stringContaining("enemy_ghost") })]);
    const items = [...(params["items"] as object[]), { kind: "item", key: "x", item: "item_ghost", sprite: { sx: 0, sy: 0 } }];
    expect(diag!(doc({ items }))).toEqual([expect.objectContaining({ code: "dungeonItem" })]);
  });
});

describe("プラグインの読み込み", () => {
  it("設定なしでも読み込める（エディタ）。不正な設定は警告を出すが、読み込みは成功する", async () => {
    const warnings: string[] = [];
    const logger = { debug() {}, info() {}, warn: (m: string) => warnings.push(m), error() {} };
    const bad = await loadPlugins([dungeonPlugin], createPluginRegistry(), { params: { dungeon: { width: 5 } }, logger });
    expect(bad.failed).toEqual([]);
    expect(warnings[0]).toContain("plugin dungeon の設定が不正");
    warnings.length = 0;
    await loadPlugins([dungeonPlugin], createPluginRegistry(), { logger });
    expect(warnings).toEqual([]);
  });
});
