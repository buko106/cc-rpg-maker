import { createCommandRegistry, registerBuiltins } from "@rpg/core";
import { createMemoryProjectRepository } from "@rpg/project-store";
import type { ProjectDocument } from "@rpg/project-store";
import { eventPageSchema } from "@rpg/schema";
import type { AssetId, EventId, EventPage, ItemId, MapId, Project } from "@rpg/schema";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { cmd } from "./commands/index.js";
import { BUILTIN_EVENT_TEMPLATES, characterImage, defineEventTemplate, splitMessages } from "./templates.js";
import type { EventTemplate } from "./templates.js";

const M1 = "map_001" as MapId;
const HERO = "bb2e23b45d1f4d4d" as AssetId;
const TILESET = "b9b596c2f04468ac" as AssetId;
let base: ProjectDocument;
let project: Project;

beforeAll(async () => {
  base = await createMemoryProjectRepository().create("t");
  const items = { item_potion: { ...Object.values(base.project.database.items)[0], id: "item_potion" as ItemId, name: "ポーション" } };
  project = base.project;
  // アイテム名を使うひな形のために、アイテムを 1 つ足しておく（形はスキーマに通さないので最小限）
  project = { ...project, database: { ...project.database, items: items as unknown as Project["database"]["items"] } };
});

const template = (id: string): EventTemplate => {
  const t = BUILTIN_EVENT_TEMPLATES.find((x) => x.id === id);
  if (t === undefined) throw new Error(`ひな形 ${id} が無い`);
  return t;
};
/** 入力を検証して（既定値を入れて）から作る。 */
const build = (id: string, input: unknown): { name: string; pages: EventPage[] } => {
  const t = template(id);
  return t.build(t.input.parse(input), project);
};
const codes = (page: EventPage | undefined): string[] => (page?.commands ?? []).map((c) => c.code);

describe("splitMessages", () => {
  it("空行で区切る。区切りの中の改行は残し、前後の空行と末尾の空白は落とす", () => {
    expect(splitMessages("こんにちは")).toEqual(["こんにちは"]);
    expect(splitMessages("1行目\n2行目\n\n次の文章  \n")).toEqual(["1行目\n2行目", "次の文章"]);
    expect(splitMessages("a\n\n\n\nb")).toEqual(["a", "b"]);
    expect(splitMessages("a\n 　\nb")).toEqual(["a", "b"]); // 空白だけの行も区切り
    expect(splitMessages("a\r\n\r\nb")).toEqual(["a", "b"]);
  });

  it("行頭の字下げ（全角スペース）は残す。中身の無い入力は何も返さない", () => {
    expect(splitMessages("　字下げ")).toEqual(["　字下げ"]);
    expect(splitMessages("")).toEqual([]);
    expect(splitMessages(" \n\n　\n")).toEqual([]);
  });
});

