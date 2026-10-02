import type { EventPage, MapData } from "@rpg/schema";
import type { GameState } from "../state.js";

/** そのページの移動ルートは、プレイヤーの手に合わせて進む（ターン制）か。 */
export const isPacedPage = (page: EventPage | undefined): boolean => page?.moveRoute?.pace === "playerStep";

/**
 * ターン制で動いているイベントが、いまマップに居るか：有効なページがターン制の移動ルートを持つ、または `SetMoveRoute` のターン制のルートで動かされている
 * （`forced` は、そのルートの対象のイベント id）。
 */
export const hasPacedEvents = (state: GameState, map: MapData, forced: readonly string[] = []): boolean =>
  forced.length > 0 || Object.values(state.map.events).some((ev) => ev.pageIndex !== null && isPacedPage(map.events[ev.id]?.pages[ev.pageIndex]));

/** ターン制のイベントが、いま歩いている最中か（プレイヤーは、みんなの動きが終わるまで次の手を打てない）。 */
export const pacedEventsMoving = (state: GameState, map: MapData, forced: readonly string[] = []): boolean =>
  Object.values(state.map.events).some((ev) => ev.moving && ((ev.pageIndex !== null && isPacedPage(map.events[ev.id]?.pages[ev.pageIndex])) || forced.includes(ev.id)));

/** プレイヤーが 1 手打った（歩いた・押した・足踏みした）後の状態。 */
export const withTurn = (state: GameState): GameState => ({ ...state, map: { ...state.map, turns: (state.map.turns ?? 0) + 1 } });
