// @vitest-environment jsdom
import { createCommandRegistry, createProjectView, registerBuiltins } from "@rpg/core";
import { actorSchema, classSchema, commonEventSchema, enemySchema, itemSchema, skillSchema, stateSchema, systemSettingsSchema, troopSchema } from "@rpg/schema";
import { loadFixtureProject } from "@rpg/test-utils";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { describeSchema } from "./introspect.js";
import { SchemaForm } from "./SchemaForm.js";
import type { FormContext } from "./SchemaForm.js";
import { defaultValue, matchOption } from "./values.js";

afterEach(cleanup);

const { project } = loadFixtureProject("demo");
const refOptions: FormContext["refOptions"] = (ref) => {
  const tables: Record<string, Record<string, { name?: string }>> = {
    actor: project.database.actors,
    class: project.database.classes,
    skill: project.database.skills,
    item: project.database.items,
    enemy: project.database.enemies,
    troop: project.database.troops,
    state: project.database.states,
    commonEvent: { ce_a: { name: "A" }, ...project.database.commonEvents },
    map: project.maps,
    tileset: project.tilesets,
    switch: { sw_a: { name: "A" } },
    variable: { v_a: { name: "V" } },
    asset: project.assets.entries,
  };
  return Object.entries(tables[ref] ?? {}).map(([value, e]) => ({ value, label: e.name ?? value }));
};
const ctx: FormContext = { refOptions, checkFormula: (s) => (s.includes("!!") ? "構文エラー" : undefined) };

function Harness({ schema, initial, onValue, context = ctx }: { schema: z.ZodType; initial?: unknown; onValue?: (v: unknown) => void; context?: FormContext }) {
  const spec = describeSchema(schema);
  const [value, setValue] = useState<unknown>(initial ?? defaultValue(spec, refOptions));
  return <SchemaForm spec={spec} value={value} ctx={context} label="" onChange={(v) => { setValue(v); onValue?.(v); }} />;
}

