import { assetIdSchema, directionSchema, eventPageSchema, itemIdSchema, mapIdSchema, nonNegativeInt, troopIdSchema } from "@rpg/schema";
import type { AssetId, EventCommand, EventPage, MoveRoute, PageCondition, Project } from "@rpg/schema";
import { z } from "zod";

/** ひな形が作るもの：イベントの名前とページ（位置と ID は置くときに決まる）。 */
export interface EventDraft {
  name: string;
  pages: EventPage[];
}

/**
 * イベントのひな形。いくつかの項目（`input`）を入れると、ページ・出現条件・コマンドのそろったイベントを作る。
 * 作られるのは普通のページとコマンドなので、あとから自由に編集できる。
 * 入力フォームはエディタが `input` の zod から作る。フィールドの見出しは `.meta({ title })`、補足は `.meta({ description })`、
 * 新しく作るときの初期値は `.meta({ initial })`（docs/13-editor-ui.md のフォームの自動生成）。
 */
export interface EventTemplate<I = any> {
  /** 一意。プラグインのものは `plugin:<name>/<id>`。 */
  readonly id: string;
  /** ひな形の名前（「宝箱」など） */
  readonly label: string;
  /** 何ができるかの 1 行の説明 */
  readonly description: string;
  readonly input: z.ZodType<I>;
  /** 検証を通った入力（既定値の適用後）から、イベントを作る。`project` は名前の参照（アイテム名など）に使う。 */
  build(input: I, project: Project): EventDraft;
  /** フォームの初期値のうち、プロジェクトの中身で決めたいもの（見た目の画像など）。`.meta({ initial })` より優先される。 */
  initial?(project: Project): Record<string, unknown>;
}

/** 入力の型を推論させて、ひな形を定義する。 */
export const defineEventTemplate = <S extends z.ZodType>(t: Omit<EventTemplate<z.output<S>>, "input"> & { input: S }): EventTemplate<z.output<S>> => t as EventTemplate<z.output<S>>;

/**
 * 「文章をすぐ追加」やひな形のセリフの入力を、1 つずつの「文章の表示」の本文に分ける。空行（空白だけの行を含む）が区切り。
 * 各本文の前後の空行と末尾の空白は落とす（行頭の全角スペースなどの字下げは残す）。中身の無いものは入れない。
 */
export function splitMessages(input: string): string[] {
  return input
    .replace(/\r\n?/g, "\n")
    .split(/\n[ \t　]*\n/)
    .map((block) => block.replace(/^(?:[ \t　]*\n)+/, "").replace(/\s+$/, ""))
    .filter((block) => block.trim() !== "");
}

/** 「自律移動する」の初期ルート：ランダムに 1 歩、少し待つ、を繰り返す。 */
export const WANDER_ROUTE: MoveRoute = { repeat: true, skippable: true, steps: [{ kind: "move", dir: "random" }, { kind: "wait", frames: 60 }] };
/** プレイヤーに 1 歩ずつ近づく、を繰り返す。 */
const APPROACH_ROUTE: MoveRoute = { repeat: true, skippable: true, steps: [{ kind: "move", dir: "toward" }, { kind: "wait", frames: 20 }] };

// ---- コマンドとページの部品 ----

const line = (code: string, params: Record<string, unknown>, indent = 0): EventCommand => ({ code, params, indent });
const showText = (text: string, indent = 0): EventCommand => line("ShowText", { text, position: "bottom", background: "window" }, indent);
const texts = (input: string): EventCommand[] => splitMessages(input).map((t) => showText(t));
const selfSwitchOn = (indent = 0): EventCommand => line("ControlSelfSwitch", { key: "A", value: true }, indent);
const constant = (value: number): { kind: "constant"; value: number } => ({ kind: "constant", value });
/** セルフスイッチ A が ON のときに有効（「1 回済んだあと」のページ）。 */
const AFTER: PageCondition = { kind: "selfSwitch", key: "A", value: true };

type Graphic = NonNullable<EventPage["graphic"]>;
function page(opts: { graphic?: Graphic | undefined; trigger?: EventPage["trigger"]; priority?: EventPage["priority"]; through?: boolean; conditions?: PageCondition[]; moveRoute?: MoveRoute | undefined; commands: EventCommand[] }): EventPage {
  return {
    conditions: opts.conditions ?? [],
    ...(opts.graphic === undefined ? {} : { graphic: opts.graphic }),
    trigger: opts.trigger ?? "action",
    through: opts.through ?? false,
    priority: opts.priority ?? "same",
    ...(opts.moveRoute === undefined ? {} : { moveRoute: opts.moveRoute }),
    commands: opts.commands,
  };
}

