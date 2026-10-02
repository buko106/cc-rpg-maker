import { createPluginRegistry, loadPlugins, toRuntimeExtensions } from "@rpg/plugin-api";
import { createRuntimeHarness, expandInputs, hashState } from "@rpg/test-utils";
import { describe, expect, it } from "vitest";
import { generateFloor, walkable } from "./generate.js";
import { adjacentEnemy, boot, dirOf, nextMove } from "./harness.testkit.js";
import type { Game } from "./harness.testkit.js";
import { dungeonPlugin } from "./index.js";
import { cellOf } from "./generate.js";

const vars = (g: Game): Record<string, number> => g.state().variables as Record<string, number>;
const hero = (g: Game) => g.state().actors["actor_hero" as never]!;
const items = (g: Game): Record<string, number> => g.state().party.items as Record<string, number>;
const texts = (g: Game): string[] => {
  const walk = (n: { kind: string; text?: string; children?: readonly unknown[] }): string[] => (n.kind === "text" ? [n.text ?? ""] : ((n.children ?? []) as (typeof n)[]).flatMap(walk));
  return g.h.runtime.project().ui.flatMap((n) => walk(n as never));
};

/** `goal` に向かって歩く。隣に敵がいれば殴る。`stop` が真になるか、`max` 手で止まる。 */
async function walk(g: Game, goal: () => { x: number; y: number }, stop: () => boolean, max = 400): Promise<void> {
  for (let i = 0; i < max && !stop(); i++) {
    const ds = g.ds();
    if (ds === undefined || g.state().map.mapId !== "map_floor") return;
    const dir = adjacentEnemy(ds) ?? nextMove(ds, goal());
    if (dir === undefined) return;
    await g.step(dir);
  }
}
const toStairs = (g: Game) => ({ x: g.ds()!.goal[0], y: g.ds()!.goal[1] });
const floorOf = (g: Game): number => g.ds()?.floor ?? 0;
const dead = (g: Game): boolean => (vars(g)["var_dungeon_event"] ?? 0) !== 0;

describe("洞窟に入る", () => {
  it("町の洞窟の入口に触れて「入る」を選ぶと、1 階が作られて、フロアのひな形に移る。レベル 1・HP 全回復・持ち物は最初のくすり草だけ", async () => {
    const g = await boot("enter");
    g.h.runtime.getState();
    expect(g.state().map.mapId).toBe("map_town");
    await g.enter();
    expect(g.state().map.mapId).toBe("map_floor");
    const ds = g.ds()!;
    expect(ds).toMatchObject({ v: 1, floor: 1, turn: 0, belly: 100, kills: 0, atkBonus: 0 });
    expect(ds.seed).toMatch(/^enter:\d+$/);
    expect(ds.width * ds.height).toBe(ds.grid.length);
    expect(ds.seen).toHaveLength(ds.grid.length);
    expect(ds.seen.split("").filter((c) => c === "1").length).toBeGreaterThan(0); // 開始位置のまわりは見えている
    expect(g.state().map.player).toMatchObject({ x: ds.px, y: ds.py, speed: 5, moving: false });
    expect(hero(g)).toMatchObject({ level: 1, exp: 0, hp: 30 });
    expect(ds).toMatchObject({ mhp: 30, atk: 7, def: 3 });
    expect(items(g)).toEqual({ item_herb: 2 });
    expect(Object.keys(g.state().mapTiles?.["map_floor" as never] ?? {}).length).toBeGreaterThan(100);
    expect(g.h.warnings).toEqual([]);
    expect(g.h.errors).toEqual([]);
  });

  it("確認で「やめておく」（下 → 決定）を選ぶと、入らない。キャンセルでも同じ", async () => {
    for (const pick of ["cancel", "down"] as const) {
      const g = await boot(`no-${pick}`);
      for (let i = 0; i < 4; i++) await g.step("up");
      await g.step("up"); // 洞窟に触れる
      await g.ok(); // 文章を送って、選択肢まで進める
      await g.idle(5);
      expect(g.state().message.choices).toEqual(["入る", "やめておく"]);
      if (pick === "down") await g.step("down");
      await (pick === "down" ? g.ok() : g.h.play(...expandInputs([{ press: "cancel" }])));
      await g.idle(120);
      expect(g.state().map.mapId).toBe("map_town");
      expect(g.ds()).toBeUndefined();
      expect(g.state().message.open).toBe(false);
    }
  });

  it("同じシードで同じ操作をすると、同じフロア（リプレイできる）。シードが違えば別のフロア", async () => {
    const run = async (seed: string): Promise<string> => {
      const g = await boot(seed);
      await g.enter();
      return g.ds()!.grid;
    };
    expect(await run("same")).toBe(await run("same"));
    expect(await run("same")).not.toBe(await run("other"));
  });

  it("フロアのひな形のマップは、全マスが岩で、コントローラが 1 つだけ", async () => {
    const g = await boot("tpl");
    const map = g.h.loaded.maps["map_floor" as never] as { width: number; height: number; layers: { tiles: number[] }[]; events: Record<string, unknown> };
    expect(map.width * map.height).toBe(39 * 27);
    expect(new Set(map.layers[0]!.tiles)).toEqual(new Set([1]));
    expect(Object.keys(map.events)).toEqual(["ev_dungeon"]);
  });
});

