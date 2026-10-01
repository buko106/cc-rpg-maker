import type { MapData, TroopId } from "@rpg/schema";
import { createRandom } from "../random.js";

/** `MapData.encounterStep` の既定値（平均歩数）。 */
export const DEFAULT_ENCOUNTER_STEP = 30;

/** このマップでランダムエンカウントが起きるか（`encounters` に 1 つ以上ある）。 */
export const hasEncounters = (map: MapData): boolean => (map.encounters?.length ?? 0) > 0;

/** 戦闘の直後（`encounterSteps` が 0）から、遭遇しない歩数。平均の半分。 */
export const encounterSafeSteps = (map: MapData): number => Math.floor((map.encounterStep ?? DEFAULT_ENCOUNTER_STEP) / 2);

/**
 * 1 歩あるいたあとの遭遇判定。`steps` は戦闘からの歩数（この 1 歩を含む）。
 * 最初の `encounterSafeSteps` 歩は遭遇せず、それ以降は 1 歩ごとに `1 / (平均 - 安全歩数)` の確率で遭遇する（平均歩数がほぼ `encounterStep` になる）。
 * 乱数は `seed` と `tick` から作る独立ストリームで、マップの乱数（`rng`）には触れない。そのためエンカウントの有無でイベントの乱数列は変わらず、
 * 同じシード・同じ入力ならリプレイでも同じ場所で遭遇する。遭遇するときはトループを返す（`weight` の比で選ぶ）。
 */
export function rollEncounter(map: MapData, steps: number, seed: string, tick: number): TroopId | undefined {
  const table = map.encounters ?? [];
  if (table.length === 0) return undefined;
  const average = map.encounterStep ?? DEFAULT_ENCOUNTER_STEP;
  const safe = encounterSafeSteps(map);
  if (steps <= safe) return undefined;
  const rng = createRandom(seed).fork(`encounter:${tick}`);
  if (rng.next() >= 1 / Math.max(1, average - safe)) return undefined;
  const total = table.reduce((sum, e) => sum + e.weight, 0);
  let roll = rng.next() * total;
  for (const e of table) {
    roll -= e.weight;
    if (roll < 0) return e.troop;
  }
  return table[table.length - 1]!.troop;
}
