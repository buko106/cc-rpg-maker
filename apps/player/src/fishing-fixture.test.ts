import { parseConfig } from "@rpg/plugin-fishing";
import type { MapData, MapId } from "@rpg/schema";
import { loadFixtureProject } from "@rpg/test-utils";
import { describe, expect, it } from "vitest";

// 港町の釣り大会のデモ（fixtures/projects/v2/fishing。tools/make-fishing-demo.mjs が生成する）の約束ごと：
// プラグインの設定が、プロジェクトのデータベース・マップ・アセットと食い違っていないこと。釣り場・人・店に歩いて行けること。
const { project, maps } = loadFixtureProject("fishing", 2);
const ref = project.system.plugins.find((p) => p.name === "fishing")!;
const parsed = parseConfig(ref.params);
if (!parsed.ok) throw new Error(parsed.message);
const cfg = parsed.config;
const tileset = Object.values(project.tilesets)[0]!;
const harbor: MapData = maps["map_harbor" as MapId]!;
const events = Object.values(harbor.events);
const tileAt = (x: number, y: number): number => harbor.layers[0]!.tiles[y * harbor.width + x]!;
const passable = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < harbor.width && y < harbor.height && tileset.passage[tileAt(x, y)] === 15;
const DIRS: [number, number][] = [[0, -1], [0, 1], [-1, 0], [1, 0]];

/** 開始位置から歩いて行ける場所（イベントのいるマスは通れない）。 */
const reachable = ((): Set<string> => {
  const blocked = new Set(events.filter((e) => e.pages[0]!.priority === "same" && !e.pages[0]!.through).map((e) => `${e.x},${e.y}`));
  const seen = new Set<string>([`${project.system.startX},${project.system.startY}`]);
  const queue: [number, number][] = [[project.system.startX, project.system.startY]];
  for (let h = 0; h < queue.length; h++) {
    const [x, y] = queue[h]!;
    for (const [dx, dy] of DIRS) {
      const k = `${x + dx},${y + dy}`;
      if (!seen.has(k) && passable(x + dx, y + dy) && !blocked.has(k)) {
        seen.add(k);
        queue.push([x + dx, y + dy]);
      }
    }
  }
  return seen;
})();
/** そのマスのイベントに、立って話しかけられる（隣に、歩いて行ける場所がある）。 */
const talkable = (e: { x: number; y: number }): boolean => DIRS.some(([dx, dy]) => reachable.has(`${e.x + dx},${e.y + dy}`));
const named = (name: string) => events.find((e) => e.name === name)!;
const cmds = (e: { pages: { commands: { code: string }[] }[] }, code: string): number => e.pages.flatMap((p) => p.commands).filter((c) => c.code === code).length;