describe("1 歩ごとのターン", () => {
  it("1 歩歩くとターンが 1 進み、敵も動く。歩いた場所が見えるようになる", async () => {
    const g = await boot("turns");
    await g.enter();
    const before = g.ds()!;
    const seenBefore = before.seen.split("").filter((c) => c === "1").length;
    const dir = nextMove(before, { x: before.goal[0], y: before.goal[1] })!;
    await g.step(dir);
    const after = g.ds()!;
    expect(after.turn).toBe(1);
    expect([after.px, after.py]).not.toEqual([before.px, before.py]);
    expect([after.px, after.py]).toEqual([g.state().map.player.x, g.state().map.player.y]);
    expect(after.seen.split("").filter((c) => c === "1").length).toBeGreaterThanOrEqual(seenBefore);
    // 何歩か歩くと、どれかの敵が動く
    const start = JSON.stringify(before.enemies.map((e) => [e.x, e.y]));
    await walk(g, () => ({ x: after.goal[0], y: after.goal[1] }), () => g.ds()!.turn >= 12 || floorOf(g) > 1);
    expect(JSON.stringify(g.ds()?.enemies.map((e) => [e.x, e.y]))).not.toBe(start);
  });

  it("決定ボタンで、目の前に敵がいなければ その場で 1 ターン休む（位置は変わらない）", async () => {
    const g = await boot("rest");
    await g.enter();
    const before = g.ds()!;
    expect(adjacentEnemy(before)).toBeUndefined();
    await g.ok();
    const after = g.ds()!;
    expect(after.turn).toBe(1);
    expect([after.px, after.py]).toEqual([before.px, before.py]);
    for (let i = 0; i < 3; i++) await g.ok();
    expect(g.ds()!.turn).toBe(4);
    expect(g.ds()!.belly).toBe(99); // 4 ターンで満腹度 1
  });

  it("敵にぶつかると攻撃になる（位置は変わらず、1 回ぶつかるごとに 1 ターン）。倒すと経験値と、倒したというログ", async () => {
    const g = await boot("fight");
    await g.enter();
    const target = () => {
      const ds = g.ds()!;
      const e = [...ds.enemies].sort((a, b) => Math.abs(a.x - ds.px) + Math.abs(a.y - ds.py) - (Math.abs(b.x - ds.px) + Math.abs(b.y - ds.py)))[0]!;
      return { x: e.x, y: e.y };
    };
    await walk(g, target, () => adjacentEnemy(g.ds()!) !== undefined || dead(g), 300);
    const dir = adjacentEnemy(g.ds()!)!;
    const ds0 = g.ds()!;
    const turn0 = ds0.turn;
    const pos0 = [ds0.px, ds0.py];
    await g.step(dir);
    const ds1 = g.ds()!;
    expect(ds1.turn).toBe(turn0 + 1);
    expect([ds1.px, ds1.py]).toEqual(pos0);
    expect([g.state().map.player.x, g.state().map.player.y]).toEqual(pos0);
    expect(ds1.fx.some((f) => f.tone === "dmg")).toBe(true);
    for (let i = 0; i < 12 && g.ds()!.kills === 0 && !dead(g); i++) await g.step(dir);
    if (!dead(g)) {
      expect(g.ds()!.kills).toBeGreaterThanOrEqual(1);
      expect(hero(g).exp).toBeGreaterThan(0);
      expect(g.ds()!.log.some((l) => l.includes("たおした"))).toBe(true);
    }
  });

  it("[inv] 同じシードと同じ入力なら、同じ結果になる", async () => {
    const play = async (): Promise<string> => {
      const g = await boot("repeat");
      await g.enter();
      await walk(g, () => toStairs(g), () => g.ds()!.turn >= 40 || floorOf(g) > 1);
      return hashState(g.state());
    };
    expect(await play()).toBe(await play());
  });
});

