import type { ActorId, AssetId, AssetRef, Direction, EventId, EventPage, ItemId, MapId, SkillId, SwitchId, VariableId } from "@rpg/schema";
import type { BattleState } from "./battle/state.js";
import type { InterpreterState } from "./interpreter/state.js";
import type { RandomState } from "./random.js";

/** JSON にできる値（`GameState.pluginState` の値）。`undefined` は含まない（セーブ・リプレイの比較で消えるため）。 */
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type TitleScreen = "main" | "continue";
export type MenuScreen = "main" | "item" | "skill" | "status" | "save" | "load";
/** ショップの画面：コマンド（購入/売却/やめる）→ 商品の一覧（`buy`）または所持品の一覧（`sell`）。 */
export type ShopScreen = "command" | "buy" | "sell";

/**
 * メニューで使うもの（アイテム / スキル）を選んだあと、対象の味方を選んでいる状態。`cursor` は `party.members` の位置（`self`・全体のスキルでは使わない）。
 * スキルは使う人（`user`）を持つ（アイテムは誰が使っても同じ）。
 */
export type MenuPick =
  | { readonly kind: "item"; readonly id: ItemId; readonly cursor: number }
  | { readonly kind: "skill"; readonly id: SkillId; readonly user: ActorId; readonly cursor: number };

/**
 * セーブ/ロード画面の確認ダイアログ（上書き・進行の破棄）。`cursor` は 0 = はい / 1 = いいえ（誤操作しにくいよう「いいえ」から始める）。
 * 出すかどうかの判断は runtime が行い（`askConfirm`）、core は選択だけを扱う。
 */
export interface MenuConfirm {
  readonly kind: "save" | "load";
  readonly slot: number;
  readonly cursor: 0 | 1;
}

/**
 * ショップ画面（`ShopProcessing` が開く）。商品・売却の可否・呼び出したインタプリタ（`owner`）を持ち、閉じるとマップに戻ってそのインタプリタが再開する。
 * `quantity` は一覧で品物を選んだあとの数量の選択中だけある。
 */
export interface ShopScene {
  readonly kind: "shop";
  readonly goods: readonly ItemId[];
  readonly canSell: boolean;
  readonly owner: string;
  readonly screen: ShopScreen;
  readonly cursor: number;
  readonly quantity?: number;
}

/**
 * どのシーンにいるか。タイトルとメニューの UI 状態（画面・カーソル）は GameState の一部なので、
 * UI 操作も入力列から再現できる（リプレイ可能）。
 */
export type SceneState =
  | { readonly kind: "map" }
  | { readonly kind: "title"; readonly screen: TitleScreen; readonly cursor: number }
  /** `portal` は、イベント（`SaveGame` / `LoadGame`）がセーブ/ロード画面を直接開いたとき。キャンセルでメインメニューではなくマップに戻る。 */
  | {
      readonly kind: "menu";
      readonly screen: MenuScreen;
      readonly cursor: number;
      readonly confirm?: MenuConfirm;
      readonly portal?: boolean;
      /** `skill` 画面で、使う人（`party.members` の位置）を選んだあと。ないあいだは `cursor` が使う人を指す。 */
      readonly actor?: number;
      /** `item` / `skill` 画面で、使うものを選んで対象を選んでいる間。 */
      readonly pick?: MenuPick;
    }
  | ShopScene
  | { readonly kind: "battle" | "gameover" };

/** 移動できるもの（プレイヤー・イベント・フォロワー）。タイル座標。 */
export interface Character {
  readonly x: number;
  readonly y: number;
  /** 補間用（タイル単位の小数）。`moving` の間は (x, y) に向かって進む。 */
  readonly realX: number;
  readonly realY: number;
  readonly direction: Direction;
  readonly moving: boolean;
  readonly speed: 1 | 2 | 3 | 4 | 5 | 6;
  readonly graphic?: { readonly asset: AssetId; readonly index: number };
  readonly through: boolean;
}

/** マップ上のイベントの実行時状態。有効なページの内容（trigger / priority / through / graphic）を写している。 */
export interface EventRuntime extends Character {
  readonly id: EventId;
  /** 現在有効なページ。どのページの条件も満たさなければ `null`（何も起こらず、衝突もしない）。 */
  readonly pageIndex: number | null;
  readonly trigger: EventPage["trigger"] | null;
  readonly priority: EventPage["priority"];
}

