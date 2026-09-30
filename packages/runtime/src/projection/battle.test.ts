import type { BattleLogEntry, GameState } from "@rpg/core";
import { battleKit, beginBattle, deepFreeze, drive, driveUntil, idleFrames, press } from "@rpg/test-utils";
import { describe, expect, it } from "vitest";
import type { UiNode } from "../frame-spec.js";
import { formatLogEntry } from "./battle-log.js";
import { projectFrame } from "./index.js";

const kit = battleKit({
  mutate: (p) => {
    p.assets.entries["1111111111111111" as never] = { name: "slime.png", kind: "image", mime: "image/png", size: 1, width: 64, height: 48 };
    (p.database.enemies["slime" as never] as { graphic?: unknown }).graphic = { asset: "1111111111111111" };
  },
});
const { ctx } = kit;
const view = ctx.project;

const flatten = (nodes: readonly UiNode[]): UiNode[] => nodes.flatMap((n) => (n.kind === "window" ? [n, ...flatten(n.children)] : [n]));
const textsOf = (nodes: readonly UiNode[]): string[] => flatten(nodes).flatMap((n) => (n.kind === "text" ? [n.text] : []));
const frame = (s: GameState, v = view) => projectFrame(s, v);
const feed = (s: GameState, ...b: Parameters<typeof press>) => drive(s, ctx, b.map((x) => press(x))).state;

