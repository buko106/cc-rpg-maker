import type { GameState } from "./types.js";

type ActorId = GameState["party"]["members"][number];

/** ゲーム変数の値（数値）。まだ設定されていなければ 0。 */
export const getVar = (s: GameState, name: string): number => (s.variables as Record<string, number>)[name] ?? 0;

/** ゲーム変数に値を入れた新しい状態（元の状態は変えない）。 */
export const setVar = (s: GameState, name: string, value: number): GameState => ({ ...s, variables: { ...s.variables, [name]: value } });

/** パーティの先頭（主人公）とそのアクター。パーティが空、またはアクターが見つからなければ undefined。 */
export const heroOf = (s: GameState): { id: ActorId; actor: GameState["actors"][ActorId] } | undefined => {
  const id = s.party.members[0];
  const actor = id === undefined ? undefined : s.actors[id];
  return id === undefined || actor === undefined ? undefined : { id, actor };
};