describe("プロジェクト", () => {
  it("v2 で、プラグイン fishing を使う。設定が読める。マップは港町 1 枚で、開始位置は通れる", () => {
    expect(project.formatVersion).toBe(2);
    expect(project.system.plugins.map((p) => [p.name, p.version])).toEqual([["fishing", "1.0.0"]]);
    expect(Object.keys(maps)).toEqual(["map_harbor"]);
    expect(project.system.startMap).toBe("map_harbor");
    expect(passable(project.system.startX, project.system.startY)).toBe(true);
    expect(cfg.fish).toHaveLength(9);
  });

  it("設定の参照：魚・竿・エサ・トロフィーは、データベースのアイテム。竿とトロフィーは売れない（key）、魚とエサは売れる", () => {
    const db = project.database.items;
    for (const f of cfg.fish) expect(db[f.item as keyof typeof db], f.key).toMatchObject({ name: f.name, kind: "consumable" });
    for (const b of cfg.baits) expect(db[b.item as keyof typeof db], b.name).toMatchObject({ kind: "consumable" });
    for (const r of cfg.rods) expect(db[r.item as keyof typeof db], r.name).toMatchObject({ kind: "key" });
    expect(db[cfg.tournament.trophy as keyof typeof db]).toMatchObject({ kind: "key" });
  });

  it("魚：すべての魚が、どこかの釣り場で釣れる。釣り場は桟橋・岩場・沖の 3 種。沖の魚ほど高得点で、まぼろしのマグロが最高", () => {
    expect(new Set(cfg.fish.flatMap((f) => f.spots))).toEqual(new Set(["pier", "rocks", "deep"]));
    const best = (spot: string) => Math.max(...cfg.fish.filter((f) => f.spots.includes(spot)).map((f) => f.points));
    expect(best("deep")).toBeGreaterThan(best("rocks"));
    expect(best("rocks")).toBeGreaterThan(best("pier") - 1);
    expect(cfg.fish.find((f) => f.key === "maguro")!.points).toBe(Math.max(...cfg.fish.map((f) => f.points)));
    // 魚の値段（買い取り）は、点数が高いほど高い（ながぐつは最安）
    const price = (key: string) => project.database.items[`item_${key}` as keyof typeof project.database.items]!.price;
    expect(price("boots")).toBe(Math.min(...cfg.fish.map((f) => price(f.key))));
    expect(price("maguro")).toBe(Math.max(...cfg.fish.map((f) => price(f.key))));
  });

  it("竿は買うほど当たり判定が広がり、エサは買うほど良い（高いほど、あたりが早く大物が来る）", () => {
    const zones = cfg.rods.map((r) => r.zone);
    expect(zones).toEqual([...zones].sort((a, b) => a - b));
    expect(zones[0]).toBeGreaterThan(cfg.baseZone);
    const price = (item: string) => project.database.items[item as keyof typeof project.database.items]!.price;
    expect(cfg.rods.map((r) => price(r.item))).toEqual([...cfg.rods.map((r) => price(r.item))].sort((a, b) => a - b));
    for (let i = 1; i < cfg.baits.length; i++) {
      expect(cfg.baits[i]!.rare).toBeGreaterThan(cfg.baits[i - 1]!.rare);
      expect(cfg.baits[i]!.bite).toBeLessThan(cfg.baits[i - 1]!.bite);
      expect(price(cfg.baits[i]!.item)).toBeGreaterThan(price(cfg.baits[i - 1]!.item));
    }
    // 釣具屋の品ぞろえは、エサと竿のすべて
    const shop = named("釣具屋").pages[0]!.commands.find((c) => c.code === "ShopProcessing")!.params as { goods: string[]; canSell: boolean };
    expect(shop.goods).toEqual([...cfg.baits.map((b) => b.item), ...cfg.rods.map((r) => r.item)]);
    expect(shop.canSell).toBe(true);
  });

  it("大会：ライバルは弱い順に並び、賞金は 1 位ほど高い。最初の持ち金で参加費（100G）が払える", () => {
    const rivals = cfg.tournament.rivals;
    expect(rivals.map((r) => r.skill)).toEqual([...rivals.map((r) => r.skill)].sort((a, b) => a - b));
    expect(cfg.tournament.prizes).toEqual([...cfg.tournament.prizes].sort((a, b) => b - a));
    expect(cfg.tournament.prizes).toHaveLength(rivals.length);
    expect(cfg.tournament.seconds).toBe(120);
    const intro = named("はじまり").pages[0]!.commands;
    expect(intro.find((c) => c.code === "ChangeGold")!.params).toMatchObject({ op: "gain", amount: { value: 300 } });
    const clerk = named("受付").pages[0]!.commands;
    expect(clerk.find((c) => c.code === "ConditionalBranch")!.params).toMatchObject({ condition: "gold >= 100" });
    expect(clerk.find((c) => c.code === "ChangeGold")!.params).toMatchObject({ op: "lose", amount: { value: 100 } });
  });
});

