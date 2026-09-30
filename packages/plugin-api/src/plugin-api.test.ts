import { createCtx } from "@rpg/core";
import { loadFixtureProject } from "@rpg/test-utils";
import { describe, expect, it } from "vitest";
import { createPluginRegistry, defineEventTemplate, loadPlugins, selectPlugins, toRuntimeExtensions, z } from "./index.js";
import type { Logger, PluginModule } from "./index.js";

const plugin = (name: string, register: PluginModule["register"] = () => {}, extra: Partial<PluginModule> = {}): PluginModule => ({ name, version: "1.0.0", register, ...extra });
const logs: string[] = [];
const logger: Logger = { debug: () => {}, info: () => {}, warn: (m) => logs.push(m), error: (m) => logs.push(m) };
const empty = z.strictObject({});
const noop = { params: empty, meta: { label: "x", category: "x", describe: () => "x", refs: () => [] }, run: () => ({}) };

describe("loadPlugins", () => {
  it("[inv-3] コマンドの code には plugin:<name>/ が付く。不正な code は失敗", async () => {
    const registry = createPluginRegistry();
    const r = await loadPlugins(
      [plugin("a", (h) => h.commands.add({ ...noop, code: "Do" })), plugin("b", (h) => h.commands.add({ ...noop, code: "bad code" }))],
      registry,
      { logger },
    );
    expect(r.loaded).toEqual(["a"]);
    expect(r.failed.map((f) => f.name)).toEqual(["b"]);
    expect(registry.commands.map((c) => c.code)).toEqual(["plugin:a/Do"]);
    expect(registry.commands.every((c) => c.code.startsWith("plugin:"))).toBe(true);
  });

  it("依存の順に読み込む（dependsOn が先。同じ深さは入力の順）", async () => {
    const order: string[] = [];
    const mk = (name: string, dependsOn?: string[]) => plugin(name, () => void order.push(name), dependsOn === undefined ? {} : { dependsOn });
    const r = await loadPlugins([mk("c", ["b"]), mk("a"), mk("b", ["a"]), mk("d")], createPluginRegistry());
    expect(order).toEqual(["a", "b", "c", "d"]);
    expect(r.loaded).toEqual(order);
  });

  it("循環・存在しない依存・読み込めない依存を持つものは失敗。ほかは続行", async () => {
    const registry = createPluginRegistry();
    const r = await loadPlugins(
      [
        plugin("x", () => {}, { dependsOn: ["y"] }),
        plugin("y", () => {}, { dependsOn: ["x"] }),
        plugin("lonely", () => {}, { dependsOn: ["ghost"] }),
        plugin("broken", () => {
          throw new Error("壊れている");
        }),
        plugin("child", () => {}, { dependsOn: ["broken"] }),
        plugin("fine"),
      ],
      registry,
    );
    expect(r.loaded).toEqual(["fine"]);
    expect(r.failed.map((f) => f.name).sort()).toEqual(["broken", "child", "lonely", "x", "y"]);
    expect(String(r.failed.find((f) => f.name === "broken")?.error)).toContain("壊れている");
    expect(String(r.failed.find((f) => f.name === "x")?.error) + String(r.failed.find((f) => f.name === "y")?.error)).toContain("循環");
  });

  it("名前が不正・重複しているものは失敗（最初のものは読み込まれる）", async () => {
    const r = await loadPlugins([plugin("ok"), plugin("ok"), plugin("has space"), plugin("")], createPluginRegistry());
    expect(r.loaded).toEqual(["ok"]);
    expect(r.failed).toHaveLength(3);
  });

  it("[inv-2] register が失敗したプラグインは何も残さない（途中までの登録もロールバック）。非同期の失敗も同じ", async () => {
    const registry = createPluginRegistry();
    await loadPlugins(
      [
        plugin("half", (h) => {
          h.commands.add({ ...noop, code: "A" });
          h.formulas.addFn("half_fn", () => 1);
          h.battle.setRules({ hitRate: () => 0 });
          h.effects.on("half/e", () => {});
          h.projection.after("map", (f) => f);
          throw new Error("途中で失敗");
        }),
        plugin("late", async (h) => {
          h.commands.add({ ...noop, code: "B" });
          await Promise.resolve();
          throw new Error("あとで失敗");
        }),
      ],
      registry,
    );
    expect(registry.commands).toEqual([]);
    expect(registry.formulas).toEqual([]);
    expect(registry.battleRules).toEqual({});
    expect(registry.effectHandlers.size).toBe(0);
    expect(registry.projectionHooks).toEqual([]);
    expect(registry.loaded).toEqual([]);
  });

  it("衝突する登録（同じコマンド・組み込みと同名の式関数）は、そのプラグインの失敗になり、何も残さない", async () => {
    const registry = createPluginRegistry();
    const r = await loadPlugins(
      [
        plugin("p", (h) => h.commands.add({ ...noop, code: "Same" })),
        plugin("p2", (h) => {
          h.commands.add({ ...noop, code: "Other" });
          h.formulas.addFn("min", () => 0); // 組み込みと衝突
        }),
        plugin("twice", (h) => {
          h.commands.add({ ...noop, code: "Same" });
          h.commands.add({ ...noop, code: "Same" });
        }),
      ],
      registry,
    );
    expect(r.loaded).toEqual(["p"]);
    expect(r.failed.map((f) => f.name).sort()).toEqual(["p2", "twice"]);
    expect(registry.commands.map((c) => c.code)).toEqual(["plugin:p/Same"]);
  });

  it("register が終わったあとに host を使うと例外（ロールバックできなくなるため）", async () => {
    let keep: Parameters<PluginModule["register"]>[0] | undefined;
    await loadPlugins([plugin("late-user", (h) => void (keep = h))], createPluginRegistry());
    expect(() => keep!.commands.add({ ...noop, code: "X" })).toThrow(/register の外/);
    expect(() => keep!.formulas.addFn("f", () => 1)).toThrow();
    expect(() => keep!.battle.setRules({})).toThrow();
    expect(() => keep!.effects.on("e", () => {})).toThrow();
    expect(() => keep!.projection.after("map", (f) => f)).toThrow();
  });

  it("params は system.plugins の設定。host.editor はエディタで読み込んだときだけある", async () => {
    let seen: { params: unknown; editor: boolean } | undefined;
    const p = plugin("cfg", (h) => void (seen = { params: h.params, editor: h.editor !== undefined }));
    await loadPlugins([p], createPluginRegistry(), { params: { cfg: { a: 1 } } });
    expect(seen).toEqual({ params: { a: 1 }, editor: false });
    await loadPlugins([p], createPluginRegistry(), { editor: true });
    expect(seen).toEqual({ params: {}, editor: true });
  });

  it("エディタ向けの登録：フォームの差し替えと診断。登録していないコマンドのフォームは失敗", async () => {
    const registry = createPluginRegistry();
    const Form = () => null;
    const r = await loadPlugins(
      [
        plugin("ed", (h) => {
          h.commands.add({ ...noop, code: "C" });
          h.editor!.commandForm("C", Form);
          h.editor!.diagnostics(() => []);
        }),
        plugin("bad-form", (h) => h.editor!.commandForm("Nope", Form)),
      ],
      registry,
      { editor: true },
    );
    expect(r.loaded).toEqual(["ed"]);
    expect(r.failed.map((f) => f.name)).toEqual(["bad-form"]);
    expect(registry.editor.commandForms.get("plugin:ed/C")).toBe(Form);
    expect(registry.editor.diagnostics).toHaveLength(1);
  });

  it("イベントのひな形：id に plugin:<name>/ が付く。不正な id・二重の登録は失敗し、何も残さない", async () => {
    const registry = createPluginRegistry();
    const template = (id: string) => defineEventTemplate({ id, label: "看板", description: "", input: empty, build: () => ({ name: "看板", pages: [] }) });
    const r = await loadPlugins(
      [
        plugin("tpl", (h) => h.editor!.eventTemplate(template("sign"))),
        plugin("bad-id", (h) => h.editor!.eventTemplate(template("no/slash"))),
        plugin("twice", (h) => {
          h.editor!.eventTemplate(template("a"));
          h.editor!.eventTemplate(template("a"));
        }),
      ],
      registry,
      { editor: true },
    );
    expect(r.loaded).toEqual(["tpl"]);
    expect(r.failed.map((f) => f.name)).toEqual(["bad-id", "twice"]);
    expect(registry.editor.eventTemplates.map((t) => [t.id, t.label])).toEqual([["plugin:tpl/sign", "看板"]]);
    // 同じプラグインを別の登録簿へ読み込み直しても、同じ id になる（エディタを開き直したとき）
    const again = createPluginRegistry();
    await loadPlugins([plugin("tpl", (h) => h.editor!.eventTemplate(template("sign")))], again, { editor: true });
    expect(again.editor.eventTemplates.map((t) => t.id)).toEqual(["plugin:tpl/sign"]);
  });

  it("失敗は logger に警告として出る", async () => {
    logs.length = 0;
    await loadPlugins([plugin("boom", () => Promise.reject(new Error("x")))], createPluginRegistry(), { logger });
    expect(logs.some((l) => l.includes("boom"))).toBe(true);
  });
});

