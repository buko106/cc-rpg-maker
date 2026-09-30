import { createPluginRegistry, loadPlugins, selectPlugins, toRuntimeExtensions } from "@rpg/plugin-api";
import type { Logger, PluginModule } from "@rpg/plugin-api";
import { createRuntimeHarness, expandInputs, hashState } from "@rpg/test-utils";
import type { RuntimeHarness } from "@rpg/test-utils";
import { describe, expect, it } from "vitest";
import { customCommandPlugin, hudPlugin, samplePlugins } from "./index.js";

const logs: string[] = [];
const logger: Logger = { debug: () => {}, info: (m) => logs.push(m), warn: (m) => logs.push(`warn:${m}`), error: (m) => logs.push(`error:${m}`) };

/** plugin-demo プロジェクト（v2。hud と custom-command を使う）を、プロジェクトの設定どおりに読み込んで起動する。 */
async function boot(catalog: readonly PluginModule[] = samplePlugins, seed = "plugins"): Promise<RuntimeHarness> {
  const { loadFixtureProject } = await import("@rpg/test-utils");
  const project = loadFixtureProject("plugin-demo", 2).project;
  const selection = selectPlugins(catalog, project.system.plugins);
  const registry = createPluginRegistry();
  const result = await loadPlugins(selection.modules, registry, { logger, params: selection.params });
  expect(result.failed).toEqual([]);
  return createRuntimeHarness({ project: "plugin-demo", projectVersion: 2, seed, extensions: toRuntimeExtensions(registry, logger) });
}

const talk = expandInputs([{ press: "ok" }, { wait: 5 }]);

describe("hud", () => {
  it("マップ画面の UI に所持金を足す（設定のラベルを使う）。所持金が変わると追随する", async () => {
    const h = await boot();
    const texts = (): string[] => h.runtime.project().ui.flatMap((n) => (n.kind === "window" ? n.children.flatMap((c) => (c.kind === "text" ? [c.text] : [])) : []));
    expect(texts()).toEqual(["0 ゴールド"]);
    h.play(...talk); // 箱に話しかけると所持金が増える
    expect(texts()[0]).toBe(`${h.runtime.getState().party.gold} ゴールド`);
    expect(h.runtime.getState().party.gold).toBeGreaterThan(0);
  });

  it("ラベルの既定は G。corner: right なら右上。マップ以外のシーンには出ない", async () => {
    const registry = createPluginRegistry();
    await loadPlugins([hudPlugin], registry, { params: { hud: { corner: "right" } } });
    const h = await createRuntimeHarness({ project: "minimal", title: true, extensions: toRuntimeExtensions(registry) });
    const hudText = (n: { kind: string; children?: readonly { kind: string; text?: string }[] }): boolean => n.kind === "window" && (n.children ?? []).some((c) => c.text === "0 G");
    expect(h.runtime.project().ui.some(hudText)).toBe(false); // タイトルには出ない
    h.play(...expandInputs([{ press: "ok" }, { wait: 3 }]));
    const win = h.runtime.project().ui.find(hudText)!;
    expect(win.kind === "window" && win.x + win.w).toBeLessThanOrEqual(320);
    expect(win.kind === "window" && win.x).toBeGreaterThan(160);
    expect(win.kind === "window" && win.children[0]).toMatchObject({ text: "0 G" });
  });

  it("[inv-1] HUD は FrameSpec を変えるだけで、GameState には触れない", async () => {
    const plain = await createRuntimeHarness({ project: "minimal" });
    const withHud = await createRuntimeHarness({ project: "minimal", extensions: toRuntimeExtensions((await (async () => { const r = createPluginRegistry(); await loadPlugins([hudPlugin], r); return r; })())) });
    const inputs = expandInputs([{ hold: "right", frames: 30 }, { press: "ok" }, { wait: 10 }]);
    plain.play(...inputs);
    withHud.play(...inputs);
    expect(hashState(withHud.runtime.getState())).toBe(hashState(plain.runtime.getState()));
  });
});