describe("組み込みのひな形", () => {
  const SAMPLES: Record<string, unknown> = {
    npc: { name: "村人", lines: "こんにちは。\n\nいい天気だね。", again: "また来たね。", wander: true, graphic: { asset: HERO, index: 0, direction: "down" } },
    door: { name: "扉", to: { mapId: M1, x: 3, y: 4 }, how: "bump", se: HERO },
    chest: { name: "宝箱", contents: { kind: "item", item: "item_potion", amount: 2 } },
    merchant: { name: "商人", greeting: "いらっしゃい！", goods: ["item_potion"], farewell: "" },
    enemy: { name: "スライム", troop: "tr_slime", trigger: "touch", move: "toward" },
  };

  it("5 種類そろっていて、ID は重ならない", () => {
    expect(BUILTIN_EVENT_TEMPLATES.map((t) => t.id)).toEqual(["npc", "door", "chest", "merchant", "enemy"]);
    for (const t of BUILTIN_EVENT_TEMPLATES) expect(t.label).not.toBe("");
  });

  it("作ったページはスキーマを通り、コマンドの params はそれぞれのコマンドの zod を通る", () => {
    const registry = createCommandRegistry();
    registerBuiltins(registry);
    for (const t of BUILTIN_EVENT_TEMPLATES) {
      const { pages } = build(t.id, SAMPLES[t.id]);
      expect(pages.length).toBeGreaterThan(0);
      for (const page of pages) {
        expect(eventPageSchema.safeParse(page).success).toBe(true);
        for (const c of page.commands) {
          const handler = registry.get(c.code);
          expect(handler, c.code).toBeDefined();
          expect(handler!.params.safeParse(c.params).success, `${t.id}: ${c.code}`).toBe(true);
        }
      }
    }
  });

  it("話しかける人：セリフは空行ごとに「文章の表示」。2 回目からのセリフはセルフスイッチ A の 2 ページ目になる", () => {
    const { name, pages } = build("npc", SAMPLES["npc"]);
    expect(name).toBe("村人");
    expect(codes(pages[0])).toEqual(["ShowText", "ShowText", "ControlSelfSwitch"]);
    expect(pages[0]!.commands.map((c) => c.params["text"])).toEqual(["こんにちは。", "いい天気だね。", undefined]);
    expect(pages[0]).toMatchObject({ trigger: "action", graphic: { asset: HERO }, moveRoute: { repeat: true } });
    expect(pages[1]).toMatchObject({ conditions: [{ kind: "selfSwitch", key: "A", value: true }], graphic: { asset: HERO }, moveRoute: { repeat: true } });
    expect(codes(pages[1])).toEqual(["ShowText"]);

    // 2 回目からのセリフが無い（空）なら 1 ページで、セルフスイッチも使わない。見た目と自律移動も省ける
    const once = build("npc", { name: "村人", lines: "やあ", again: " \n", wander: false });
    expect(once.pages).toHaveLength(1);
    expect(codes(once.pages[0])).toEqual(["ShowText"]);
    expect(once.pages[0]).not.toHaveProperty("graphic");
    expect(once.pages[0]).not.toHaveProperty("moveRoute");
    // セリフが空なら作れない
    expect(template("npc").input.safeParse({ name: "村人", lines: "\n \n", wander: false }).success).toBe(false);
  });

  it("扉：接触で起動して場所移動する。ぶつかる扉は通常キャラと同じ、乗る出口は下。効果音は先に鳴らす", () => {
    const bump = build("door", SAMPLES["door"]).pages[0]!;
    expect(bump).toMatchObject({ trigger: "touch", priority: "same" });
    expect(codes(bump)).toEqual(["PlaySe", "TransferPlayer"]);
    expect(bump.commands[1]!.params).toEqual({ mapId: M1, x: 3, y: 4, dir: "retain", fade: "black" });
    const step = build("door", { name: "出口", to: { mapId: M1, x: 0, y: 0 }, how: "step", dir: "down", fade: "none" }).pages[0]!;
    expect(step).toMatchObject({ trigger: "touch", priority: "below" });
    expect(codes(step)).toEqual(["TransferPlayer"]);
    expect(step.commands[0]!.params).toMatchObject({ dir: "down", fade: "none" });
  });

  it("宝箱：手に入れたメッセージ・増加・セルフスイッチ A。2 ページ目は開いた見た目で、何もしない", () => {
    const item = build("chest", { ...(SAMPLES["chest"] as object), graphic: { asset: HERO, index: 1, direction: "down" }, opened: { asset: HERO, index: 2, direction: "down" } });
    expect(codes(item.pages[0])).toEqual(["ShowText", "ChangeItems", "ControlSelfSwitch"]);
    expect(item.pages[0]!.commands[0]!.params["text"]).toBe("\\C[2]ポーション\\C[0] ×2 を手に入れた！");
    expect(item.pages[0]!.commands[1]!.params).toEqual({ item: "item_potion", op: "gain", amount: { kind: "constant", value: 2 } });
    expect(item.pages[1]).toMatchObject({ conditions: [{ kind: "selfSwitch", key: "A" }], graphic: { index: 2 }, commands: [] });
    expect(item.pages[0]).toMatchObject({ graphic: { index: 1 } });

    const gold = build("chest", { name: "宝箱", contents: { kind: "gold", amount: 50 } });
    expect(codes(gold.pages[0])).toEqual(["ShowText", "ChangeGold", "ControlSelfSwitch"]);
    expect(gold.pages[0]!.commands[0]!.params["text"]).toBe("\\C[6]50G\\C[0] を手に入れた！");
    // 1 個なら個数は出さない。名前の無いアイテム（消えた ID）は ID で出す
    expect(build("chest", { name: "宝箱", contents: { kind: "item", item: "item_gone", amount: 1 } }).pages[0]!.commands[0]!.params["text"]).toBe("\\C[2]item_gone\\C[0] を手に入れた！");
  });

  it("商人：あいさつ・ショップ・帰りのあいさつ。空のあいさつは入れない", () => {
    const { pages } = build("merchant", SAMPLES["merchant"]);
    expect(codes(pages[0])).toEqual(["ShowText", "ShopProcessing"]);
    expect(pages[0]!.commands[1]!.params).toEqual({ goods: ["item_potion"], canSell: true });
    expect(template("merchant").input.safeParse({ name: "商人", greeting: "", goods: [], farewell: "" }).success).toBe(false); // 品ぞろえは 1 つ以上
  });

  it("敵シンボル：戦闘の分岐（勝ったらセルフスイッチ A）と、倒したあとの消えたページ。動きは選べる", () => {
    const { pages } = build("enemy", SAMPLES["enemy"]);
    expect(pages[0]!.commands.map((c) => [c.code, c.indent])).toEqual([
      ["BattleProcessing", 0],
      ["ChoiceBranch", 0],
      ["ControlSelfSwitch", 1],
      ["ChoiceBranch", 0],
      ["ChoiceBranch", 0],
      ["EndBranch", 0],
    ]);
    expect(pages[0]!.commands[0]!.params).toEqual({ troop: "tr_slime", canEscape: true, canLose: false });
    expect(pages[0]).toMatchObject({ trigger: "eventTouch", moveRoute: { steps: [{ kind: "move", dir: "toward" }, { kind: "wait" }] } });
    expect(pages[1]).toMatchObject({ conditions: [{ kind: "selfSwitch", key: "A" }], through: true, priority: "below", commands: [] });
    expect(pages[1]).not.toHaveProperty("graphic");
    expect(build("enemy", { ...(SAMPLES["enemy"] as object), move: "random", trigger: "action" }).pages[0]).toMatchObject({ trigger: "action", moveRoute: { steps: [{ dir: "random" }, { kind: "wait" }] } });
    expect(build("enemy", { ...(SAMPLES["enemy"] as object), move: "none" }).pages[0]).not.toHaveProperty("moveRoute");
  });

  it("人の見た目の初期値は、タイルセットに使われていない最初の画像（無ければ入れない）", () => {
    expect(characterImage(project)).toBe(HERO);
    expect(template("npc").initial?.(project)).toEqual({ graphic: { asset: HERO, index: 0, direction: "down" } });
    expect(template("merchant").initial?.(project)).toEqual({ graphic: { asset: HERO, index: 0, direction: "down" } });
    const noCharacters = { ...project, assets: { entries: { [TILESET]: project.assets.entries[TILESET]! } } } as Project;
    expect(characterImage(noCharacters)).toBeUndefined();
    expect(template("npc").initial?.(noCharacters)).toEqual({});
  });
});