describe("describeSchema", () => {
  it("型・メタデータ・範囲を読む", () => {
    const schema = z.strictObject({
      id: z.string().meta({ ref: "actor" }),
      text: z.string().meta({ multiline: true }),
      n: z.number().int().min(1).max(9),
      f: z.number(),
      opt: z.boolean().optional(),
      def: z.enum(["a", "b"]).default("a"),
      list: z.array(z.string()).min(2),
      rec: z.record(z.enum(["x", "y"]), z.number()),
      part: z.partialRecord(z.enum(["x", "y"]), z.number()),
      free: z.record(z.string(), z.number()),
      u: z.union([z.string().meta({ formula: true }), z.strictObject({ kind: z.literal("k"), v: z.number() })]),
      d: z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("p") })]),
      any: z.custom<number>(() => true),
    });
    const spec = describeSchema(schema);
    if (spec.kind !== "object") throw new Error("object のはず");
    const byKey = Object.fromEntries(spec.fields.map((f) => [f.key, f]));
    expect(byKey["id"]?.spec).toEqual({ kind: "string", ref: "actor" });
    expect(byKey["text"]?.spec).toEqual({ kind: "string", multiline: true });
    expect(byKey["n"]?.spec).toEqual({ kind: "number", int: true, min: 1, max: 9 });
    expect(byKey["f"]?.spec).toEqual({ kind: "number", int: false });
    expect(byKey["opt"]).toMatchObject({ optional: true, hasDefault: false, spec: { kind: "boolean" } });
    expect(byKey["def"]).toMatchObject({ optional: false, hasDefault: true, default: "a", spec: { kind: "enum", values: ["a", "b"] } });
    expect(byKey["list"]?.spec).toMatchObject({ kind: "array", min: 2 });
    expect(byKey["rec"]?.spec).toMatchObject({ kind: "record", partial: false });
    expect(byKey["part"]?.spec).toMatchObject({ kind: "record", partial: true });
    expect(byKey["free"]?.spec).toMatchObject({ kind: "record", key: { kind: "string" } });
    expect(byKey["u"]?.spec).toMatchObject({ kind: "union", options: [{ kind: "string", formula: true }, { kind: "object" }] });
    expect(byKey["d"]?.spec).toMatchObject({ kind: "union", discriminator: "kind" });
    expect(byKey["any"]?.spec).toEqual({ kind: "unknown" });
  });

  it("エディタ向けのメタデータ：列挙の表示名（labels）と、新しく作るときの初期値（initial）", () => {
    const schema = z.strictObject({
      op: z.enum(["set", "add"]).meta({ labels: { set: "代入", add: "加算" } }),
      on: z.boolean().meta({ initial: true }),
      wrapped: z.array(z.string()).min(1).meta({ initial: ["はい"] }).optional(),
    });
    const spec = describeSchema(schema);
    if (spec.kind !== "object") throw new Error("object のはず");
    const byKey = Object.fromEntries(spec.fields.map((f) => [f.key, f]));
    expect(byKey["op"]?.spec).toEqual({ kind: "enum", values: ["set", "add"], labels: { set: "代入", add: "加算" } });
    expect(byKey["on"]).toMatchObject({ initial: true, spec: { kind: "boolean" } });
    expect(byKey["wrapped"]).toMatchObject({ optional: true, initial: ["はい"] });
  });

  it("見出し（title）・補足（description）は、皮（optional / default）の外と中のどちらに付けても読む", () => {
    const schema = z.strictObject({
      a: z.string().meta({ title: "見出し A", description: "補足 A" }),
      b: z.string().meta({ title: "中" }).optional(),
      c: z.boolean().default(true).meta({ title: "外" }),
    });
    const spec = describeSchema(schema);
    if (spec.kind !== "object") throw new Error("object のはず");
    expect(spec.fields.map((f) => [f.key, f.title, f.description])).toEqual([
      ["a", "見出し A", "補足 A"],
      ["b", "中", undefined],
      ["c", "外", undefined],
    ]);
  });

  it("マップと位置の欄（location）：true なら mapId / x / y、オブジェクトならその名前。フィールドが無ければ付けない", () => {
    const xy = { x: z.number(), y: z.number() };
    expect(describeSchema(z.strictObject({ mapId: z.string(), ...xy }).meta({ location: true }))).toMatchObject({ location: { map: "mapId", x: "x", y: "y" } });
    expect(describeSchema(systemSettingsSchema)).toMatchObject({ location: { map: "startMap", x: "startX", y: "startY" } });
    expect(describeSchema(z.strictObject({ ...xy }).meta({ location: true }))).not.toHaveProperty("location");
    const transfer = createCommandRegistry();
    registerBuiltins(transfer);
    expect(describeSchema(transfer.get("TransferPlayer")!.params)).toMatchObject({ location: { map: "mapId", x: "x", y: "y" } });
  });

  it("リテラルと列挙だけのユニオンは、1 つの選択肢の一覧にまとめる", () => {
    expect(describeSchema(z.union([z.enum(["down", "up"]), z.literal("retain")]))).toEqual({ kind: "choice", values: ["down", "up", "retain"] });
    expect(describeSchema(z.union([z.enum(["down", "up"]), z.enum(["random"])]))).toEqual({ kind: "choice", values: ["down", "up", "random"] });
  });
});

describe("defaultValue / matchOption", () => {
  it("必須のものだけを埋め、配列は最小の長さぶん、ID は先頭の選択肢", () => {
    const schema = z.strictObject({ a: z.string().meta({ ref: "actor" }), b: z.array(z.number().min(2)).min(2), c: z.boolean().optional(), d: z.enum(["x", "y"]), e: z.record(z.enum(["p", "q"]), z.number()) });
    expect(defaultValue(describeSchema(schema), refOptions)).toEqual({ a: "actor_hero", b: [2, 2], d: "x", e: { p: 0, q: 0 } });
    expect(defaultValue({ kind: "string", ref: "switch" }, () => [])).toBe("");
    expect(defaultValue({ kind: "unknown" }, refOptions)).toBeUndefined();
    // .default() の値は、列挙の先頭より優先される
    const withDefault = z.strictObject({ p: z.enum(["top", "bottom"]).default("bottom"), q: z.number().default(7) });
    expect(defaultValue(describeSchema(withDefault), refOptions)).toEqual({ p: "bottom", q: 7 });
    // メタデータの initial は .default() や型ごとの既定より優先され、毎回別の値（複製）になる
    const withInitial = z.strictObject({ on: z.boolean().meta({ initial: true }), choices: z.array(z.string()).min(1).meta({ initial: ["はい", "いいえ"] }), p: z.enum(["a", "b"]).default("a").meta({ initial: "b" }) });
    const first = defaultValue(describeSchema(withInitial), refOptions) as { choices: string[] };
    expect(first).toEqual({ on: true, choices: ["はい", "いいえ"], p: "b" });
    first.choices.push("x");
    expect(defaultValue(describeSchema(withInitial), refOptions)).toMatchObject({ choices: ["はい", "いいえ"] });
    const deep: z.ZodType = z.lazy(() => z.strictObject({ next: deep }));
    expect(defaultValue(describeSchema(deep), refOptions)).toBeUndefined(); // lazy は unknown
  });

  it("union の選択肢を値の形から決める", () => {
    const spec = describeSchema(z.union([z.string(), z.strictObject({ kind: z.literal("a") }), z.strictObject({ kind: z.literal("b") })]));
    if (spec.kind !== "union") throw new Error();
    expect([matchOption(spec.options, "x"), matchOption(spec.options, { kind: "a" }), matchOption(spec.options, { kind: "b" }), matchOption(spec.options, 5)]).toEqual([0, 1, 2, 0]);
  });
});