describe("階段", () => {
  it("階段に着くと次の階が作られ、プレイヤーは新しい開始位置に立つ。最深階の変数が増える", async () => {
    const g = await boot("stairs");
    await g.enter();
    const grid1 = g.ds()!.grid;
    const tiles1 = g.state().mapTiles?.["map_floor" as never];
    await walk(g, () => toStairs(g), () => floorOf(g) > 1 || dead(g));
    expect(dead(g)).toBe(false);
    const ds = g.ds()!;
    expect(ds.floor).toBe(2);
    expect(ds.grid).not.toBe(grid1);
    expect(g.state().mapTiles?.["map_floor" as never]).not.toBe(tiles1);
    expect(g.state().map.player).toMatchObject({ x: ds.px, y: ds.py, moving: false });
    expect(walkable(ds.grid[cellOf(ds.width, { x: ds.px, y: ds.py })])).toBe(true);
    expect(ds.log.at(-1)).toBe("地下 2 階に 降りた。");
    expect(vars(g)["var_dungeon_best"]).toBe(2);
    expect(g.h.effects.some((e) => e.kind === "screenFlash")).toBe(true);
    // 見出しが出る
    expect(texts(g)).toContain("地下 2 階");
    // 階は、入ったときのシードから決まる（同じフロアを作り直せる）
    expect(ds.grid).toBe(generateFloor(`${ds.seed}:2`, { width: 39, height: 27, final: false }).grid);
  });
});

describe("倒れる", () => {
  const starve = (p: Record<string, unknown>) => ({ ...p, belly: { max: 1, interval: 1, hungry: 0, weak: 0, starveDamage: 50 } });

  it("倒れると、文章のあと町に戻る。持ち物とダンジョンで手に入れたお金を失い、HP は全回復。結果が変数に残る", async () => {
    const g = await boot("die", starve);
    await g.enter();
    // 敵に当たらない：その場で休んで、満腹度 0 → 空腹で倒れる
    await g.ok();
    await g.ok();
    expect(vars(g)["var_dungeon_event"]).toBe(1);
    expect(g.ds()!.log.at(-1)).toContain("空腹");
    expect(hero(g).hp).toBe(0);
    for (let i = 0; i < 600 && g.state().map.mapId !== "map_town"; i++) await g.ok();
    await g.idle(60);
    const s = g.state();
    expect(s.map.mapId).toBe("map_town");
    expect(g.ds()).toBeUndefined(); // ダンジョンの状態は消える
    expect(s.pluginState?.["dungeon"]).toBeNull();
    expect(items(g)).toEqual({});
    expect(s.party.gold).toBe(0);
    expect(hero(g).hp).toBe(30);
    expect(vars(g)).toMatchObject({ var_dungeon_event: 0, var_dungeon_result: 1, var_dungeon_best: 1, var_dungeon_clears: 0 });
    expect(s.map.player).toMatchObject({ x: 10, y: 3 });
    expect(g.h.warnings).toEqual([]);
  });

  it("もう一度入れる（新しいフロア。レベルは 1 に戻る）", async () => {
    const g = await boot("again", starve);
    await g.enter();
    await g.ok();
    await g.ok();
    for (let i = 0; i < 600 && g.state().map.mapId !== "map_town"; i++) await g.ok();
    await g.idle(60);
    await g.step("down");
    await g.step("up"); // 入口の前に戻る
    await g.step("up");
    for (let i = 0; i < 600 && g.state().map.mapId !== "map_floor"; i++) await g.ok();
    await g.idle(60);
    expect(g.ds()).toMatchObject({ floor: 1, turn: 0, belly: 1 });
    expect(g.state().map.mapId).toBe("map_floor");
  });
});