/** 歩行グラフィックらしい画像：タイルセットの画像に使われていない、最初の画像アセット。 */
export function characterImage(project: Project): AssetId | undefined {
  const tilesets = new Set<string>(Object.values(project.tilesets).flatMap((t) => (t.image === undefined ? [] : [t.image.asset])));
  return (Object.entries(project.assets.entries) as [AssetId, Project["assets"]["entries"][AssetId]][]).find(([id, e]) => e.kind === "image" && !tilesets.has(id))?.[0];
}

/** 人の見た目の初期値（それらしい画像があれば、下向きで）。 */
const personLook = (project: Project): Record<string, unknown> => {
  const asset = characterImage(project);
  return asset === undefined ? {} : { graphic: { asset, index: 0, direction: "down" } };
};

// ---- 入力の部品 ----

const eventName = (initial: string) => z.string().meta({ title: "イベント名", initial });
const look = (title = "見た目", description?: string) => eventPageSchema.shape.graphic.unwrap().meta({ title, ...(description === undefined ? {} : { description }) }).optional();
/** セリフ（空行で区切ると別々のメッセージ）。空のままでは作れない。 */
const message = (title: string, initial: string, description = "空行で区切ると、別々のメッセージになります。") =>
  z
    .string()
    .refine((s) => splitMessages(s).length > 0, "セリフを入れてください")
    .meta({ title, description, multiline: true, initial });
/** 入れなくてもよいセリフ（空なら出さない）。 */
const optionalMessage = (title: string, initial: string) => z.string().meta({ title, multiline: true, initial, description: "空のままなら出しません。" });

// ---- 組み込みのひな形 ----

const npc = defineEventTemplate({
  id: "npc",
  label: "話しかける人",
  description: "話しかけるとセリフを話す人。2 回目から別のセリフにもできます。",
  input: z.strictObject({
    name: eventName("村人"),
    graphic: look(),
    lines: message("セリフ", "こんにちは。"),
    again: z
      .string()
      .meta({ title: "2 回目からのセリフ", multiline: true, description: "入れると、1 回話したあとはこちらを話します（セルフスイッチ A を使います）。" })
      .optional(),
    wander: z.boolean().meta({ title: "うろうろ歩く", initial: false }),
  }),
  initial: personLook,
  build(i) {
    const again = i.again === undefined ? [] : texts(i.again);
    const base = { graphic: i.graphic, moveRoute: i.wander ? WANDER_ROUTE : undefined };
    const first = page({ ...base, commands: [...texts(i.lines), ...(again.length > 0 ? [selfSwitchOn()] : [])] });
    return { name: i.name, pages: again.length > 0 ? [first, page({ ...base, conditions: [AFTER], commands: again })] : [first] };
  },
});

const door = defineEventTemplate({
  id: "door",
  label: "扉・場所移動",
  description: "触れると別の場所へ移動する扉や出口。",
  input: z.strictObject({
    name: eventName("扉"),
    to: z
      .strictObject({ mapId: mapIdSchema, x: nonNegativeInt, y: nonNegativeInt })
      .meta({ title: "移動先", location: true, description: "下のマップをクリックして選べます。" }),
    how: z.enum(["bump", "step"]).meta({ title: "移動するとき", labels: { bump: "ぶつかったとき（扉など）", step: "上に乗ったとき（階段・出口など）" } }),
    dir: z.union([directionSchema, z.literal("retain")]).default("retain").meta({ title: "移動後の向き" }),
    fade: z.enum(["black", "white", "none"]).default("black").meta({ title: "フェード" }),
    se: assetIdSchema.meta({ ref: "asset", assetKind: "audio", title: "効果音" }).optional(),
    graphic: look(),
  }),
  build(i) {
    const se = i.se === undefined ? [] : [line("PlaySe", { audio: { asset: i.se, volume: 0.9, pitch: 1, loop: false } })];
    const transfer = line("TransferPlayer", { mapId: i.to.mapId, x: i.to.x, y: i.to.y, dir: i.dir, fade: i.fade });
    return { name: i.name, pages: [page({ graphic: i.graphic, trigger: "touch", priority: i.how === "step" ? "below" : "same", commands: [...se, transfer] })] };
  },
});