describe("projectFrame（戦闘）", () => {
  it("[snapshot] コマンド入力：ログ・敵・コマンド・ステータス", () => {
    const f = frame(beginBattle(kit, "tr_slimes"));
    expect(f.layers.length).toBeGreaterThan(0); // マップが背景に残る
    expect({ size: f.size, ui: f.ui }).toMatchSnapshot();
  });

  it("上のログは最後の 3 行までで、遭遇の文言は敵の名前から作る", () => {
    expect(textsOf(frame(beginBattle(kit, "tr_slime")).ui)).toContain("スライム が あらわれた！");
    expect(textsOf(frame(beginBattle(kit, "tr_slimes")).ui)).toContain("スライムA たちが あらわれた！");
  });

  it("コマンドは 逃走の可否で変わる", () => {
    expect(textsOf(frame(beginBattle(kit, "tr_slime")).ui)).toEqual(expect.arrayContaining(["攻撃", "スキル", "アイテム", "防御", "逃げる"]));
    // 「アイテム」は用語のキーに無いので固定文言ではなく term(item) を使う
    expect(textsOf(frame(beginBattle(kit, "tr_slime", { canEscape: false })).ui)).not.toContain("逃げる");
  });

  it("敵は絵（マニフェストの大きさで中心合わせ）か、絵が無ければ名前の箱で出て、倒れた敵は消える", () => {
    const s = beginBattle(kit, "tr_mixed");
    const nodes = flatten(frame(s).ui);
    const image = nodes.find((n) => n.kind === "image");
    expect(image).toMatchObject({ x: 28, y: 76, asset: "1111111111111111", sw: 64, sh: 48 }); // 中心 (60, 100) から半分ずつ
    expect(nodes.some((n) => n.kind === "window" && n.w === 72 && n.h === 40)).toBe(true); // 蜘蛛は絵が無い
    const down = { ...s, battle: { ...s.battle!, enemies: { ...s.battle!.enemies, "e:0": { ...s.battle!.enemies["e:0"]!, hp: 0 } } } };
    expect(flatten(frame(down).ui).some((n) => n.kind === "image")).toBe(false);
  });

  it("スキルの一覧は MP コストを右に出し、MP が足りないものは灰色", () => {
    let s = beginBattle(kit, "tr_slime");
    s = feed(s, "ok", "ok", "down", "ok"); // 魔法使いのスキル
    const nodes = flatten(frame(s).ui);
    expect(textsOf(nodes)).toEqual(expect.arrayContaining(["ファイア", "MP 3", "ヒール", "MP 2"]));
    const poor = { ...s, battle: { ...s.battle!, allies: { ...s.battle!.allies, actor_mage: { ...s.battle!.allies["actor_mage"]!, mp: 2 } } } };
    const fire = flatten(frame(poor).ui).find((n) => n.kind === "text" && n.text === "ファイア");
    expect(fire).toMatchObject({ color: { r: 128, g: 128, b: 128 } });
    const heal = flatten(frame(poor).ui).find((n) => n.kind === "text" && n.text === "ヒール");
    expect(heal).toMatchObject({ color: { r: 255, g: 255, b: 255 } });
  });

  it("アイテムの一覧は所持数を出す", () => {
    let s = beginBattle(kit, "tr_slime");
    s = feed(s, "down", "down", "ok");
    expect(textsOf(frame(s).ui)).toEqual(expect.arrayContaining(["ポーション", "× 2"]));
  });

  it("対象の選択：敵にはカーソルの枠、味方にはステータスの行にカーソルが出る", () => {
    let s = beginBattle(kit, "tr_slimes");
    s = feed(s, "ok");
    const enemyCursor = flatten(frame(s).ui).find((n) => n.kind === "cursor");
    expect(enemyCursor).toMatchObject({ x: 28 - 2, y: 76 - 2, w: 68, h: 52 });
    s = feed(s, "right");
    expect(flatten(frame(s).ui).find((n) => n.kind === "cursor")).toMatchObject({ x: 108 - 2 });

    let a = beginBattle(kit, "tr_slime");
    a = feed(a, "down", "down", "ok", "ok"); // アイテム → ポーション → 味方の対象選択
    const cursors = flatten(frame(a).ui).filter((n) => n.kind === "cursor");
    expect(cursors).toHaveLength(1);
    expect(cursors[0]!.kind === "cursor" && cursors[0]!.h).toBe(42);
  });

  it("ステータス：名前・HP/MP の数値とゲージ・状態。戦闘不能は赤い", () => {
    let s = beginBattle(kit, "tr_slime");
    s = {
      ...s,
      battle: {
        ...s.battle!,
        allies: {
          actor_hero: { ...s.battle!.allies["actor_hero"]!, hp: 40, states: [{ id: "st_poison" as never, turns: 2 }] },
          actor_mage: { ...s.battle!.allies["actor_mage"]!, hp: 0 },
        },
      },
    };
    const nodes = flatten(frame(s).ui);
    expect(textsOf(nodes)).toEqual(expect.arrayContaining(["勇者", "HP 40/100", "MP 20/20", "毒", "魔法使い", "HP 0/60"]));
    const gauges = nodes.filter((n) => n.kind === "gauge");
    expect(gauges.map((g) => (g.kind === "gauge" ? g.ratio : -1))).toEqual([0.4, 1, 0, 1]);
    expect(nodes.find((n) => n.kind === "text" && n.text === "魔法使い")).toMatchObject({ color: { r: 255, g: 120, b: 76 } });
  });

  it("ダメージの数字は対象の上に出て、時間とともに上へ浮かび、種類で色が変わる", () => {
    const s0 = beginBattle(kit, "tr_golem");
    const withPopup = (ttl: number, kind: "damage" | "critical" | "heal" | "miss", target = "e:0", amount = 12): GameState => ({
      ...s0,
      battle: { ...s0.battle!, popups: [{ target, kind, amount, ttl }] },
    });
    const popup = (s: GameState) => flatten(frame(s).ui).filter((n) => n.kind === "text" && n.font.size === 20)[0]!;
    const fresh = popup(withPopup(45, "damage"));
    const later = popup(withPopup(15, "damage"));
    expect(fresh).toMatchObject({ text: "12", align: "center" });
    expect(later.kind === "text" && fresh.kind === "text" && later.y < fresh.y).toBe(true);
    expect(popup(withPopup(30, "miss"))).toMatchObject({ text: "MISS", color: { r: 128, g: 128, b: 128 } });
    expect(popup(withPopup(30, "heal", "actor_hero"))).toMatchObject({ text: "12", color: { r: 102, g: 204, b: 64 } });
    expect(popup(withPopup(30, "critical"))).toMatchObject({ color: { r: 255, g: 255, b: 160 } });
  });

  it("戦闘が進むとログに行動と結果が出る（勝利の報酬・ドロップ・レベルアップも）", () => {
    let s = beginBattle(kit, "tr_slime");
    s = drive(s, ctx, [press("ok"), press("ok"), press("ok"), press("ok")]).state;
    s = driveUntil(s, ctx, (x) => x.battle!.phase === "victory");
    const all = s.battle!.log.flatMap((e) => formatLogEntry(e, s, view));
    expect(all).toEqual(expect.arrayContaining(["勇者 の こうげき！", "スライム は たおれた！", "戦闘に 勝利した！", "12 の 経験値と 8 の ゴールドを 手に入れた！", "ポーション を 手に入れた！"]));
    expect(textsOf(frame(s).ui).slice(-3)).toEqual(["戦闘に 勝利した！", "12 の 経験値と 8 の ゴールドを 手に入れた！", "ポーション を 手に入れた！"]);
  });

  it("用語は system.terms で差し替えられ、無い用語は既定に戻る", () => {
    const k = battleKit({ mutate: (p) => Object.assign(p.system.terms, { attack: "たたかう", damage: "{target}に{amount}！" }) });
    const s = beginBattle(k, "tr_slime");
    expect(textsOf(projectFrame(s, k.ctx.project).ui)).toContain("たたかう");
    const entry: BattleLogEntry = { kind: "damage", target: "e:0", amount: 5, critical: false };
    expect(formatLogEntry(entry, s, k.ctx.project)).toEqual(["スライムに5！"]);
  });

  it("[snapshot] ゲームオーバー", () => {
    const s = { ...kit.state, scene: { kind: "gameover" } } as GameState;
    const f = frame(s);
    expect(f.layers).toEqual([]);
    expect(f.ui).toMatchSnapshot();
    expect(textsOf(f.ui)).toEqual(["ゲームオーバー"]);
  });

  it("純粋：同じ状態からは同じ FrameSpec、状態は変更しない", () => {
    let s = beginBattle(kit, "tr_slimes");
    s = drive(s, ctx, idleFrames(1)).state;
    const frozen = deepFreeze(structuredClone(s));
    expect(frame(frozen)).toEqual(frame(s));
  });
});