describe("cmd.createEventFromTemplate", () => {
  const EV = "ev_t" as EventId;

  it("入力から作ったイベントを置く。1 回の Undo（invert）で消える", () => {
    const c = cmd.createEventFromTemplate(M1, 2, 3, template("chest"), { name: "宝箱", contents: { kind: "gold", amount: 10 } }, EV);
    expect(c.label).toBe("イベントの作成（宝箱）");
    const r = c.apply(base);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.value.maps[M1]!.events[EV]).toMatchObject({ id: EV, name: "宝箱", x: 2, y: 3, pages: [{ commands: [{ code: "ShowText" }, { code: "ChangeGold" }, { code: "ControlSelfSwitch" }] }, { conditions: [{ kind: "selfSwitch" }] }] });
    expect(c.invert(base, r.value).apply(r.value)).toEqual({ ok: true, value: base });
    expect(c.touchedMaps()).toEqual([M1]);
  });

  it("マップの外・使用中の ID・イベントのあるセル・入力の誤りは失敗し、文書は変わらない", () => {
    const chest = template("chest");
    const input = { name: "宝箱", contents: { kind: "gold", amount: 10 } };
    expect(cmd.createEventFromTemplate("map_nope" as MapId, 0, 0, chest, input).apply(base)).toMatchObject({ ok: false, error: { kind: "notFound" } });
    expect(cmd.createEventFromTemplate(M1, 99, 0, chest, input).apply(base)).toMatchObject({ ok: false, error: { kind: "invalid" } });
    const placed = cmd.createEvent(M1, 1, 1, EV).apply(base);
    if (!placed.ok) throw new Error("createEvent");
    expect(cmd.createEventFromTemplate(M1, 5, 5, chest, input, EV).apply(placed.value)).toMatchObject({ ok: false, error: { kind: "duplicate" } });
    expect(cmd.createEventFromTemplate(M1, 1, 1, chest, input).apply(placed.value)).toMatchObject({ ok: false, error: { kind: "duplicate", message: expect.stringContaining("(1,1)") } });
    const bad = cmd.createEventFromTemplate(M1, 0, 0, chest, { name: "宝箱", contents: { kind: "gold", amount: 0 } }).apply(base);
    expect(bad).toMatchObject({ ok: false, error: { kind: "invalid", message: expect.stringContaining("ひな形「宝箱」の入力") } });
  });

  it("ひな形（プラグインなど）が例外を投げたり、正しくないイベントを作ったりしても、文書を壊さない", () => {
    const input = z.strictObject({});
    const throws = defineEventTemplate({ id: "x", label: "壊れた", description: "", input, build: () => { throw new Error("だめ"); } });
    expect(cmd.createEventFromTemplate(M1, 0, 0, throws, {}).apply(base)).toMatchObject({ ok: false, error: { kind: "invalid", message: expect.stringContaining("だめ") } });
    const empty = defineEventTemplate({ id: "y", label: "空", description: "", input, build: () => ({ name: "空", pages: [] }) });
    expect(cmd.createEventFromTemplate(M1, 0, 0, empty, {}).apply(base)).toMatchObject({ ok: false, error: { message: expect.stringContaining("ページが無い") } });
    const broken = defineEventTemplate({ id: "z", label: "不正", description: "", input, build: () => ({ name: "不正", pages: [{ trigger: "never" } as unknown as EventPage] }) });
    expect(cmd.createEventFromTemplate(M1, 0, 0, broken, {}).apply(base)).toMatchObject({ ok: false, error: { kind: "invalid", message: expect.stringContaining("正しくない") } });
  });
});
