// テスト専用：ダンジョンのデモ（fixtures/projects/v2/dungeon）をランタイムで動かすための道具。
import { createPluginRegistry, loadPlugins, selectPlugins, toRuntimeExtensions } from "@rpg/plugin-api";
import { createRuntimeHarness, expandInputs, loadFixtureProject } from "@rpg/test-utils";
import type { RuntimeHarness } from "@rpg/test-utils";
import { dungeonPlugin } from "./index.js";
import { readDungeon } from "./model.js";
import type { DungeonState } from "./model.js";
import { enemyAt } from "./turn.js";
import { cellOf, distances, DIRS, walkable } from "./generate.js";

type InputFrame = ReturnType<typeof expandInputs>[number];
const press = (button: Dir | "ok"): InputFrame => expandInputs([{ press: button }])[0] as InputFrame;
const blank = (): InputFrame => expandInputs([{ wait: 1 }])[0] as InputFrame;
export type Dir = "up" | "down" | "left" | "right";
const VEC: Record<Dir, [number, number]> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
export const dirOf = (dx: number, dy: number): Dir => (dx < 0 ? "left" : dx > 0 ? "right" : dy < 0 ? "up" : "down");

export interface Game {
  h: RuntimeHarness;
  state(): ReturnType<RuntimeHarness["runtime"]["getState"]>;
  ds(): DungeonState | undefined;
  /** 1 マス歩く（または、敵にぶつかる）。向きが違うときは、先に向きだけ変える。動きが終わるまで進める。 */
  step(dir: Dir): Promise<void>;
  /** 決定ボタンを 1 回押して、動きが終わるまで進める。 */
  ok(): Promise<void>;
  idle(frames: number): Promise<void>;
  /** 町から洞窟に入る（洞窟の入口に触れて「入る」を選ぶ）。 */
  enter(): Promise<void>;
}

export async function boot(seed = "dungeon", patch?: (params: Record<string, unknown>) => Record<string, unknown>): Promise<Game> {
  const project = loadFixtureProject("dungeon", 2).project;
  const refs = project.system.plugins.map((p) => (p.name === "dungeon" && patch !== undefined ? { ...p, params: patch({ ...p.params }) } : p));
  const selection = selectPlugins([dungeonPlugin], refs);
  const registry = createPluginRegistry();
  const result = await loadPlugins(selection.modules, registry, { params: selection.params });
  if (result.failed.length > 0) throw new Error(String(result.failed[0]?.error));
  const h = await createRuntimeHarness({ project: "dungeon", projectVersion: 2, seed, extensions: toRuntimeExtensions(registry) });
  const state = () => h.runtime.getState();
  /** 1 フレームずつ進める。マップの読み込みで止まったら、終わるまで待つ。 */
  const frames = async (...inputs: InputFrame[]): Promise<void> => {
    for (const input of inputs) {
      h.input.push(input);
      h.advanceFrames(1);
      if (h.runtime.status !== "running") await h.runtime.settled();
    }
  };
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 40 && state().map.player.moving; i++) await frames(blank());
  };
  return {
    h,
    state,
    ds: () => readDungeon(state()),
    async step(dir) {
      // 振り向き（system.turnInPlace）が有効なので、向きが違うときは、まず向きだけ変える
      if (state().map.player.direction !== dir) await frames(press(dir), blank());
      await frames(press(dir));
      await settle();
    },
    async ok() {
      await frames(press("ok"));
      await settle();
    },
    idle: (n) => frames(...Array.from({ length: n }, blank)),
    async enter() {
      await frames(press("up"), blank()); // 上を向く（振り向き）
      for (let i = 0; i < 4; i++) await frames(press("up"), ...Array.from({ length: 15 }, blank)); // 洞窟の入口の手前まで
      await frames(press("up"));
      for (let i = 0; i < 600 && state().map.mapId !== "map_floor"; i++) await frames(i % 20 === 0 ? press("ok") : blank());
      await frames(...Array.from({ length: 60 }, blank)); // 明転まで
    },
  };
}

/** プレイヤーの位置から `goal` へ歩く最短の道の最初の 1 歩（敵は避けない。敵のいるマスなら、ぶつかって攻撃になる）。 */
export function nextMove(ds: DungeonState, goal: { x: number; y: number }): Dir | undefined {
  const from = { x: ds.px, y: ds.py };
  {
    const dist = distances(ds.grid, ds.width, ds.height, goal);
    let best: { d: number; dir: Dir } | undefined;
    for (const v of DIRS) {
      const n = { x: from.x + v.x, y: from.y + v.y };
      const d = dist.get(cellOf(ds.width, n));
      if (d !== undefined && (best === undefined || d < best.d)) best = { d, dir: dirOf(v.x, v.y) };
    }
    if (best !== undefined) return best.dir;
  }
  return undefined;
}

/** 隣に敵がいれば、その方向。 */
export function adjacentEnemy(ds: DungeonState): Dir | undefined {
  for (const [dir, [dx, dy]] of Object.entries(VEC) as [Dir, [number, number]][]) if (enemyAt(ds, ds.px + dx, ds.py + dy) !== undefined) return dir;
  return undefined;
}

export { walkable };