describe("custom-command", () => {
  it("独自コマンド・式関数・plugin Effect の受け口・共有の乱数が動く", async () => {
    logs.length = 0;
    const h = await boot();
    h.play(...talk);
    const s = h.runtime.getState();
    expect(s.party.gold).toBeGreaterThanOrEqual(10);
    expect(s.party.gold).toBeLessThanOrEqual(20);
    expect((s.variables as Record<string, number>)["var_twice"]).toBe(42); // 式関数 twice(21)
    const notice = h.effects.find((e) => e.kind === "plugin");
    expect(notice).toMatchObject({ kind: "plugin", name: "custom-command/notice", payload: { gained: s.party.gold } });
    expect(logs).toContain(`所持金が ${s.party.gold} 増えた`); // 受け口がプラグインの host.log に書く
    expect(h.warnings).toEqual([]);
  });

  it("同じシードなら同じ額（リプレイできる）。シードが違えば変わりうる", async () => {
    const gold = async (seed: string): Promise<number> => {
      const h = await boot(samplePlugins, seed);
      h.play(...talk);
      return h.runtime.getState().party.gold;
    };
    expect(await gold("same")).toBe(await gold("same"));
    const golds = new Set(await Promise.all(["a", "b", "c", "d", "e", "f"].map(gold)));
    expect(golds.size).toBeGreaterThan(1);
  });

  it("プラグインを読み込まないと、独自コマンドは警告になって飛ばされる（クラッシュしない）", async () => {
    const h = await createRuntimeHarness({ project: "plugin-demo", projectVersion: 2 });
    h.play(...talk);
    expect(h.runtime.getState().party.gold).toBe(0);
    expect(h.warnings.some((w) => w.includes("plugin:custom-command/RandomGold"))).toBe(true);
    expect(h.errors).toEqual([]);
  });

  it("エディタの診断：min が max より大きい RandomGold を警告する", async () => {
    const registry = createPluginRegistry();
    await loadPlugins([customCommandPlugin], registry, { editor: true });
    const cmd = (min: number, max: number) => ({ code: "plugin:custom-command/RandomGold", params: { min, max }, indent: 0 });
    const doc = {
      project: {} as never,
      maps: { m: { id: "m", events: { e: { id: "e", pages: [{ commands: [cmd(5, 1), cmd(1, 5), { code: "Wait", params: {}, indent: 0 }] }] } } } } as never,
    };
    const found = registry.editor.diagnostics.flatMap((f) => f(doc));
    expect(found).toEqual([expect.objectContaining({ severity: "warning", code: "randomGoldRange", location: { mapId: "m", eventId: "e", page: 0, commandIndex: 0 } })]);
  });
});

describe("custom-command のひな形「くじ引き」", () => {
  it("エディタで読み込むと、ひな形が 1 つ足される。1 回目は RandomGold とセルフスイッチ A、2 回目は別のセリフ", async () => {
    const registry = createPluginRegistry();
    await loadPlugins([customCommandPlugin], registry, { editor: true });
    const [lottery] = registry.editor.eventTemplates;
    expect(lottery?.id).toBe("plugin:custom-command/lottery");
    const input = lottery!.input.parse({ name: "くじ", min: 5, max: 20 });
    const { name, pages } = lottery!.build(input, {} as never);
    expect(name).toBe("くじ");
    expect(pages[0]!.commands.map((c) => c.code)).toEqual(["ShowText", "plugin:custom-command/RandomGold", "ControlSelfSwitch"]);
    expect(pages[0]!.commands[1]!.params).toEqual({ min: 5, max: 20 });
    expect(pages[1]).toMatchObject({ conditions: [{ kind: "selfSwitch", key: "A", value: true }] });
    // ゲームの中（エディタ以外）で読み込んだときは、ひな形は登録されない
    const game = createPluginRegistry();
    await loadPlugins([customCommandPlugin], game);
    expect(game.editor.eventTemplates).toEqual([]);
  });
});

describe("[inv-1] プラグインの有無とリプレイ", () => {
  it("プラグインを 0 個読み込んだ状態と、何も登録しないプラグインを 1 個読み込んだ状態で、同じリプレイが同じ結果になる", async () => {
    const noop: PluginModule = { name: "noop", version: "1.0.0", register: () => {} };
    const registry = createPluginRegistry();
    await loadPlugins([noop], registry);
    const bare = await createRuntimeHarness({ project: "demo" });
    const withNoop = await createRuntimeHarness({ project: "demo", extensions: toRuntimeExtensions(registry) });
    const inputs = expandInputs([{ hold: "right", frames: 40 }, { hold: "down", frames: 40 }, { press: "ok" }, { wait: 30 }, { press: "ok" }, { wait: 30 }]);
    bare.play(...inputs);
    withNoop.play(...inputs);
    expect(hashState(withNoop.runtime.getState())).toBe(hashState(bare.runtime.getState()));
    expect(withNoop.effects).toEqual(bare.effects);
    expect(withNoop.warnings).toEqual(bare.warnings);
  });
});