const chest = defineEventTemplate({
  id: "chest",
  label: "宝箱",
  description: "調べるとアイテムかお金が手に入り、開いたままになる箱。",
  input: z.strictObject({
    name: eventName("宝箱"),
    contents: z
      .discriminatedUnion("kind", [
        z.strictObject({ kind: z.literal("item"), item: itemIdSchema, amount: z.number().int().min(1).meta({ title: "個数", initial: 1 }) }),
        z.strictObject({ kind: z.literal("gold"), amount: z.number().int().min(1).meta({ title: "金額", initial: 100 }) }),
      ])
      .meta({ title: "中身" }),
    graphic: look("閉じた見た目"),
    opened: look("開いた後の見た目"),
  }),
  build(i, project) {
    const c = i.contents;
    const got =
      c.kind === "item"
        ? `\\C[2]${project.database.items[c.item]?.name ?? c.item}\\C[0]${c.amount > 1 ? ` ×${c.amount}` : ""}`
        : `\\C[6]${c.amount}G\\C[0]`;
    const gain = c.kind === "item" ? line("ChangeItems", { item: c.item, op: "gain", amount: constant(c.amount) }) : line("ChangeGold", { op: "gain", amount: constant(c.amount) });
    return {
      name: i.name,
      pages: [
        page({ graphic: i.graphic, commands: [showText(`${got} を手に入れた！`), gain, selfSwitchOn()] }),
        page({ graphic: i.opened, conditions: [AFTER], commands: [] }),
      ],
    };
  },
});

const merchant = defineEventTemplate({
  id: "merchant",
  label: "商人",
  description: "話しかけるとお店の画面を開く人。",
  input: z.strictObject({
    name: eventName("商人"),
    graphic: look(),
    greeting: optionalMessage("あいさつ", "いらっしゃい！ 何にする？"),
    goods: z.array(itemIdSchema).min(1).meta({ title: "品ぞろえ" }),
    canSell: z.boolean().default(true).meta({ title: "売却もできる" }),
    farewell: optionalMessage("帰りのあいさつ", "また来てね！"),
  }),
  initial: personLook,
  build(i) {
    return { name: i.name, pages: [page({ graphic: i.graphic, commands: [...texts(i.greeting), line("ShopProcessing", { goods: i.goods, canSell: i.canSell }), ...texts(i.farewell)] })] };
  },
});

const enemy = defineEventTemplate({
  id: "enemy",
  label: "敵シンボル",
  description: "触れると戦闘になり、勝つと消える敵（セルフスイッチ A を使います）。",
  input: z.strictObject({
    name: eventName("魔物"),
    graphic: look(),
    troop: troopIdSchema.meta({ title: "敵グループ" }),
    trigger: z.enum(["touch", "action"]).meta({ title: "戦闘になるとき", labels: { touch: "ぶつかったとき", action: "話しかけたとき" } }),
    move: z.enum(["random", "toward", "none"]).meta({ title: "動き", labels: { random: "うろうろ歩く", toward: "近づいてくる", none: "動かない" } }),
    canEscape: z.boolean().default(true).meta({ title: "逃げられる" }),
    canLose: z.boolean().default(false).meta({ title: "負けても続く（ゲームオーバーにしない）" }),
  }),
  build(i) {
    const moveRoute = i.move === "random" ? WANDER_ROUTE : i.move === "toward" ? APPROACH_ROUTE : undefined;
    // 分岐の形はコマンドの追加（戦闘の処理 = 勝ったとき / 逃げたとき / 負けたとき）と同じ
    const battle = [
      line("BattleProcessing", { troop: i.troop, canEscape: i.canEscape, canLose: i.canLose }),
      line("ChoiceBranch", { index: 0 }),
      selfSwitchOn(1),
      line("ChoiceBranch", { index: 1 }),
      line("ChoiceBranch", { index: 2 }),
      line("EndBranch", {}),
    ];
    return {
      name: i.name,
      pages: [
        // ぶつかったとき：プレイヤーから触れても、近づいてきた敵の方から触れても戦闘になる（イベントから接触）
        page({ graphic: i.graphic, trigger: i.trigger === "touch" ? "eventTouch" : "action", moveRoute, commands: battle }),
        // 倒したあと：見た目なし・すり抜け・下（いないのと同じ）
        page({ conditions: [AFTER], through: true, priority: "below", commands: [] }),
      ],
    };
  },
});

/** 組み込みのひな形（エディタの「置くイベント」に出る順）。 */
export const BUILTIN_EVENT_TEMPLATES: readonly EventTemplate[] = [npc, door, chest, merchant, enemy];