describe("formatLogEntry", () => {
  const s = beginBattle(kit, "tr_slimes");
  const f = (e: BattleLogEntry) => formatLogEntry(e, s, view);
  const cases: [BattleLogEntry, string[]][] = [
    [{ kind: "turn", turn: 2 }, []],
    [{ kind: "action", subject: "actor_hero", action: "attack" }, ["勇者 の こうげき！"]],
    [{ kind: "action", subject: "actor_mage", action: "skill", skillId: "sk_fire" as never }, ["魔法使い は ファイア を つかった！"]],
    [{ kind: "action", subject: "actor_hero", action: "item", itemId: "potion" as never }, ["勇者 は ポーション を つかった！"]],
    [{ kind: "action", subject: "actor_hero", action: "guard" }, ["勇者 は みをまもっている。"]],
    [{ kind: "action", subject: "actor_hero", action: "escape" }, ["勇者 は にげだそうとした！"]],
    [{ kind: "damage", target: "e:1", amount: 30, critical: true }, ["かいしんの いちげき！", "スライムB に 30 の ダメージ！"]],
    [{ kind: "heal", target: "actor_hero", stat: "hp", amount: 9 }, ["勇者 の HP が 9 かいふくした！"]],
    [{ kind: "heal", target: "actor_hero", stat: "mp", amount: 4 }, ["勇者 の MP が 4 かいふくした！"]],
    [{ kind: "miss", target: "e:0" }, ["スライムA には あたらなかった！"]],
    [{ kind: "revived", target: "actor_hero" }, ["勇者 は ふっかつした！"]],
    [{ kind: "state", target: "actor_hero", state: "st_poison" as never, added: true }, ["勇者 は 毒 になった！"]],
    [{ kind: "state", target: "actor_hero", state: "st_poison" as never, added: false }, ["勇者 の 毒 が なおった！"]],
    [{ kind: "state", target: "actor_hero", state: "st_unknown" as never, added: true }, ["勇者 は st_unknown になった！"]],
    [{ kind: "buff", target: "actor_hero", param: "atk", level: 1 }, ["勇者 の 攻撃力 が あがった！"]],
    [{ kind: "buff", target: "actor_hero", param: "def", level: -1 }, ["勇者 の 防御力 が さがった！"]],
    [{ kind: "cannotAct", subject: "actor_hero", reason: "dead" }, []],
    [{ kind: "cannotAct", subject: "actor_hero", reason: "state" }, ["勇者 は うごけない！"]],
    [{ kind: "cannotAct", subject: "actor_mage", reason: "mp" }, ["魔法使い は MP が たりない！"]],
    [{ kind: "cannotAct", subject: "actor_mage", reason: "item" }, ["魔法使い は つかえるものが ない！"]],
    [{ kind: "cannotAct", subject: "actor_mage", reason: "skill" }, ["魔法使い は その わざを おぼえていない！"]],
    [{ kind: "escape", success: true }, ["うまく にげきれた！"]],
    [{ kind: "escape", success: false }, ["しかし にげられなかった！"]],
    [{ kind: "defeat" }, ["全滅してしまった…"]],
    [{ kind: "levelUp", actor: "actor_hero", level: 3 }, ["勇者 は レベル 3 に あがった！"]],
    [{ kind: "rewards", exp: 0, gold: 0, items: [] }, ["0 の 経験値と 0 の ゴールドを 手に入れた！"]],
  ];
  it.each(cases)("%j", (entry, lines) => {
    expect(f(entry)).toEqual(lines);
  });

  it("戦闘が無ければ空", () => {
    expect(formatLogEntry({ kind: "victory" }, kit.state, view)).toEqual([]);
  });
});
