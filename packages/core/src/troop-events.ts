import { IDLE_MESSAGE } from "./state.js";
import type { GameState } from "./state.js";

/** 敵グループのバトルイベントのインタプリタを取り除く。それが出していたメッセージも閉じる。 */
export function withoutTroopEvents<S extends Pick<GameState, "interpreters" | "message">>(state: S): S {
  const troop = state.interpreters.filter((i) => i.origin.kind === "troop");
  if (troop.length === 0) return state;
  const ids = new Set(troop.map((i) => i.id));
  const ownMessage = ids.has(state.message.owner);
  return { ...state, interpreters: state.interpreters.filter((i) => !ids.has(i.id)), ...(ownMessage ? { message: IDLE_MESSAGE } : {}) };
}