describe("組み込みコマンドのフォーム", () => {
  const registry = createCommandRegistry();
  registerBuiltins(registry);
  createProjectView(project, {});

  for (const handler of registry.list()) {
    it(`${handler.code}：描画でき、既定値が params の zod を通る`, () => {
      const spec = describeSchema(handler.params);
      const initial = defaultValue(spec, refOptions);
      const parsed = handler.params.safeParse(initial);
      expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues)).toBe(true);
      const { container } = render(<Harness schema={handler.params} initial={parsed.success ? parsed.data : initial} />);
      expect(container.querySelector(".schema-form")).not.toBeNull();
      cleanup();
    });
  }
});

describe("データベースとシステムのフォーム", () => {
  const schemas = { actorSchema, classSchema, skillSchema, itemSchema, enemySchema, troopSchema, stateSchema, commonEventSchema, systemSettingsSchema };
  for (const [name, schema] of Object.entries(schemas)) {
    it(`${name}：既存データの描画でクラッシュしない`, () => {
      const table = { actorSchema: project.database.actors, classSchema: project.database.classes, skillSchema: project.database.skills, itemSchema: project.database.items, enemySchema: project.database.enemies, troopSchema: project.database.troops }[name as string];
      const sample = table === undefined ? (name === "systemSettingsSchema" ? project.system : defaultValue(describeSchema(schema as never), refOptions)) : Object.values(table)[0];
      render(<Harness schema={schema as never} initial={sample} />);
      cleanup();
    });
  }
});

describe("システムの速さの設定", () => {
  it("歩く速さ・走る機能・状態による変化（スイッチや変数の条件つき）を編集できる", () => {
    let last: unknown;
    render(<Harness schema={systemSettingsSchema} initial={project.system} onValue={(v) => (last = v)} />);
    const get = () => last as { walkSpeed?: number; dash?: { bonus?: number }; speedRules?: { when: unknown[]; speed?: number; noDash?: boolean }[] };

    fireEvent.click(screen.getByLabelText(/^歩く速さ.*を設定$/));
    expect(get().walkSpeed).toBe(1);
    fireEvent.change(screen.getByRole("spinbutton", { name: /^歩く速さ（/ }), { target: { value: "3" } });
    expect(get().walkSpeed).toBe(3);

    fireEvent.click(screen.getByLabelText(/^走る機能.*を設定$/));
    expect(get().dash).toEqual({});
    fireEvent.click(screen.getByLabelText(/^走る機能.* 走ると速くなる段階.*を設定$/));
    expect(get().dash).toEqual({ bonus: 1 });

    fireEvent.click(screen.getByLabelText("状態による歩く速さの変化を設定"));
    expect(get().speedRules).toEqual([]);
    fireEvent.click(screen.getByText("＋ 状態による歩く速さの変化を追加"));
    expect(get().speedRules).toEqual([{ when: [] }]);
    // ルールに条件を足す：スイッチ（空腹の印）か変数（満腹度）かを選び、速さを遅くして、走れなくもする
    fireEvent.click(screen.getByText(/^＋ 状態による歩く速さの変化 1 条件.*を追加$/));
    expect(get().speedRules?.[0]?.when).toEqual([{ kind: "switch", id: "sw_a", value: true }]);
    fireEvent.change(screen.getByLabelText(/^状態による歩く速さの変化 1 条件.* 1の種類$/), { target: { value: "1" } });
    expect(get().speedRules?.[0]?.when).toMatchObject([{ kind: "variable" }]);
    fireEvent.click(screen.getByLabelText(/^状態による歩く速さの変化 1 歩く速さの増減.*を設定$/));
    fireEvent.change(screen.getByRole("spinbutton", { name: /^状態による歩く速さの変化 1 歩く速さの増減/ }), { target: { value: "-1" } });
    fireEvent.click(screen.getByLabelText("状態による歩く速さの変化 1 走れなくするを設定"));
    expect(get().speedRules?.[0]).toMatchObject({ speed: -1, noDash: false });
  });

  it("速さの設定のスキーマ：範囲外の値と、セルフスイッチの条件は受け付けない", () => {
    const ok = { ...project.system, walkSpeed: 3, dash: { bonus: 2 }, speedRules: [{ when: [{ kind: "variable", id: "v", op: "<=", value: 10 }], speed: -1, noDash: true }] };
    expect(systemSettingsSchema.safeParse(ok).success).toBe(true);
    expect(systemSettingsSchema.safeParse({ ...ok, walkSpeed: 7 }).success).toBe(false);
    expect(systemSettingsSchema.safeParse({ ...ok, walkSpeed: 0 }).success).toBe(false);
    expect(systemSettingsSchema.safeParse({ ...ok, dash: { bonus: 4 } }).success).toBe(false);
    expect(systemSettingsSchema.safeParse({ ...ok, speedRules: [{ when: [{ kind: "selfSwitch", key: "A", value: true }], speed: 1 }] }).success).toBe(false);
    expect(systemSettingsSchema.safeParse({ ...ok, speedRules: [{ when: [], speed: 6 }] }).success).toBe(false);
  });
});