describe("マップ", () => {
  const spotEvents = events.filter((e) => cmds(e, "plugin:fishing/Cast") > 0);

  it("釣り場のイベント：どれも水のマス（通れない）の上にあり、水辺に立って向かえる。種類は設定の釣り場のどれか", () => {
    expect(spotEvents.length).toBeGreaterThanOrEqual(20);
    for (const e of spotEvents) {
      expect(passable(e.x, e.y), e.id).toBe(false);
      expect(e.pages).toHaveLength(1);
      expect(e.pages[0]).toMatchObject({ trigger: "action", priority: "same" });
      expect(talkable(e), e.id).toBe(true);
      const spot = (e.pages[0]!.commands[0]!.params as { spot: string }).spot;
      expect(["pier", "rocks", "deep"]).toContain(spot);
    }
    // 3 種類の釣り場のどれも、歩いて行ける
    for (const spot of ["pier", "rocks", "deep"]) expect(spotEvents.some((e) => (e.pages[0]!.commands[0]!.params as { spot: string }).spot === spot && talkable(e)), spot).toBe(true);
  });

  it("沖の釣り場は桟橋の先にあり、桟橋・岩場より外側（北）。深い水に面している", () => {
    const deep = spotEvents.filter((e) => (e.pages[0]!.commands[0]!.params as { spot: string }).spot === "deep");
    for (const e of deep) expect(e.y).toBeLessThanOrEqual(3);
    const pier = spotEvents.filter((e) => (e.pages[0]!.commands[0]!.params as { spot: string }).spot === "pier");
    for (const e of pier) expect(e.y).toBeGreaterThan(3);
  });

  it("人・店・板：受付・釣具屋・魚拓の板・港のおじさん・ライバル 3 人に、話しかけられる（歩いて行ける隣のマスがある）", () => {
    for (const name of ["受付", "釣具屋", "魚拓の板", "釣り場の案内", "港のおじさん", "ミナ", "ゴンさん", "トビさん"]) expect(talkable(named(name)), name).toBe(true);
  });

  it("イベントが同じマスに重なっていない（進行役・はじまりは、マップの隅で、触れない）", () => {
    const at = events.map((e) => `${e.x},${e.y}`);
    expect(new Set(at).size).toBe(at.length);
    for (const name of ["大会の進行役", "はじまり"]) {
      const e = named(name);
      expect(e.pages.every((p) => p.through)).toBe(true);
      expect(reachable.has(`${e.x},${e.y}`)).toBe(false);
    }
  });

  it("大会の進行役：毎フレーム Watch（並列）と、変数 event が 1 のときに Result まで進める自動実行ページ。そのあとスイッチを戻す", () => {
    const c = named("大会の進行役");
    expect(c.pages.map((p) => p.trigger)).toEqual(["parallel", "autorun"]);
    expect(c.pages[0]!.commands.map((x) => x.code)).toEqual(["plugin:fishing/Watch"]);
    expect(c.pages[1]!.conditions).toEqual([{ kind: "variable", id: cfg.vars.event, op: "==", value: 1 }]);
    const codes = c.pages[1]!.commands.map((x) => x.code);
    expect(codes).toContain("plugin:fishing/Result");
    expect(c.pages[1]!.commands.find((x) => x.code === "ControlSwitches")!.params).toMatchObject({ ids: ["sw_tournament"], value: false });
  });

  it("受付：申しこむと Start を呼んで、スイッチ sw_tournament を入れる。大会中の受付は、別のページ（条件: sw_tournament）で応える", () => {
    const clerk = named("受付");
    const cmdsOf = clerk.pages[0]!.commands.map((c) => c.code);
    expect(cmdsOf).toContain("plugin:fishing/Start");
    expect(clerk.pages[1]!.conditions).toEqual([{ kind: "switch", id: "sw_tournament", value: true }]);
    for (const id of ["sw_intro", "sw_tournament"]) expect(project.switches[id as keyof typeof project.switches]).toBeDefined();
  });

  it("港のおじさん：魚をすべて釣ると認めてくれる（変数 species が、魚の種類の数以上のとき）", () => {
    const master = named("港のおじさん");
    expect(master.pages[1]!.conditions).toEqual([{ kind: "variable", id: cfg.vars.species, op: ">=", value: cfg.fish.length }]);
  });
});

describe("変数・アセット", () => {
  it("プラグインの設定にある変数は、プロジェクトの variables にある。マップが使う変数も同じ", () => {
    for (const id of Object.values(cfg.vars)) expect(project.variables[id as keyof typeof project.variables], id).toBeDefined();
    const used = new Set<string>();
    for (const e of events) for (const p of e.pages) for (const c of p.conditions) if (c.kind === "variable") used.add(c.id);
    for (const id of used) expect(project.variables[id as keyof typeof project.variables], id).toBeDefined();
  });

  it("人の絵・タイルセットは、アセットとして登録されている。通れるタイルは、砂・草・花・桟橋・石畳・小道だけ", () => {
    const assets = project.assets.entries;
    expect(assets[tileset.image!.asset as keyof typeof assets]).toBeDefined();
    for (const e of events) for (const p of e.pages) if (p.graphic) expect(assets[p.graphic.asset as keyof typeof assets], e.name).toBeDefined();
    const open = tileset.passage.flatMap((v, id) => (v === 15 ? [id] : []));
    expect(open).toEqual([4, 5, 6, 7, 8, 19]);
  });
});
