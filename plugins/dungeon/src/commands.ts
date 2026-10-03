import { defineCommand, getVar, heroOf, paramAt, setVar, z } from "@rpg/plugin-api";
import type { CommandCtx, CommandHandler, CommandResult, Effect, GameState } from "@rpg/plugin-api";
import type { Config } from "./config.js";
import { buildFloor } from "./floor.js";
import type { BuiltFloor } from "./floor.js";
import { floorTiles, walkable } from "./generate.js";
import { cloneDungeon, readDungeon, withDungeon } from "./model.js";
import type { DungeonState } from "./model.js";
import { arriveAt, attackEnemy, endTurn, enemyAt, reveal, refreshStats, say } from "./turn.js";
import type { Env, Work } from "./turn.js";

const VECTOR = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] } as const;
/** ダンジョンの中でのプレイヤーの歩く速さ（`Character.speed`）。 */
const PLAYER_SPEED = 5;
const warnLog = (message: string): Effect => ({ kind: "log", level: "warn", message });

/** 設定を読めなかったとき（プロジェクトの `system.plugins` の `params` の誤り）。コマンドは何もせず、警告だけ出す。 */
export type ConfigResult = { ok: true; config: Config } | { ok: false; message: string };

/** データベースと乱数への窓口を作る（主人公の能力は、職業のパラメータ曲線から）。 */
export function makeEnv(cfg: Config, c: Pick<CommandCtx, "state" | "project" | "rng">): Env | undefined {
  const hero = heroOf(c.state);
  if (hero === undefined) return undefined;
  const cls = c.project.class(c.project.actor(hero.actor.id)?.classId ?? ("" as never));
  return {
    cfg,
    heroName: hero.actor.name,
    heroStats: (level) => ({ mhp: Math.max(1, paramAt(cls, "mhp", level)), atk: Math.max(1, paramAt(cls, "atk", level)), def: Math.max(0, paramAt(cls, "def", level)) }),
    enemy: (id) => {
      const e = c.project.enemy(id as never);
      return e === undefined ? undefined : { name: e.name, mhp: e.params.mhp, atk: e.params.atk, def: e.params.def, exp: e.exp, gold: e.gold, drops: e.drops.map((d) => ({ item: d.item, rate: d.rate })) };
    },
    itemName: (id) => c.project.item(id as never)?.name ?? id,
    rng: c.rng,
  };
}

const mhpOfEnemy = (c: Pick<CommandCtx, "project">) => (id: string): number => Math.max(1, c.project.enemy(id as never)?.params.mhp ?? 1);

/** 階を `ds` に反映する（地形・敵・物・歩いた場所を作り直し、プレイヤーを開始位置に置く）。 */
function placeFloor(ds: DungeonState, built: BuiltFloor, floorNo: number, tick: number): void {
  const { floor, population } = built;
  ds.floor = floorNo;
  ds.width = floor.width;
  ds.height = floor.height;
  ds.grid = floor.grid;
  ds.seen = "0".repeat(floor.grid.length);
  ds.rooms = floor.rooms.map((r) => [r.x, r.y, r.w, r.h]);
  ds.goal = [floor.goal.x, floor.goal.y];
  ds.px = floor.start.x;
  ds.py = floor.start.y;
  ds.enemies = population.enemies.map((e) => ({ ...e }));
  ds.items = population.items.map((i) => ({ ...i }));
  ds.fx = [];
  ds.ft = tick;
  ds.nextId = population.enemies.length + 1;
  reveal(ds);
}

/** 状態の中の、ひな形のマップの地形とプレイヤーの位置を、階に合わせる。 */
function withFloor(s: GameState, cfg: Config, built: BuiltFloor): GameState {
  const { start } = built.floor;
  const player = { ...s.map.player, x: start.x, y: start.y, realX: start.x, realY: start.y, moving: false, speed: PLAYER_SPEED as 5, direction: "down" as const };
  return {
    ...s,
    mapTiles: { ...s.mapTiles, [cfg.floorMap]: floorTiles(built.floor, cfg.tiles) },
    map: s.map.mapId === cfg.floorMap ? { ...s.map, player } : { ...s.map, player: { ...s.map.player, speed: PLAYER_SPEED as 5 } },
  };
}

const withHero = (s: GameState, hero: Work["hero"]): GameState => {
  const h = heroOf(s);
  return h === undefined ? s : { ...s, actors: { ...s.actors, [h.id]: { ...h.actor, level: hero.level, exp: hero.exp, hp: Math.max(0, hero.hp) } } };
};