describe("toRuntimeExtensions", () => {
  const { view } = loadFixtureProject("minimal");

  it("setup：コマンド・式関数を Ctx に登録し、戦闘ルールを組み込みの上に重ねる", async () => {
    const registry = createPluginRegistry();
    await loadPlugins(
      [
        plugin("a", (h) => {
          h.commands.add({ ...noop, code: "C" });
          h.formulas.addFn("three", () => 3);
          h.battle.setRules({ escapeRate: () => 1 });
        }),
        plugin("b", (h) => h.battle.setRules({ critRate: () => 0.5 })),
      ],
      registry,
    );
    const ctx = toRuntimeExtensions(registry).setup!(createCtx(view));
    expect(ctx.commands.get("plugin:a/C")).toBeDefined();
    expect(ctx.formulas.has("three")).toBe(true);
    expect(ctx.battleRules?.escapeRate([], [])).toBe(1);
    expect(ctx.battleRules?.critRate(undefined as never, undefined as never, undefined as never)).toBe(0.5);
    expect(ctx.battleRules?.hitRate).toBeDefined(); // 組み込みのまま
  });

  it("[inv-1] 何も登録しないプラグインは、Ctx を変えない", async () => {
    const registry = createPluginRegistry();
    await loadPlugins([plugin("noop")], registry);
    const base = createCtx(view);
    const ctx = toRuntimeExtensions(registry).setup!(base);
    expect(ctx).toBe(base);
    expect(ctx.commands.list().map((c) => c.code)).toEqual(base.commands.list().map((c) => c.code));
  });

  it("onPluginEffect：受け口を読み込み順に呼ぶ。例外は警告にして続ける。受け口が無ければ警告", async () => {
    const registry = createPluginRegistry();
    const seen: string[] = [];
    await loadPlugins(
      [
        plugin("a", (h) => h.effects.on("e", (p) => void seen.push(`a:${String(p)}`))),
        plugin("b", (h) => {
          h.effects.on("e", () => {
            throw new Error("b が失敗");
          });
          h.effects.on("e", (p) => void seen.push(`b2:${String(p)}`));
        }),
      ],
      registry,
    );
    logs.length = 0;
    const ext = toRuntimeExtensions(registry, logger);
    ext.onPluginEffect!({ kind: "plugin", name: "e", payload: 1 }, {} as never);
    expect(seen).toEqual(["a:1", "b2:1"]);
    expect(logs).toHaveLength(1);
    ext.onPluginEffect!({ kind: "plugin", name: "unknown", payload: 1 }, {} as never);
    expect(logs).toHaveLength(2);
  });

  it("afterProject：そのシーンのフックだけを順に適用する。失敗したフックは飛ばす", async () => {
    const registry = createPluginRegistry();
    await loadPlugins(
      [
        plugin("a", (h) => {
          h.projection.after("map", (f) => ({ ...f, ui: [...f.ui, { kind: "text", x: 0, y: 0, text: "a", font: { family: "x", size: 1 }, color: { r: 0, g: 0, b: 0, a: 1 } }] }));
          h.projection.after("title", (f) => ({ ...f, size: { width: 1, height: 1 } }));
        }),
        plugin("b", (h) => {
          h.projection.after("map", () => {
            throw new Error("失敗");
          });
          h.projection.after("map", (f) => ({ ...f, ui: [...f.ui, { kind: "gauge", x: 0, y: 0, w: 1, h: 1, ratio: 1, color: { r: 0, g: 0, b: 0, a: 1 } }] }));
        }),
      ],
      registry,
    );
    logs.length = 0;
    const frame = { size: { width: 320, height: 256 }, camera: { x: 0, y: 0 }, layers: [], overlay: { fade: 0, tint: { r: 0, g: 0, b: 0, a: 0 }, shake: { dx: 0, dy: 0 } }, ui: [] };
    const out = toRuntimeExtensions(registry, logger).afterProject!("map", frame, {} as never);
    expect(out.ui.map((n) => n.kind)).toEqual(["text", "gauge"]);
    expect(out.size).toEqual(frame.size); // title のフックは適用されない
    expect(logs).toHaveLength(1);
  });
});

describe("selectPlugins", () => {
  const catalog = [plugin("a"), plugin("b", () => {}, { dependsOn: ["a"] }), plugin("c", () => {}, { version: "2.0.0" })];

  it("プロジェクトの一覧の順に選び、設定を渡す。書かれていない依存先は足す", () => {
    const s = selectPlugins(catalog, [{ name: "b", version: "1.0.0", params: { k: 1 } }]);
    expect(s.modules.map((m) => m.name)).toEqual(["a", "b"]);
    expect(s.params).toEqual({ b: { k: 1 } });
    expect(s.warnings).toEqual([]);
  });

  it("入っていないプラグインは飛ばして警告。バージョンが違えば警告", () => {
    const s = selectPlugins(catalog, [
      { name: "ghost", version: "1.0.0", params: {} },
      { name: "c", version: "1.0.0", params: {} },
      { name: "c", version: "1.0.0", params: {} },
    ]);
    expect(s.modules.map((m) => m.name)).toEqual(["c"]);
    expect(s.warnings).toHaveLength(3);
    expect(s.warnings[0]).toContain("ghost");
  });

  it("空の一覧なら何も選ばない", () => {
    expect(selectPlugins(catalog, [])).toEqual({ modules: [], params: {}, warnings: [] });
  });
});
