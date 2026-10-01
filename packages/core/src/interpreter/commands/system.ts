import { z } from "zod";
import { titleState } from "../../game/initial.js";
import { SAVE_SLOT_COUNT, SAVE_SLOT_FIRST } from "../../game/scenes.js";
import { warn } from "../../effects.js";
import type { GameState } from "../../state.js";
import { defineCommand } from "../handler.js";

const empty = z.strictObject({});
const noRefs = () => [];

const saveParams = z.strictObject({
  /** 省略 = セーブ画面を開く。指定 = その番号のスロットへ、画面を出さずに直接セーブする。 */
  slot: z.number().int().min(SAVE_SLOT_FIRST).max(SAVE_SLOT_FIRST + SAVE_SLOT_COUNT - 1).optional(),
});

/**
 * `slot` を省略すると、セーブ画面を開く（メニューのセーブ画面。閉じるとマップに戻り、続きから実行される）。
 * `slot` を指定すると、画面を出さずにそのスロットへセーブして続ける（セーブポイント）。保存されるのはこのコマンドの次から再開する状態。
 */
export const saveGame = defineCommand({
  code: "SaveGame",
  params: saveParams,
  meta: {
    label: "セーブ",
    category: "システム",
    describe: (p) => (p.slot === undefined ? "セーブ画面を開く" : `スロット${p.slot} にセーブ`),
    refs: noRefs,
  },
  run: (p, c) =>
    p.slot === undefined
      ? { state: { ...c.state, scene: { kind: "menu", screen: "save", cursor: 0 } } }
      : { effects: [{ kind: "requestSave", slot: p.slot, confirmed: true }] },
});

/** ロード画面を開く。 */
export const loadGame = defineCommand({
  code: "LoadGame",
  params: empty,
  meta: { label: "ロード画面を開く", category: "システム", describe: () => "ロード画面を開く", refs: noRefs },
  run: (_p, c) => ({ state: { ...c.state, scene: { kind: "menu", screen: "load", cursor: 0 } } }),
});

/** ゲームオーバー画面へ。このインタプリタは終了する。 */
export const gameOver = defineCommand({
  code: "GameOver",
  params: empty,
  meta: { label: "ゲームオーバー", category: "システム", describe: () => "ゲームオーバー", refs: noRefs },
  run: (_p, c) => ({
    state: { ...c.state, scene: { kind: "gameover" }, message: { ...c.state.message, open: false }, interpreters: [] },
    effects: [{ kind: "stopBgm", fadeMs: 500 }],
    control: { kind: "exit" },
  }),
});

/** タイトル画面へ戻る（状態は作り直される）。 */
export const returnToTitle = defineCommand({
  code: "ReturnToTitle",
  params: empty,
  meta: { label: "タイトルへ戻る", category: "システム", describe: () => "タイトルへ戻る", refs: noRefs },
  run: (_p, c) => ({
    state: { ...titleState(c, c.state.rng.seed), tick: c.state.tick },
    effects: [{ kind: "stopBgm", fadeMs: 500 }],
    control: { kind: "exit" },
  }),
});

/**
 * 05 の式言語のスクリプト。`setVar` / `setSwitch` / `gainItem` だけが状態を変える（式の評価は変更操作を返し、ここで反映する）。
 * 評価できなければ警告して何もしない。
 */
export const script = defineCommand({
  code: "Script",
  params: z.strictObject({ expr: z.string().meta({ formula: true }) }),
  meta: { label: "スクリプト", category: "システム", describe: (p) => `スクリプト：${p.expr}`, refs: noRefs },
  run(p, c) {
    const r = c.script(p.expr);
    if (!r.ok) return { effects: [warn(`Script: 式 "${p.expr}" を評価できない（${r.error.message}）`)] };
    let s: GameState = c.state;
    for (const m of r.value.mutations) {
      switch (m.kind) {
        case "setVar":
          s = { ...s, variables: { ...s.variables, [m.id]: m.value } };
          break;
        case "setSwitch":
          s = { ...s, switches: { ...s.switches, [m.id]: m.value } };
          break;
        case "gainItem": {
          const count = Math.max(0, (s.party.items[m.id] ?? 0) + m.count);
          const items = { ...s.party.items };
          if (count === 0) delete items[m.id];
          else items[m.id] = count;
          s = { ...s, party: { ...s.party, items } };
          break;
        }
      }
    }
    return { state: s };
  },
});