export interface MapState {
  readonly mapId: MapId;
  /** ロード時点のマップ名（セーブのプレビュー用）。 */
  readonly name: string;
  readonly player: Character;
  readonly events: Record<EventId, EventRuntime>;
  readonly followers: readonly Character[];
  /** 画面左上のタイル座標（小数）。 */
  readonly camera: { readonly x: number; readonly y: number };
  /** 場所移動の予約。次の tick でマップが読み込めていれば適用される。 */
  readonly transfer?: {
    readonly to: MapId;
    readonly x: number;
    readonly y: number;
    readonly dir: Direction;
    readonly fade: "black" | "white" | "none";
    /** `requestMapData` を発行済みか（同じ要求を毎フレーム出さないため）。 */
    readonly requested: boolean;
  };
  readonly encounterSteps: number;
  /**
   * このマップに入ってからの、プレイヤーの手数（歩いた・岩を押した・決定ボタンで足踏みした回数。滑っている間は数えない）。
   * `pace: "playerStep"` の移動ルートがこれを見て進む。数え始めるまで無い（0 と同じ）。
   */
  readonly turns?: number;
}

export interface ActorState {
  readonly id: ActorId;
  readonly name: string;
  readonly level: number;
  readonly exp: number;
  readonly hp: number;
  readonly mp: number;
}

export interface PartyState {
  readonly gold: number;
  readonly members: readonly ActorId[];
  readonly items: Record<ItemId, number>;
}

/** 表示中のメッセージ。テキストの制御文字の展開は runtime の責務で、ここには生のテキストを入れる。 */
export interface MessageState {
  readonly open: boolean;
  /** このメッセージを出したインタプリタの id。閉じている間は空文字列。 */
  readonly owner: string;
  readonly text: string;
  readonly face: AssetRef | null;
  readonly position: "top" | "middle" | "bottom";
  readonly background: "window" | "dim" | "transparent";
  /** 選択肢（`ShowChoices` / `SelectItem` / `ShopProcessing`）。表示中は `text` が見出しになる。 */
  readonly choices: readonly string[] | null;
  /** 選択肢のカーソル位置、または数値入力で編集中の桁（左端 = 0）。選択肢・数値入力のとき以外は無い。 */
  readonly cursor?: number;
  /** 数値入力（`InputNumber`）。`value` は現在の値（`digits` 桁）。 */
  readonly numberInput?: { readonly digits: number; readonly value: number };
}

export interface TimerState {
  readonly active: boolean;
  readonly ticks: number;
}

export interface GameState {
  /** 1/60 秒単位の経過フレーム。`step` ごとにちょうど 1 増える。 */
  readonly tick: number;
  readonly rng: RandomState;
  readonly scene: SceneState;
  readonly map: MapState;
  readonly party: PartyState;
  readonly actors: Record<ActorId, ActorState>;
  readonly switches: Record<SwitchId, boolean>;
  readonly variables: Record<VariableId, number>;
  readonly selfSwitches: Record<`${MapId}:${EventId}:${string}`, boolean>;
  /**
   * `ChangeMapTile` で書き換えたマスの、マップごとの一覧（`tileKey(layer, x, y)` → タイル番号）。書き換えるまで無い。
   * マップを出入りしても残り、セーブに含まれる。通行・氷・描画は `currentMap` がこれを重ねたマップを見る。
   */
  readonly mapTiles?: Record<MapId, Record<string, number>>;
  /**
   * プラグインが自分の状態を置く領域。キーはプラグインの名前、値は JSON にできる値（セーブに含まれる）。書き込むまで無い。
   * プラグインは自分の名前のキーだけを読み書きする（`pluginStateOf` / `withPluginState`）。
   */
  readonly pluginState?: Readonly<Record<string, JsonValue>>;
  /** 並列イベント分を含む。 */
  readonly interpreters: readonly InterpreterState[];
  /** 次に発行するインタプリタ id の連番。 */
  readonly nextInterpreterId: number;
  /** 戦闘中（`scene.kind === "battle"`）だけ存在する。詳細は docs/04-battle.md。 */
  readonly battle?: BattleState;
  readonly message: MessageState;
  readonly timers: TimerState;
  readonly playtimeTicks: number;
}

export const IDLE_MESSAGE: MessageState = {
  open: false,
  owner: "",
  text: "",
  face: null,
  position: "bottom",
  background: "window",
  choices: null,
};

export const selfSwitchKey = (mapId: MapId, eventId: EventId, key: string): `${MapId}:${EventId}:${string}` =>
  `${mapId}:${eventId}:${key}`;

/** `name` のプラグインの状態（書き込む前は `undefined`）。 */
export const pluginStateOf = (state: Pick<GameState, "pluginState">, name: string): JsonValue | undefined =>
  state.pluginState !== undefined && Object.hasOwn(state.pluginState, name) ? state.pluginState[name] : undefined;

/** `name` のプラグインの状態を `value` にした新しい状態。ほかのプラグインの状態には触れない。 */
export const withPluginState = <S extends Pick<GameState, "pluginState">>(state: S, name: string, value: JsonValue): S => ({
  ...state,
  pluginState: { ...state.pluginState, [name]: value },
});
