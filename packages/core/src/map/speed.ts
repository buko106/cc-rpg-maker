import type { MapData, Project, StateCondition, SystemSettings, Tileset } from "@rpg/schema";
import type { Character, GameState } from "../state.js";
import { stateConditionHolds } from "./pages.js";

type Speed = Character["speed"];

/** 歩く速さの標準（`system.walkSpeed` も `MapData.walkSpeed` も無いとき、新しいキャラクターの速さ）。 */
export const DEFAULT_WALK_SPEED = 4;
/** 走ったときに速くなる段階（`system.dash.bonus` の既定）。 */
export const DEFAULT_DASH_BONUS = 1;

const clampSpeed = (n: number): Speed => Math.min(6, Math.max(1, Math.round(n))) as Speed;

/**
 * マップに入ったときのプレイヤーの歩く速さ。マップの `walkSpeed`、無ければ `system.walkSpeed`、どちらも無ければ `undefined`（いまの速さのまま）。
 */
export function mapWalkSpeed(system: Pick<SystemSettings, "walkSpeed">, map: Pick<MapData, "walkSpeed"> | undefined): Speed | undefined {
  const speed = map?.walkSpeed ?? system.walkSpeed;
  return speed === undefined ? undefined : clampSpeed(speed);
}

/** 速さへの影響の合計：`speed` は段階の増減、`noDash` は走れないか。 */
interface SpeedChange {
  readonly speed: number;
  readonly noDash: boolean;
}

const NONE: SpeedChange = { speed: 0, noDash: false };
const add = (a: SpeedChange, b: { speed?: number | undefined; noDash?: boolean | undefined }): SpeedChange => ({ speed: a.speed + (b.speed ?? 0), noDash: a.noDash || b.noDash === true });

/**
 * 足元（タイル (x, y)）の `Tileset.terrain`。どのレイヤにあっても効き、同じタイルが何枚重なっても 1 回だけ数える。
 */
export function footingChange(map: MapData, tileset: Tileset, x: number, y: number): SpeedChange {
  const terrain = tileset.terrain;
  if (terrain === undefined || x < 0 || y < 0 || x >= map.width || y >= map.height) return NONE;
  const index = y * map.width + x;
  const seen = new Set<number>();
  let change = NONE;
  for (const layer of map.layers) {
    const tile = layer.tiles[index] ?? 0;
    if (tile === 0 || seen.has(tile)) continue;
    seen.add(tile);
    const entry = Object.hasOwn(terrain, tile) ? terrain[tile] : undefined;
    if (entry !== undefined) change = add(change, entry);
  }
  return change;
}

/** `system.speedRules` のうち、いま条件を満たしているものの合計。 */
export function ruleChange(system: Pick<SystemSettings, "speedRules">, state: GameState): SpeedChange {
  let change = NONE;
  for (const rule of system.speedRules ?? []) {
    if (rule.when.every((c: StateCondition) => stateConditionHolds(c, state))) change = add(change, rule);
  }
  return change;
}

export interface StepSpeedInput {
  readonly project: Pick<Project, "system">;
  readonly map: MapData;
  readonly tileset: Tileset;
  readonly state: GameState;
  /** 走る操作（Shift・走るボタン）をしているか。 */
  readonly dashing: boolean;
}

/**
 * プレイヤーが歩き出す 1 歩の速さ（1〜6）：基準（`player.speed`）に、足元のタイル・状態の増減と、走るときの上乗せを足して丸める。
 * 走れるのは、`system.dash` があり、マップが `noDash` でなく、足元・状態のどれも `noDash` でないとき。
 */
export function playerStepSpeed({ project, map, tileset, state, dashing }: StepSpeedInput): Speed {
  const { system } = project;
  const { player } = state.map;
  const change = add(footingChange(map, tileset, player.x, player.y), ruleChange(system, state));
  const canDash = system.dash !== undefined && map.noDash !== true && !change.noDash;
  const bonus = dashing && canDash ? (system.dash?.bonus ?? DEFAULT_DASH_BONUS) : 0;
  return clampSpeed(player.speed + change.speed + bonus);
}