describe("宝を持ち帰る", () => {
  /** 最後の階が 2 階で、敵がいない設定。 */
  const easy = (p: Record<string, unknown>) => ({
    ...p,
    goalFloor: 2,
    clearGold: 500,
    monsters: { base: 0, perFloor: 0, spread: 0 },
    enemies: (p["enemies"] as { boss?: boolean }[]).filter((e) => e.boss !== true),
  });

  it("最後の階の宝に触れると、文章のあと町に戻る。持ち物は残り、ごほうびのお金が増え、クリア回数が増える", async () => {
    const g = await boot("clear", easy);
    await g.enter();
    await walk(g, () => toStairs(g), () => floorOf(g) > 1);
    expect(g.ds()!.floor).toBe(2);
    expect(g.ds()!.grid.includes("$")).toBe(true);
    expect(g.ds()!.grid.includes(">")).toBe(false);
    await walk(g, () => toStairs(g), () => dead(g));
    expect(vars(g)["var_dungeon_event"]).toBe(2);
    for (let i = 0; i < 800 && g.state().map.mapId !== "map_town"; i++) await g.ok();
    await g.idle(60);
    const s = g.state();
    expect(s.map.mapId).toBe("map_town");
    expect(g.ds()).toBeUndefined();
    expect(s.party.gold).toBeGreaterThanOrEqual(500);
    expect(items(g)["item_herb"]).toBeGreaterThanOrEqual(2);
    expect(vars(g)).toMatchObject({ var_dungeon_event: 0, var_dungeon_result: 2, var_dungeon_clears: 1, var_dungeon_best: 2 });
    expect(hero(g).hp).toBe(30);
  });
});

describe("セーブとロード（中断セーブ）", () => {
  it("ダンジョンの途中でセーブして、ロードすると、フロア・敵・歩いた場所・ターンが元どおり", async () => {
    const g = await boot("save");
    // 同じ保存先を使うために、別のハーネスを作る
    const registry = createPluginRegistry();
    await loadPlugins([dungeonPlugin], registry, { params: { dungeon: g.h.loaded.project.system.plugins[0]!.params } });
    const ext = toRuntimeExtensions(registry);
    const h = await createRuntimeHarness({ project: "dungeon", projectVersion: 2, seed: "save", extensions: ext });
    const saves = h.saves;
    const frames = async (...fs: ReturnType<typeof expandInputs>): Promise<void> => {
      for (const f of fs) {
        h.input.push(f);
        h.advanceFrames(1);
        if (h.runtime.status !== "running") await h.runtime.settled();
      }
    };
    // 洞窟に入る
    await frames(...expandInputs([{ press: "up" }, { wait: 15 }, { press: "up" }, { wait: 15 }, { press: "up" }, { wait: 15 }, { press: "up" }, { wait: 15 }, { press: "up" }]));
    for (let i = 0; i < 600 && h.runtime.getState().map.mapId !== "map_floor"; i++) await frames(...expandInputs([i % 20 === 0 ? { press: "ok" } : { wait: 1 }]));
    await frames(...expandInputs([{ wait: 60 }]));
    for (let i = 0; i < 3; i++) await frames(...expandInputs([{ press: "ok" }, { wait: 2 }])); // 3 ターン休む
    const before = h.runtime.getState();
    expect(before.map.mapId).toBe("map_floor");
    // メニュー → セーブ → スロット 1
    await frames(...expandInputs([{ press: "menu" }, { wait: 1 }, { press: "down" }, { wait: 1 }, { press: "down" }, { wait: 1 }, { press: "ok" }, { wait: 1 }, { press: "ok" }, { wait: 1 }]));
    await h.runtime.settled();
    expect((await saves.listSlots()).length).toBeGreaterThan(0);

    const loaded = await createRuntimeHarness({ project: "dungeon", projectVersion: 2, seed: "other", title: true, extensions: ext, saves });
    await loaded.runtime.settled();
    const lf = async (...fs: ReturnType<typeof expandInputs>): Promise<void> => {
      for (const f of fs) {
        loaded.input.push(f);
        loaded.advanceFrames(1);
        if (loaded.runtime.status !== "running") await loaded.runtime.settled();
      }
    };
    await lf(...expandInputs([{ press: "down" }, { wait: 1 }, { press: "ok" }, { wait: 1 }, { press: "ok" }, { wait: 5 }]));
    await loaded.runtime.settled();
    const after = loaded.runtime.getState();
    expect(after.map.mapId).toBe("map_floor");
    expect(after.pluginState).toEqual(before.pluginState);
    expect(after.mapTiles).toEqual(before.mapTiles);
    // 続きを遊べる（1 ターン休むと、同じように進む）
    await lf(...expandInputs([{ press: "ok" }, { wait: 3 }]));
    expect((after.pluginState?.["dungeon"] as { turn: number }).turn).toBe(3);
    expect((loaded.runtime.getState().pluginState?.["dungeon"] as { turn: number }).turn).toBe(4);
    expect(loaded.warnings).toEqual([]);
  });
});