describe("ウィジェット", () => {
  it("文字列・数値・真偽・列挙を編集できる（数値は空欄で NaN）", () => {
    let last: unknown;
    render(<Harness schema={z.strictObject({ s: z.string(), n: z.number(), flag: z.boolean(), e: z.enum(["top", "bottom"]) })} onValue={(v) => (last = v)} />);
    fireEvent.change(screen.getByLabelText("s"), { target: { value: "hi" } });
    fireEvent.change(screen.getByLabelText("n"), { target: { value: "12" } });
    fireEvent.click(screen.getByLabelText("flag"));
    fireEvent.change(screen.getByLabelText("e"), { target: { value: "bottom" } });
    expect(last).toEqual({ s: "hi", n: 12, flag: true, e: "bottom" });
    fireEvent.change(screen.getByLabelText("n"), { target: { value: "" } });
    expect(last).toMatchObject({ n: Number.NaN });
  });

  it("ID 欄は選択肢から選び、存在しない ID はそのまま見える", () => {
    let last: unknown;
    render(<Harness schema={z.strictObject({ actor: z.string().meta({ ref: "actor" }) })} initial={{ actor: "gone" }} onValue={(v) => (last = v)} />);
    const select = screen.getByLabelText("アクター") as HTMLSelectElement;
    expect(select.value).toBe("gone");
    expect(within(select).getByText("gone（存在しない）")).toBeTruthy();
    fireEvent.change(select, { target: { value: "actor_hero" } });
    expect(last).toEqual({ actor: "actor_hero" });
  });

  it("式の欄はリアルタイムに文法エラーを出す", () => {
    render(<Harness schema={z.strictObject({ f: z.string().meta({ formula: true }) })} initial={{ f: "" }} />);
    fireEvent.change(screen.getByLabelText("f"), { target: { value: "a!!b" } });
    expect(screen.getByRole("alert").textContent).toContain("構文エラー");
    fireEvent.change(screen.getByLabelText("f"), { target: { value: "a+b" } });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("リテラルだけのユニオンは選択肢から選ぶ（数値のまま入る）", () => {
    let last: unknown;
    render(<Harness schema={z.strictObject({ size: z.union([z.literal(16), z.literal(32), z.literal("big")]) })} initial={{ size: 32 }} onValue={(v) => (last = v)} />);
    expect((screen.getByLabelText("size") as HTMLSelectElement).value).toBe("1");
    fireEvent.change(screen.getByLabelText("size"), { target: { value: "0" } });
    expect(last).toEqual({ size: 16 });
    fireEvent.change(screen.getByLabelText("size"), { target: { value: "2" } });
    expect(last).toEqual({ size: "big" });
    expect(defaultValue(describeSchema(z.union([z.literal(1), z.literal(2)])), refOptions)).toBe(1);
    const spec = describeSchema(z.union([z.literal(1), z.literal(2)]));
    if (spec.kind !== "choice") throw new Error();
    expect(matchOption([spec, { kind: "string" }], "x")).toBe(1);
    expect(matchOption([spec, { kind: "string" }], 2)).toBe(0);
  });

  it("配列：追加・削除（最小数は残す）・並べ替え", () => {
    let last: unknown;
    render(<Harness schema={z.strictObject({ xs: z.array(z.string()).min(1) })} initial={{ xs: ["a", "b"] }} onValue={(v) => (last = v)} />);
    fireEvent.click(screen.getByText("＋ xsを追加"));
    expect(last).toEqual({ xs: ["a", "b", ""] });
    fireEvent.click(screen.getByLabelText("xs 1 を下へ"));
    expect(last).toEqual({ xs: ["b", "a", ""] });
    fireEvent.click(screen.getByLabelText("xs 3 を削除"));
    fireEvent.click(screen.getByLabelText("xs 2 を削除"));
    expect(last).toEqual({ xs: ["b"] });
    expect((screen.getByLabelText("xs 1 を削除") as HTMLButtonElement).disabled).toBe(true); // 最小数
    expect((screen.getByLabelText("xs 1 を上へ") as HTMLButtonElement).disabled).toBe(true);
  });

  it("optional：チェックで有効にすると既定値が入り、外すと消える", () => {
    let last: unknown;
    render(<Harness schema={z.strictObject({ o: z.strictObject({ n: z.number() }).optional() })} onValue={(v) => (last = v)} />);
    fireEvent.click(screen.getByLabelText("oを設定"));
    expect(last).toEqual({ o: { n: 0 } });
    fireEvent.click(screen.getByLabelText("oを設定"));
    expect(last).toEqual({});
  });

  it("record：enum キーの固定行（partial は有無を選ぶ）と、自由なキーの追加・削除", () => {
    let last: unknown;
    render(
      <Harness
        schema={z.strictObject({ full: z.record(z.enum(["x", "y"]), z.number()), part: z.partialRecord(z.enum(["x", "y"]), z.number()), free: z.record(z.string(), z.number()) })}
        onValue={(v) => (last = v)}
      />,
    );
    fireEvent.change(screen.getByLabelText("full X"), { target: { value: "3" } });
    expect(last).toMatchObject({ full: { x: 3, y: 0 }, part: {}, free: {} });
    fireEvent.click(screen.getByLabelText("part Xを設定"));
    expect(last).toMatchObject({ part: { x: 0 } });
    fireEvent.click(screen.getByLabelText("part Xを設定"));
    expect(last).toMatchObject({ part: {} });

    const input = screen.getByLabelText("freeの新しいキー");
    fireEvent.change(input, { target: { value: "k1" } });
    fireEvent.submit(input.closest("form")!);
    expect(last).toMatchObject({ free: { k1: 0 } });
    fireEvent.change(input, { target: { value: "k1" } }); // 重複は無視
    fireEvent.submit(input.closest("form")!);
    fireEvent.change(screen.getByLabelText("free k1"), { target: { value: "5" } });
    expect(last).toMatchObject({ free: { k1: 5 } });
    fireEvent.click(screen.getByLabelText("free k1 を削除"));
    expect(last).toMatchObject({ free: {} });
  });

  it("union：種類を切り替えると、その種類の既定値になる", () => {
    let last: unknown;
    render(
      <Harness
        schema={z.strictObject({ c: z.union([z.string(), z.strictObject({ kind: z.literal("switch"), on: z.boolean() }), z.strictObject({ kind: z.literal("variable"), n: z.number() })]) })}
        initial={{ c: "a > b" }}
        onValue={(v) => (last = v)}
      />,
    );
    fireEvent.change(screen.getByLabelText("cの種類"), { target: { value: "2" } });
    expect(last).toEqual({ c: { kind: "variable", n: 0 } });
    expect(screen.getByLabelText("c n")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("cの種類"), { target: { value: "0" } });
    expect(last).toEqual({ c: "" });
  });

  it("列挙はスキーマの labels、なければ共通の表示名で出す", () => {
    render(<Harness schema={z.strictObject({ op: z.enum(["set", "top"]).meta({ labels: { set: "代入（＝）" } }) })} />);
    const select = screen.getByLabelText("演算") as HTMLSelectElement;
    expect([...select.options].map((o) => o.text)).toEqual(["代入（＝）", "上"]);
  });

  it("union の種類の見出し：リテラルはその表示名、ID は種類の名前、ただの文字列は「直接入力」", () => {
    render(<Harness schema={z.strictObject({ target: z.union([z.literal("party"), z.string().meta({ ref: "actor" }), z.string(), z.number()]) })} initial={{ target: "party" }} />);
    const kinds = screen.getByLabelText("対象の種類") as HTMLSelectElement;
    expect([...kinds.options].map((o) => o.text)).toEqual(["パーティ全員", "アクター", "直接入力", "数値"]);
  });

  it("ID 欄は、最近選んだ ID を「最近使った」の見出しで先頭に出し、選んだときに記録を頼む（今は無い ID は出さない）", () => {
    const picked: [string, string][] = [];
    const withRecent: FormContext = { ...ctx, recentRefs: () => ["v_b", "gone", "v_a"], onPickRef: (ref, id) => picked.push([ref, id]) };
    const options: FormContext["refOptions"] = (ref) => (ref === "variable" ? [{ value: "v_a", label: "A" }, { value: "v_b", label: "B" }, { value: "v_c", label: "C" }] : []);
    render(<Harness schema={z.strictObject({ id: z.string().meta({ ref: "variable" }) })} initial={{ id: "v_c" }} context={{ ...withRecent, refOptions: options }} />);
    const select = screen.getByLabelText("ID") as HTMLSelectElement;
    const group = select.querySelector("optgroup");
    expect(group?.label).toBe("最近使った");
    expect([...group!.querySelectorAll("option")].map((o) => o.text)).toEqual(["B", "A"]);
    fireEvent.change(select, { target: { value: "v_a" } });
    expect(picked).toEqual([["variable", "v_a"]]);
  });

  describe("ID 欄でその場で作る（newRef）", () => {
    const created: string[] = [];
    const withNewRef: FormContext = {
      ...ctx,
      newRef: (ref) => (ref === "switch" ? { noun: "スイッチ", create: (name) => (name === "失敗" ? undefined : (created.push(name), `sw_${created.length}`)) } : undefined),
    };

    it("「＋ 新しいスイッチ…」を選ぶと名前の欄が出て、作ったものが選ばれる", () => {
      created.length = 0;
      let last: unknown;
      render(<Harness schema={z.strictObject({ id: z.string().meta({ ref: "switch" }) })} initial={{ id: "" }} context={withNewRef} onValue={(v) => (last = v)} />);
      const select = screen.getByLabelText("ID") as HTMLSelectElement;
      expect([...select.options].map((o) => o.text)).toEqual(["（選択してください）", "A", "＋ 新しいスイッチ…"]);
      fireEvent.change(select, { target: { value: ":new" } });
      expect(last).toBeUndefined(); // 選んだだけでは値は変わらない
      const name = screen.getByLabelText("新しいスイッチの名前");
      expect(document.activeElement).toBe(name);
      fireEvent.change(name, { target: { value: "  扉を開けた " } });
      fireEvent.submit(name.closest("form")!);
      expect(created).toEqual(["扉を開けた"]);
      expect(last).toEqual({ id: "sw_1" });
      expect(screen.queryByLabelText("新しいスイッチの名前")).toBeNull();
    });

    it("作れなかったら欄は残る。Esc や「やめる」で閉じ、値は変わらない。作れない種類には出さない", () => {
      created.length = 0;
      let last: unknown;
      render(<Harness schema={z.strictObject({ id: z.string().meta({ ref: "switch" }), actor: z.string().meta({ ref: "actor" }) })} initial={{ id: "sw_a", actor: "actor_hero" }} context={withNewRef} onValue={(v) => (last = v)} />);
      fireEvent.change(screen.getByLabelText("ID"), { target: { value: ":new" } });
      fireEvent.change(screen.getByLabelText("新しいスイッチの名前"), { target: { value: "失敗" } });
      fireEvent.click(screen.getByRole("button", { name: "作成" }));
      expect(screen.getByLabelText("新しいスイッチの名前")).toBeTruthy();
      fireEvent.keyDown(screen.getByLabelText("新しいスイッチの名前"), { key: "Escape" });
      expect(screen.queryByLabelText("新しいスイッチの名前")).toBeNull();
      fireEvent.change(screen.getByLabelText("ID"), { target: { value: ":new" } });
      fireEvent.click(screen.getByRole("button", { name: "やめる" }));
      expect(screen.queryByLabelText("新しいスイッチの名前")).toBeNull();
      expect(last).toBeUndefined();
      expect([...(screen.getByLabelText("アクター") as HTMLSelectElement).options].map((o) => o.text)).not.toContain("＋ 新しいアクター…");
    });
  });

  it("見出しはメタデータの title（無ければ共通の表示名）。補足は欄の近くに出る", () => {
    render(<Harness schema={z.strictObject({ name: z.string().meta({ title: "イベント名", description: "マップに出る名前" }), text: z.string() })} />);
    expect(screen.getByLabelText("イベント名")).toBeTruthy();
    expect(screen.getByLabelText("本文")).toBeTruthy();
    expect(screen.getByText("マップに出る名前")).toBeTruthy();
  });

  it("選択肢が 1 つも無い ID 欄には、どこで作れるかを出す（その場で作れる種類には出さない）", () => {
    const none: FormContext = { refOptions: () => [] };
    render(<Harness schema={z.strictObject({ item: z.string().meta({ ref: "item" }), map: z.string().meta({ ref: "map" }) })} context={none} />);
    expect(screen.getByText("まだアイテムがありません（メニューの「データベース」で追加できます）")).toBeTruthy();
    expect(screen.getByText("まだマップがありません（左のマップの一覧で追加できます）")).toBeTruthy();
    cleanup();
    render(<Harness schema={z.strictObject({ sw: z.string().meta({ ref: "switch" }) })} context={{ ...none, newRef: () => ({ noun: "スイッチ", create: () => undefined }) }} />);
    expect(screen.queryByText(/まだスイッチがありません/)).toBeNull();
  });

  it("マップと位置の欄：マップが選ばれていれば、位置の欄の後ろに renderLocation の部品が付き、選んだ位置が x / y に入る", () => {
    let last: unknown;
    const seen: unknown[] = [];
    const context: FormContext = {
      refOptions,
      renderLocation: (p) => {
        seen.push({ mapId: p.mapId, x: p.x, y: p.y, label: p.label });
        return (
          <button type="button" onClick={() => p.onPick(7, 8)}>
            位置を選ぶ
          </button>
        );
      },
    };
    const schema = z.strictObject({ to: z.strictObject({ mapId: z.string().meta({ ref: "map" }), x: z.number(), y: z.number() }).meta({ title: "移動先", location: true }), after: z.string() });
    render(<Harness schema={schema} initial={{ to: { mapId: "map_town", x: 1, y: 2 }, after: "" }} context={context} onValue={(v) => (last = v)} />);
    expect(seen.at(-1)).toEqual({ mapId: "map_town", x: 1, y: 2, label: "移動先" });
    // 部品は Y の欄の後ろ、次のフィールドの前
    const picker = screen.getByRole("button", { name: "位置を選ぶ" });
    expect(screen.getByLabelText("移動先 Y").compareDocumentPosition(picker) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(picker.compareDocumentPosition(screen.getByLabelText("after")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(picker);
    expect(last).toEqual({ to: { mapId: "map_town", x: 7, y: 8 }, after: "" });
    cleanup();
    // マップが未選択なら出さない。renderLocation が無ければ数値の欄だけ
    render(<Harness schema={schema} initial={{ to: { mapId: "", x: 0, y: 0 }, after: "" }} context={context} />);
    expect(screen.queryByRole("button", { name: "位置を選ぶ" })).toBeNull();
    cleanup();
    render(<Harness schema={schema} initial={{ to: { mapId: "map_town", x: 0, y: 0 }, after: "" }} />);
    expect(screen.getByLabelText("移動先 X")).toBeTruthy();
  });

  it("unknown な型は JSON で編集できる（壊れた JSON は無視）", () => {
    let last: unknown;
    render(<Harness schema={z.strictObject({ zz: z.custom<unknown>(() => true) })} initial={{ zz: { a: 1 } }} onValue={(v) => (last = v)} />);
    const area = screen.getByLabelText("zz（JSON）");
    fireEvent.change(area, { target: { value: "{oops" } });
    expect(last).toBeUndefined();
    fireEvent.change(area, { target: { value: '{"b":2}' } });
    expect(last).toEqual({ zz: { b: 2 } });
  });
});
