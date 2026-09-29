import type { Actor, Class, MapData, Param } from "@rpg/schema";
import type { Ctx } from "../ctx.js";
import { computeCamera, initialEventRuntimes, newCharacter, refreshEventPages } from "../map/index.js";
import { createRandom } from "../random.js";
import { IDLE_MESSAGE } from "../state.js";
import type { ActorState, GameState, MapState } from "../state.js";

/** レベル `level` でのパラメータ値。`base + growth * (level - 1)` の切り捨て。 */
export function paramAt(cls: Class | undefined, param: Param, level: number): number {
  const curve = cls?.params[param];
  return curve === undefined ? 0 : Math.floor(curve.base + curve.growth * (level - 1));
}

function initialActor(actor: Actor, cls: Class | undefined): ActorState {
  return {
    id: actor.id,
    name: actor.name,
    level: actor.initialLevel,
    exp: 0,
    hp: Math.max(1, paramAt(cls, "mhp", actor.initialLevel)),
    mp: paramAt(cls, "mmp", actor.initialLevel),
  };
}

/** マップに入ったときの MapState を作る（プレイヤーは呼び出し側が決める）。イベントのページは未評価。 */
export function enterMap(map: MapData, name: string, player: MapState["player"]): MapState {
  return { mapId: map.id, name, player, events: initialEventRuntimes(map), followers: [], camera: { x: 0, y: 0 }, encounterSteps: 0 };
}

/**
 * ニューゲーム直後の状態を作る。`seed` から乱数を初期化する。
 * 開始マップがロード済みなら最初からその上にいる。未ロードなら開始位置への場所移動を予約し、
 * 最初の `tick` で `requestMapData` が発行される。
 */
export function initialState(ctx: Ctx, seed: string): GameState {
  const { system, database } = ctx.project.project;
  const actors: GameState["actors"] = {};
  for (const actor of Object.values(database.actors)) actors[actor.id] = initialActor(actor, ctx.project.class(actor.classId));
  const members = system.initialParty.filter((id) => actors[id] !== undefined);

  const leader = members[0] === undefined ? undefined : ctx.project.actor(members[0]);
  const player = {
    ...newCharacter(system.startX, system.startY, "down"),
    ...(leader?.walk ? { graphic: { asset: leader.walk.asset, index: 0 } } : {}),
  };
  const mapName = ctx.project.project.maps[system.startMap]?.name ?? "";
  const startMap = ctx.project.map(system.startMap);

  const base: GameState = {
    tick: 0,
    rng: createRandom(seed).serialize(),
    scene: { kind: "map" },
    map: startMap
      ? enterMap(startMap, mapName, player)
      : {
          mapId: system.startMap, name: mapName, player, events: {}, followers: [], camera: { x: 0, y: 0 }, encounterSteps: 0,
          transfer: { to: system.startMap, x: system.startX, y: system.startY, dir: "down", fade: "none", requested: false },
        },
    party: { gold: 0, members, items: {} },
    actors,
    switches: {},
    variables: {},
    selfSwitches: {},
    interpreters: [],
    nextInterpreterId: 0,
    message: IDLE_MESSAGE,
    timers: { active: false, ticks: 0 },
    playtimeTicks: 0,
  };
  if (!startMap) return base;
  const refreshed = refreshEventPages(base, startMap);
  return { ...refreshed, map: { ...refreshed.map, camera: computeCamera(player, startMap, system) } };
}