describe("歯ごたえ（単純なボットで）", () => {
  it("階段へ向かって進むだけのボット（くすり草も使わず、拾いにも行かない）は、深くまで潜れるが、最後までは行けない。どの入場も、警告・エラーなしで終わる", async () => {
    const reached: number[] = [];
    for (const seed of ["a", "b", "c", "d", "e", "f"]) {
      const g = await boot(seed);
      await g.enter();
      await walk(g, () => toStairs(g), () => dead(g) || floorOf(g) >= 7, 900);
      reached.push(floorOf(g));
      expect(g.h.warnings).toEqual([]);
      expect(g.h.errors).toEqual([]);
    }
    expect(Math.min(...reached)).toBeGreaterThanOrEqual(2);
    expect(reached.reduce((n, f) => n + f, 0) / reached.length).toBeGreaterThanOrEqual(3.5);
    expect(Math.max(...reached)).toBeLessThanOrEqual(7);
  }, 60000);
});

describe("プラグインの有無", () => {
  it("[inv-3] ダンジョンに入っていないゲーム（村のデモ）のリプレイは、プラグインを読み込んでも変わらない", async () => {
    const registry = createPluginRegistry();
    await loadPlugins([dungeonPlugin], registry);
    const bare = await createRuntimeHarness({ project: "demo" });
    const withDungeon = await createRuntimeHarness({ project: "demo", extensions: toRuntimeExtensions(registry) });
    const inputs = expandInputs([{ hold: "right", frames: 40 }, { hold: "down", frames: 40 }, { press: "ok" }, { wait: 30 }, { press: "ok" }, { wait: 30 }]);
    bare.play(...inputs);
    withDungeon.play(...inputs);
    expect(hashState(withDungeon.runtime.getState())).toBe(hashState(bare.runtime.getState()));
    expect(withDungeon.effects).toEqual(bare.effects);
    expect(withDungeon.warnings).toEqual(bare.warnings);
    expect(withDungeon.runtime.getState().pluginState).toBeUndefined();
  });

  it("設定が不正でも、ゲームは始まる。Enter は警告を出して何もしない", async () => {
    const g = await boot("bad", (p) => ({ ...p, goalFloor: 1 }));
    await g.enter();
    expect(g.state().map.mapId).toBe("map_town");
    expect(g.ds()).toBeUndefined();
    expect(g.h.warnings.some((w) => w.includes("plugin dungeon の設定が不正") && w.includes("goalFloor"))).toBe(true);
    expect(g.h.errors).toEqual([]);
  });

  it("dirOf", () => {
    expect([dirOf(-1, 0), dirOf(1, 0), dirOf(0, -1), dirOf(0, 1)]).toEqual(["left", "right", "up", "down"]);
  });
});