const transfer = (cfg: Config) => ({
  kind: "call" as const,
  commands: [{ code: "TransferPlayer", params: { mapId: cfg.home.map, x: cfg.home.x, y: cfg.home.y, dir: cfg.home.dir, fade: "black" }, indent: 0 }],
});

const none = (message: string): CommandResult => ({ effects: [warnLog(message)] });

/** 3 つのコマンドを作る。`config` は、プラグインの設定（読めなかったときはその理由）。 */
export function createCommands(config: () => ConfigResult): CommandHandler<any>[] {
  const enter = defineCommand({
    code: "Enter",
    params: z.strictObject({}),
    meta: { label: "ダンジョンに入る", category: "ダンジョン", describe: () => "ダンジョンに入る（1 階から。入るたびに地形が変わる）", refs: () => [] },
    run(_, c) {
      const cfgr = config();
      if (!cfgr.ok) return none(cfgr.message);
      const cfg = cfgr.config;
      const env = makeEnv(cfg, c);
      if (env === undefined) return none("plugin:dungeon/Enter: パーティに主人公がいない");
      const seed = `${c.state.rng.seed}:${c.rng.int(0, 0x3fffffff)}`;
      const built = buildFloor(seed, 1, cfg, mhpOfEnemy(c));
      const hero = heroOf(c.state)!;
      const w: Work = {
        ds: {
          v: 1, seed, floor: 1, turn: 0, belly: cfg.belly.max, atkBonus: 0, gold0: c.state.party.gold, width: 0, height: 0, grid: "", seen: "", rooms: [], goal: [0, 0], px: 0, py: 0,
          mhp: 1, atk: 1, def: 0, enemies: [], items: [], log: [], fx: [], ft: c.state.tick, nextId: 1, kills: 0,
        },
        hero: cfg.resetOnEnter ? { level: 1, exp: 0, hp: 1 } : { level: hero.actor.level, exp: hero.actor.exp, hp: hero.actor.hp },
        gold: c.state.party.gold,
        items: cfg.resetOnEnter ? { ...cfg.startItems } : { ...c.state.party.items },
        tick: c.state.tick,
      };
      placeFloor(w.ds, built, 1, c.state.tick);
      refreshStats(w, env);
      if (cfg.resetOnEnter) w.hero.hp = w.ds.mhp;
      say(w, "ダンジョンに 入った。");
      let s = withFloor(c.state, cfg, built);
      s = withHero(s, w.hero);
      s = { ...s, party: { ...s.party, gold: w.gold, items: w.items as GameState["party"]["items"] } };
      s = setVar(s, cfg.vars.event, 0);
      s = withDungeon(s, w.ds);
      return {
        state: s,
        control: { kind: "call", commands: [{ code: "TransferPlayer", params: { mapId: cfg.floorMap, x: built.floor.start.x, y: built.floor.start.y, dir: "down", fade: "black" }, indent: 0 }] },
      };
    },
  });

  const tick = defineCommand({
    code: "Tick",
    params: z.strictObject({}),
    meta: { label: "ダンジョンの 1 コマ", category: "ダンジョン", describe: () => "ダンジョンを 1 コマ進める（フロアのコントローラの並列イベントに置く）", refs: () => [] },
    run(_, c) {
      const cfgr = config();
      if (!cfgr.ok) return {};
      const cfg = cfgr.config;
      const s = c.state;
      const before = readDungeon(s);
      if (before === undefined || s.scene.kind !== "map" || s.map.mapId !== cfg.floorMap) return {};
      if (s.message.open || s.interpreters.some((i) => i.mode === "normal") || getVar(s, cfg.vars.event) !== 0) return {};
      const p = s.map.player;
      const moved = p.x !== before.px || p.y !== before.py;
      const wait = !p.moving && c.input.triggered.has("ok");
      if (!moved && !wait) return {};
      const env = makeEnv(cfg, c);
      const hero = heroOf(s);
      if (env === undefined || hero === undefined) return {};

      const w: Work = { ds: cloneDungeon(before), hero: { level: hero.actor.level, exp: hero.actor.exp, hp: hero.actor.hp }, gold: s.party.gold, items: { ...s.party.items }, tick: s.tick };
      let player = p;
      let skipTurn = false;
      if (moved) {
        const target = enemyAt(w.ds, p.x, p.y);
        const [dx, dy] = VECTOR[p.direction];
        if (target !== undefined) {
          // 敵のいるマスへは入れない：半歩だけ踏み出して戻る（ぶつかって攻撃）
          player = { ...p, x: w.ds.px, y: w.ds.py, realX: w.ds.px + dx * 0.5, realY: w.ds.py + dy * 0.5, moving: true };
          attackEnemy(w, env, target);
        } else if (walkable(w.ds.grid[p.y * w.ds.width + p.x])) arriveAt(w, env, p.x, p.y);
        else {
          // 岩の中へ入ってしまった（ありえないはずの状態）：元の位置に戻して、ターンは進めない
          player = { ...p, x: w.ds.px, y: w.ds.py, realX: w.ds.px, realY: w.ds.py, moving: false };
          skipTurn = true;
        }
      } else {
        // 決定ボタン：目の前の敵を攻撃する。いなければ、その場で 1 ターン休む
        const [dx, dy] = VECTOR[p.direction];
        const target = enemyAt(w.ds, w.ds.px + dx, w.ds.py + dy);
        if (target !== undefined) attackEnemy(w, env, target);
      }
      if (w.outcome === undefined && !skipTurn) endTurn(w, env);

      let next = withHero({ ...s, map: { ...s.map, player } }, w.hero);
      next = { ...next, party: { ...s.party, gold: w.gold, items: w.items as GameState["party"]["items"] } };
      const effects: Effect[] = [];
      if (w.outcome === "dead") {
        next = setVar(next, cfg.vars.event, 1);
      } else if (w.outcome === "treasure") {
        next = setVar(next, cfg.vars.event, 2);
      } else if (w.outcome === "stairs") {
        const floorNo = w.ds.floor + 1;
        const built = buildFloor(w.ds.seed, floorNo, cfg, mhpOfEnemy(c));
        placeFloor(w.ds, built, floorNo, s.tick);
        say(w, `地下 ${floorNo} 階に 降りた。`);
        next = withFloor(next, cfg, built);
        next = setVar(next, cfg.vars.best, Math.max(getVar(next, cfg.vars.best), floorNo));
        effects.push({ kind: "screenFlash", color: { r: 255, g: 255, b: 255, a: 1 }, durationTicks: 14 });
      }
      if (w.outcome === "dead") effects.push({ kind: "screenFlash", color: { r: 200, g: 40, b: 40, a: 1 }, durationTicks: 20 });
      return { state: withDungeon(next, w.ds), effects };
    },
  });

  const finish = defineCommand({
    code: "Finish",
    params: z.strictObject({ result: z.enum(["dead", "clear"]) }),
    meta: {
      label: "ダンジョンを出る",
      category: "ダンジョン",
      describe: (p) => (p.result === "dead" ? "ダンジョンを出る（倒れたとき：持ち物とお金を失う）" : "ダンジョンを出る（宝を持ち帰ったとき）"),
      refs: () => [],
    },
    run(p, c) {
      const cfgr = config();
      if (!cfgr.ok) return none(cfgr.message);
      const cfg = cfgr.config;
      const ds = readDungeon(c.state);
      let s = c.state;
      const cleared = p.result === "clear";
      if (ds !== undefined) {
        const best = Math.max(getVar(s, cfg.vars.best), cleared ? cfg.goalFloor : ds.floor);
        s = setVar(s, cfg.vars.best, best);
        // 倒れると、持ち物と、ダンジョンで手に入れたお金を失う
        s = { ...s, party: cleared ? { ...s.party, gold: s.party.gold + cfg.clearGold } : { ...s.party, gold: Math.min(s.party.gold, ds.gold0), items: {} } };
      }
      s = setVar(setVar(s, cfg.vars.result, cleared ? 2 : 1), cfg.vars.clears, getVar(s, cfg.vars.clears) + (cleared ? 1 : 0));
      // 戻ったときは HP 全回復
      const hero = heroOf(s);
      const env = makeEnv(cfg, { state: s, project: c.project, rng: c.rng });
      if (hero !== undefined && env !== undefined) s = withHero(s, { level: hero.actor.level, exp: hero.actor.exp, hp: env.heroStats(hero.actor.level).mhp });
      s = setVar(s, cfg.vars.event, 0);
      s = withDungeon(s, null);
      return { state: s, control: transfer(cfg) };
    },
  });

  return [enter, tick, finish];
}
