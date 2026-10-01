import { parseConfig } from "@rpg/plugin-dungeon";
import type { MapData, MapId } from "@rpg/schema";
import { loadFixtureProject } from "@rpg/test-utils";
import { describe, expect, it } from "vitest";

// 風鳴りの洞窟のデモ（fixtures/projects/v2/dungeon。tools/make-dungeon-demo.mjs が生成する）の約束ごと：
// プラグインの設定が、プロジェクトのデータベース・タイルセット・アセットと食い違っていないこと。
const { project, maps } = loadFixtureProject("dungeon", 2);
const ref = project.system.plugins.find((p) => p.name === "dungeon")!;
const parsed = parseConfig(ref.params);
if (!parsed.ok) throw new Error(parsed.message);
const cfg = parsed.config;
const tileset = Object.values(project.tilesets)[0]!;
const town: MapData = maps["map_town" as MapId]!;
const floor: MapData = maps["map_floor" as MapId]!;

describe("プロジェクト", () => {
  it("v2 で、プラグイン dungeon を使う。設定が読める", () => {
    expect(project.formatVersion).toBe(2);
    expect(project.system.plugins.map((p) => [p.name, p.version])).toEqual([["dungeon", "1.0.0"]]);
    expect(cfg.goalFloor).toBe(7);
  });

  it("フロアのひな形：設定の大きさで、全マスが岩（通れない）で、コントローラのイベントが 1 つ（毎フレーム Tick を呼ぶ並列ページ + 倒れたとき・宝のときの自動実行ページ）", () => {
    expect([floor.width, floor.height]).toEqual([cfg.width, cfg.height]);
    expect(new Set(floor.layers[0]!.tiles)).toEqual(new Set([cfg.tiles.rock]));
    expect(tileset.passage[cfg.tiles.rock]).toBe(0);
    const events = Object.values(floor.events);
    expect(events).toHaveLength(1);
    const pages = events[0]!.pages;
    expect(pages.map((p) => p.trigger)).toEqual(["parallel", "autorun", "autorun"]);
    expect(pages[0]!.commands.map((c) => c.code)).toEqual(["plugin:dungeon/Tick"]);
    expect(pages[1]!.conditions).toEqual([{ kind: "variable", id: cfg.vars.event, op: "==", value: 1 }]);
    expect(pages[2]!.conditions).toEqual([{ kind: "variable", id: cfg.vars.event, op: "==", value: 2 }]);
    expect(pages[1]!.commands.at(-1)).toMatchObject({ code: "plugin:dungeon/Finish", params: { result: "dead" } });
    expect(pages[2]!.commands.at(-1)).toMatchObject({ code: "plugin:dungeon/Finish", params: { result: "clear" } });
  });

  it("タイル番号：床・階段・宝は通れて、岩・壁の正面は通れない。すべてタイルセットの中にある", () => {
    const { rock, wallFace, floor: floors, stairs, treasure } = cfg.tiles;
    for (const t of [rock, wallFace, ...floors, stairs, treasure]) expect(t).toBeLessThan(tileset.passage.length);
    for (const t of [rock, wallFace]) expect(tileset.passage[t]).toBe(0);
    for (const t of [...floors, stairs, treasure]) expect(tileset.passage[t]).toBe(15);
  });

  it("町：開始位置と、戻る場所（洞窟の入口の前）は通れる。洞窟の入口は Enter を呼ぶ", () => {
    const passable = (x: number, y: number): boolean => tileset.passage[town.layers[0]!.tiles[y * town.width + x]!] === 15;
    expect(passable(project.system.startX, project.system.startY)).toBe(true);
    expect(project.system.startMap).toBe("map_town");
    expect(cfg.home.map).toBe("map_town");
    expect(passable(cfg.home.x, cfg.home.y)).toBe(true);
    const cave = Object.values(town.events).find((e) => e.pages.some((p) => p.commands.some((c) => c.code === "plugin:dungeon/Enter")))!;
    expect(cave.y).toBe(cfg.home.y - 1);
    expect(cave.x).toBe(cfg.home.x);
    expect(cave.pages[0]!.trigger).toBe("touch");
  });
});

