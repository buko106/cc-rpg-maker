import { pluginStateOf, withPluginState, z } from "@rpg/plugin-api";
import type { GameState, JsonValue } from "@rpg/plugin-api";

/** `GameState.pluginState` で使うキー（プラグインの名前）。 */
export const STATE_KEY = "dungeon";

const int = z.number().int();

const enemySchema = z.strictObject({
  /** このフロアの中で一意な番号（行動の順）。 */
  id: int,
  /** データベースの敵の id。 */
  kind: z.string(),
  x: int,
  y: int,
  /** 今のターンの初めにいた位置（描画の補間用）。 */
  fx: int,
  fy: int,
  hp: int,
  mhp: int,
  /** 最後に動いた `tick`。 */
  t: int,
});

const floorItemSchema = z.strictObject({
  /** 設定の `items` の `key`。敵のドロップは `drop:<アイテムの id>`。 */
  key: z.string(),
  x: int,
  y: int,
  /** お金の額（`gold` のときだけ意味がある）。 */
  amt: int,
});

const popupSchema = z.strictObject({ x: int, y: int, text: z.string(), tone: z.enum(["dmg", "hurt", "heal", "info"]), t: int });

/**
 * ダンジョンに入っているあいだの状態（`pluginState.dungeon`。セーブに含まれる）。倒れる・宝を持ち帰ると `null` になる。
 * 敵・落ちている物・歩いた場所はここに持ち、マップのイベントは使わない（描画は `projection.after`、地形は `mapTiles`）。
 */
export const dungeonSchema = z.strictObject({
  v: z.literal(1),
  /** この入場のシード。階ごとのシードは `${seed}:${floor}`。 */
  seed: z.string(),
  floor: int.min(1),
  turn: int.min(0),
  belly: int.min(0),
  /** 「ちからの種」で増えた攻撃力。 */
  atkBonus: int.min(0),
  /** 入ったときの所持金（倒れたら、ここまで戻る）。 */
  gold0: int.min(0),
  width: int.min(1),
  height: int.min(1),
  /** `width * height` 文字。`#` 岩、`.` 床、`>` 階段、`$` 宝。 */
  grid: z.string(),
  /** `width * height` 文字の `0` / `1`（歩いて見た場所）。 */
  seen: z.string(),
  rooms: z.array(z.tuple([int, int, int, int])),
  goal: z.tuple([int, int]),
  /** プレイヤーが最後にいたマス（歩いたかどうかの判定に使う）。 */
  px: int,
  py: int,
  /** 主人公の最大 HP・攻撃力・防御力（HUD と戦闘のために、毎ターン書き直す）。 */
  mhp: int,
  atk: int,
  def: int,
  enemies: z.array(enemySchema),
  items: z.array(floorItemSchema),
  log: z.array(z.string()),
  fx: z.array(popupSchema),
  /** この階に着いた `tick`。 */
  ft: int,
  nextId: int,
  kills: int.min(0),
});

export type DungeonState = z.infer<typeof dungeonSchema>;
export type EnemyState = DungeonState["enemies"][number];
export type FloorItem = DungeonState["items"][number];
export type Popup = DungeonState["fx"][number];

const cache = new WeakMap<object, DungeonState | null>();

/** 状態から、ダンジョンの状態を読む（入っていない・壊れているときは `undefined`）。同じ値は何度読んでも検証し直さない。 */
export function readDungeon(state: Pick<GameState, "pluginState">): DungeonState | undefined {
  const raw = pluginStateOf(state, STATE_KEY);
  if (raw === undefined || raw === null || typeof raw !== "object") return undefined;
  const hit = cache.get(raw);
  if (hit !== undefined) return hit === null ? undefined : hit;
  const r = dungeonSchema.safeParse(raw);
  const parsed = r.success && r.data.grid.length === r.data.width * r.data.height && r.data.seen.length === r.data.grid.length ? r.data : null;
  cache.set(raw, parsed);
  return parsed === null ? undefined : parsed;
}

/** 読んだ状態を、書き換えてよい複製にする。 */
export const cloneDungeon = (ds: DungeonState): DungeonState => JSON.parse(JSON.stringify(ds)) as DungeonState;

export const withDungeon = <S extends Pick<GameState, "pluginState">>(state: S, ds: DungeonState | null): S => withPluginState(state, STATE_KEY, ds as JsonValue);

/** 戦闘ログ・ポップアップの数の上限。 */
export const LOG_LINES = 6;
export const MAX_POPUPS = 8;
