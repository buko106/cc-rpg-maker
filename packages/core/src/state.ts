import type { ActorId, AssetId, AssetRef, Direction, EventId, EventPage, ItemId, MapId, SwitchId, VariableId } from "@rpg/schema";
import type { InterpreterState } from "./interpreter/state.js";
import type { RandomState } from "./random.js";

export type SceneState = { readonly kind: "title" | "map" | "battle" | "menu" | "gameover" };

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
  readonly choices: readonly string[] | null;
}

export interface TimerState {
  readonly active: boolean;
  readonly ticks: number;
}

/** 戦闘の状態。M4（docs/04-battle.md）で定義する。それまでは常に存在しない。 */
export type BattleState = Readonly<Record<string, unknown>>;

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
  /** 並列イベント分を含む。 */
  readonly interpreters: readonly InterpreterState[];
  /** 次に発行するインタプリタ id の連番。 */
  readonly nextInterpreterId: number;
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