describe("敵と落ちている物", () => {
  const db = project.database;
  const sheet = project.assets.entries[cfg.sprites.asset as never]!;

  it("設定の敵・アイテムは、データベースにある。ボスはちょうど 1 種で、最後の階まで出る敵がいる", () => {
    for (const e of cfg.enemies) expect(Object.hasOwn(db.enemies, e.enemy), e.enemy).toBe(true);
    for (const i of cfg.items) if (i.kind === "item") expect(Object.hasOwn(db.items, i.item), i.item).toBe(true);
    for (const id of Object.keys(cfg.startItems)) expect(Object.hasOwn(db.items, id), id).toBe(true);
    expect(cfg.enemies.filter((e) => e.boss)).toHaveLength(1);
    // どの階にも、出る敵が 1 種以上いる
    for (let f = 1; f <= cfg.goalFloor; f++) expect(cfg.enemies.filter((e) => !e.boss && f >= e.floors[0] && f <= e.floors[1]).length, `${f} 階の敵`).toBeGreaterThan(0);
    // どの階にも、おにぎり（満腹度を戻せる物）が落ちうる
    for (let f = 1; f <= cfg.goalFloor; f++) expect(cfg.items.some((i) => i.kind === "food" && f >= i.floors[0] && f <= i.floors[1]), `${f} 階のおにぎり`).toBe(true);
  });

  it("敵の絵・物の絵は、スプライトシートの中のコマ（絵が重ならず、シートからはみ出さない）", () => {
    const cells = [cfg.sprites.drop, ...cfg.enemies.map((e) => e.sprite), ...cfg.items.map((i) => i.sprite)];
    for (const c of cells) {
      expect(c.sx % cfg.sprites.size).toBe(0);
      expect(c.sy % cfg.sprites.size).toBe(0);
      expect(c.sx + cfg.sprites.size).toBeLessThanOrEqual(sheet.width!);
      expect(c.sy + cfg.sprites.size).toBeLessThanOrEqual(sheet.height!);
    }
    const enemyCells = cfg.enemies.map((e) => `${e.sprite.sx},${e.sprite.sy}`);
    expect(new Set(enemyCells).size).toBe(enemyCells.length);
    const itemCells = cfg.items.map((i) => `${i.sprite.sx},${i.sprite.sy}`);
    expect(new Set(itemCells).size).toBe(itemCells.length);
  });

  it("敵が強くなっていく：出る階が深いほど、攻撃力・最大 HP が大きい（ボスは最も強い）", () => {
    const stat = (id: string, p: "atk" | "mhp"): number => db.enemies[id as never]!.params[p];
    const ordered = cfg.enemies.filter((e) => !e.boss).sort((a, b) => a.floors[0] - b.floors[0] || a.floors[1] - b.floors[1]);
    for (let i = 1; i < ordered.length; i++) expect(stat(ordered[i]!.enemy, "atk")).toBeGreaterThanOrEqual(stat(ordered[i - 1]!.enemy, "atk") - 1);
    const boss = cfg.enemies.find((e) => e.boss)!.enemy;
    for (const e of ordered) {
      expect(stat(boss, "mhp")).toBeGreaterThan(stat(e.enemy, "mhp"));
      expect(stat(boss, "atk")).toBeGreaterThan(stat(e.enemy, "atk"));
    }
  });

  it("結果を残す変数は、プロジェクトに宣言してある。町の長老はそれを読む", () => {
    for (const v of Object.values(cfg.vars)) expect(Object.hasOwn(project.variables, v), v).toBe(true);
    const elder = Object.values(town.events).find((e) => e.name === "長老")!;
    expect(elder.pages.some((p) => p.conditions.some((c) => c.kind === "variable" && c.id === cfg.vars.best))).toBe(true);
    expect(elder.pages.some((p) => p.conditions.some((c) => c.kind === "variable" && c.id === cfg.vars.clears))).toBe(true);
  });

  it("主人公：職業のパラメータ曲線がある（プラグインが最大 HP・攻撃力・防御力を読む）", () => {
    const cls = db.classes[db.actors[project.system.initialParty[0]!]!.classId]!;
    for (const p of ["mhp", "atk", "def"] as const) expect(cls.params[p].growth, p).toBeGreaterThan(0); // レベルが上がると強くなる
    expect(Math.round(cls.params.mhp.base)).toBe(30);
  });
});
