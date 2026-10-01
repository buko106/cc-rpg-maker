import { describe, expect, it } from "vitest";
import { autoBattle, beginBattle, drive, driveUntil, idleFrames, loadFixtureProject, press, runReplay } from "@rpg/test-utils";
import type { AutoBattlePolicy } from "@rpg/test-utils";
import type { EventCommand, MapData } from "@rpg/schema";

// ほこらの冒険のデモ（fixtures/projects/v1/hokora。tools/make-hokora-demo.mjs が生成する）の約束ごと
const { project, maps, ctx } = loadFixtureProject("hokora");
type State = ReturnType<typeof runReplay>["state"];
type Dir = "up" | "down" | "left" | "right";

const VILLAGE = "map_village";
const FIELD = "map_field";
const CAVE = "map_cave";
const SHRINE = "map_shrine";
const mapOf = (id: string): MapData => maps[id as keyof typeof maps]!;
const passage = Object.values(project.tilesets)[0]!.passage;
const STEPS: [Dir, number, number][] = [["up", 0, -1], ["down", 0, 1], ["left", -1, 0], ["right", 1, 0]];
const HERO = "actor_hero" as keyof State["actors"];
const MINA = "actor_mina" as keyof State["actors"];
const item = (id: string) => id as keyof State["party"]["items"];

/** 今の状態でふさがっているタイル（タイルの通行と、出ているページが「通常」のイベント）。 */
function blocked(s: State, map: MapData, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= map.width || y >= map.height) return true;
  const tile = map.layers.some((l) => {
    const t = l.tiles[y * map.width + x] ?? 0;
    return t !== 0 && passage[t] === 0;
  });
  return tile || Object.values(s.map.events).some((ev) => ev.x === x && ev.y === y && ev.pageIndex !== null && !ev.through && ev.priority === "same");
}

/** 触れると動くイベントの位置（経路の途中では踏まない）。 */
const touchAt = (s: State): Set<string> => new Set(Object.values(s.map.events).filter((ev) => ev.trigger === "touch").map((ev) => `${ev.x},${ev.y}`));

/** 今いる位置から (tx, ty) までの歩く向きの列。行けなければ undefined。 */
function route(s: State, tx: number, ty: number): Dir[] | undefined {
  const map = mapOf(s.map.mapId);
  const touch = touchAt(s);
  const { x, y } = s.map.player;
  const prev = new Map<string, [string, Dir] | null>([[`${x},${y}`, null]]);
  const queue: [number, number][] = [[x, y]];
  while (queue.length > 0) {
    const [cx, cy] = queue.shift()!;
    for (const [d, dx, dy] of STEPS) {
      const nx = cx + dx;
      const ny = cy + dy;
      const k = `${nx},${ny}`;
      if (prev.has(k) || blocked(s, map, nx, ny)) continue;
      if (touch.has(k) && !(nx === tx && ny === ty)) continue;
      prev.set(k, [`${cx},${cy}`, d]);
      queue.push([nx, ny]);
    }
  }
  if (!prev.has(`${tx},${ty}`)) return undefined;
  const dirs: Dir[] = [];
  for (let k = `${tx},${ty}`, p = prev.get(k); p != null; k = p[0], p = prev.get(k)) dirs.unshift(p[1]);
  return dirs;
}

const busy = (s: State): boolean => s.map.player.moving || s.map.transfer !== undefined || s.interpreters.length > 0 || s.message.open || s.scene.kind !== "map";

/** 戦闘になった回数（ボス以外＝ランダムエンカウント）と、メニューから回復した回数。テストごとに数え直す。 */
let encounters: string[] = [];
let menuHeals = 0;

/**
 * イベントの処理が終わるまで進める。メッセージは決定で送り、選択肢は `answers` の順に答え（尽きたら先頭）、戦闘は `policy` で戦う。
 * タイトルに戻ったら（またはゲームオーバーで）そこで止まる。
 */
function settle(state: State, policy: AutoBattlePolicy, answers: number[] = []): State {
  let s = state;
  for (let i = 0; i < 400 && busy(s); i++) {
    if (s.scene.kind === "title" || s.scene.kind === "gameover") return s;
    if (s.scene.kind === "battle") {
      if (s.battle!.troopId !== "tr_boss") encounters.push(s.battle!.troopId);
      s = autoBattle(s, ctx, policy);
    } else if (s.message.open && s.message.choices !== null) {
      const want = answers.shift() ?? 0;
      s = drive(s, ctx, idleFrames(2)).state;
      while ((s.message.cursor ?? 0) !== want) s = drive(s, ctx, [press("down"), ...idleFrames(1)]).state;
      s = drive(s, ctx, [press("ok"), ...idleFrames(1)]).state;
    } else if (s.message.open) s = drive(s, ctx, [...idleFrames(2), press("ok"), ...idleFrames(1)]).state;
    else s = driveUntil(s, ctx, (x) => !busy(x) || x.message.open || x.scene.kind !== "map", 600);
  }
  return drive(s, ctx, idleFrames(2)).state;
}

const tap = (s: State, ...buttons: (Dir | "menu" | "ok" | "cancel")[]): State => buttons.reduce((cur, k) => drive(cur, ctx, [press(k), ...idleFrames(1)]).state, s);
const down = (n: number): "down"[] => Array<"down">(n).fill("down");

// ── メニューでの回復（アイテム・スキルの使用）────────────────────────
const mhpOf = (s: State, id: keyof State["actors"]): number => {
  const cls = project.database.classes[project.database.actors[id as never]!.classId as never] as { params: { mhp: { base: number; growth: number } } };
  return cls.params.mhp.base + cls.params.mhp.growth * (s.actors[id]!.level - 1);
};
const ratio = (s: State, id: keyof State["actors"]): number => s.actors[id]!.hp / mhpOf(s, id);

/** メニューを開いて、ミナのヒール（スキル 0 番）を `target`（パーティの位置）に使い、メニューを閉じる。 */
const healWithSkill = (s: State, target: number): State => tap(s, "menu", "down", "ok", "down", "ok", "ok", ...down(target), "ok", "menu");
/** メニューを開いて、アイテム一覧の `index` 番のアイテムを `target`（パーティの位置）に使い、メニューを閉じる。 */
const useItem = (s: State, index: number, target: number): State => tap(s, "menu", "ok", ...down(index), "ok", ...down(target), "ok", "menu");
const itemIndex = (s: State, id: string): number =>
  Object.entries(s.party.items)
    .filter(([, n]) => n > 0)
    .map(([k]) => k)
    .sort()
    .indexOf(id);

/** HP が低いときにメニューから回復する：ミナのヒール（MP があれば）、なければポーション。 */
function topUp(state: State, threshold = 0.5): State {
  let s = state;
  for (let i = 0; i < 12 && s.scene.kind === "map"; i++) {
    const members = s.party.members;
    const lowest = members.reduce((a, id) => (ratio(s, id) < ratio(s, a) ? id : a), members[0]!);
    if (ratio(s, lowest) >= threshold) break;
    const target = members.indexOf(lowest);
    const mina = s.actors[MINA]!;
    menuHeals++;
    if (mina.hp > 0 && mina.mp >= 3) s = healWithSkill(s, target);
    else if ((s.party.items[item("item_potion")] ?? 0) > 0) s = useItem(s, itemIndex(s, "item_potion"), target);
    else if (mina.hp > 0 && (s.party.items[item("item_ether")] ?? 0) > 0) s = useItem(s, itemIndex(s, "item_ether"), members.indexOf(MINA as never));
    else break;
  }
  return s;
}

/** 1 歩ずつ歩く。途中でイベントや戦闘が起きたら終わるまで進める。戦闘のあとは HP が低ければメニューで回復する。 */
function walk(state: State, dirs: readonly Dir[], policy: AutoBattlePolicy = fight): State {
  let s = state;
  for (const d of dirs) {
    s = settle(drive(s, ctx, [press(d)]).state, policy);
    if (s.scene.kind === "title" || s.scene.kind === "gameover") return s;
    s = topUp(s);
  }
  return s;
}

/** (x, y) のイベントの隣まで歩き、そちらを向いて話しかける。 */
function talk(state: State, x: number, y: number, policy: AutoBattlePolicy = fight, answers: number[] = []): State {
  let s = state;
  const spots = STEPS.map(([d, dx, dy]) => ({ d, sx: x - dx, sy: y - dy })).flatMap((p) => {
    const r = route(s, p.sx, p.sy);
    return r === undefined ? [] : [{ ...p, r }];
  });
  const spot = spots.sort((a, b) => a.r.length - b.r.length)[0];
  if (spot === undefined) throw new Error(`${s.map.mapId} の (${x}, ${y}) に話しかけられる場所が無い`);
  s = walk(s, spot.r, policy);
  s = drive(s, ctx, [press(spot.d), ...idleFrames(2)]).state;
  return settle(drive(s, ctx, [press("ok"), ...idleFrames(1)]).state, policy, answers);
}

/** (x, y) まで歩く（触れると動くイベントならそれも動く）。 */
function walkTo(state: State, x: number, y: number, policy: AutoBattlePolicy = fight): State {
  const r = route(state, x, y);
  if (r === undefined) throw new Error(`${state.map.mapId} で (${x}, ${y}) へ行けない`);
  return walk(state, r, policy);
}

/** 素直な作戦：ミナは危ない人にヒール（二人以上ならヒールオール）、それ以外はホーリー。勇者は強打（かぶと割り）。 */
const fight: AutoBattlePolicy = ({ battle, actor, skills, items }) => {
  const allies = battle.party.flatMap((id) => (battle.allies[id] === undefined ? [] : [battle.allies[id]!]));
  const enemies = battle.enemyOrder.flatMap((id) => (battle.enemies[id] !== undefined && battle.enemies[id]!.hp > 0 ? [battle.enemies[id]!] : []));
  const weakest = enemies.reduce((a, e) => (e.hp < a.hp ? e : a), enemies[0]!);
  const can = (id: string): boolean => skills.some((s) => s.id === id && s.mpCost <= actor.mp);
  const hurt = allies.filter((a) => a.hp > 0 && a.hp < a.params.mhp * 0.5).sort((a, b) => a.hp / a.params.mhp - b.hp / b.params.mhp);
  const healer = allies.some((a) => a.id === "actor_mina" && a.hp > 0 && a.mp >= 3);
  if (actor.id === "actor_mina") {
    if (hurt.length >= 2 && can("sk_healall")) return { kind: "skill", skill: "sk_healall" };
    if (hurt.length > 0 && can("sk_heal")) return { kind: "skill", skill: "sk_heal", target: hurt[0]!.id };
    if (can("sk_holy")) return { kind: "skill", skill: "sk_holy", target: weakest.id };
    return { kind: "attack", target: weakest.id };
  }
  const potion = items.find((i) => i.id === "item_hipotion") ?? items.find((i) => i.id === "item_potion");
  if (!healer && hurt.length > 0 && potion !== undefined) return { kind: "item", item: potion.id, target: hurt[0]!.id };
  if (can("sk_break") && enemies.length === 1 && enemies[0]!.hp > 150) return { kind: "skill", skill: "sk_break", target: weakest.id };
  if (can("sk_smash")) return { kind: "skill", skill: "sk_smash", target: weakest.id };
  return { kind: "attack", target: weakest.id };
};

/** 何もしない（防御だけ）作戦。負けるときの流れを見る。 */
const guardOnly: AutoBattlePolicy = () => ({ kind: "guard" });

/** ニューゲーム直後（はじまりのイベントが動き出したところ）。 */
const newGame = (seed: string): State => drive(runReplay({ project: "fixtures/projects/v1/hokora", seed, inputs: [], expect: {} }).state, ctx, idleFrames(4)).state;
const at = (map: string, id: string) => {
  const ev = mapOf(map).events[id as keyof MapData["events"]];
  if (ev === undefined) throw new Error(`${map} に ${id} が無い`);
  return ev;
};
/** 村長の話を聞いて（はじまりのイベントのあと）、支度金とポーションをもらった状態。 */
function afterElder(seed: string): State {
  let s = settle(newGame(seed), fight);
  const elder = at(VILLAGE, "ev_elder");
  s = talk(s, elder.x, elder.y);
  return s;
}
const withLevel = (s: State, level: number): State => {
  const actors = { ...s.actors };
  for (const id of [HERO, MINA]) actors[id] = { ...actors[id]!, level, exp: level <= 1 ? 0 : 20 * (level - 1) ** 2 + 10 * (level - 1) };
  return { ...s, actors };
};
const hurtAll = (s: State, hp: number): State => ({ ...s, actors: { ...s.actors, [HERO]: { ...s.actors[HERO]!, hp }, [MINA]: { ...s.actors[MINA]!, hp } } });
/** そのマップの (x, y) へ場所移動して、着くまで進める（ここまでの道のりを省いて、その先だけを確かめるときに使う）。 */
const warp = (s: State, mapId: string, x: number, y: number): State =>
  settle({ ...s, map: { ...s.map, transfer: { to: mapId as never, x, y, dir: "up", fade: "none", requested: false } } }, fight);

/** いまの場所から行き来できる向き（通れて、触れると動くイベントでない隣のタイル）。 */
function pacer(s: State): [Dir, Dir] {
  const map = mapOf(s.map.mapId);
  const touch = touchAt(s);
  const { x, y } = s.map.player;
  const back: Record<Dir, Dir> = { up: "down", down: "up", left: "right", right: "left" };
  for (const [d, dx, dy] of STEPS) if (!blocked(s, map, x + dx, y + dy) && !touch.has(`${x + dx},${y + dy}`)) return [d, back[d]];
  throw new Error(`${s.map.mapId} の (${x}, ${y}) から歩き出せない`);
}
/** `n` 歩、`pacer` の向きに往復して歩く。 */
function pace(state: State, n: number, until: (s: State) => boolean = () => false): State {
  let s = state;
  const dirs = pacer(s);
  for (let i = 0; i < n && s.scene.kind === "map" && !until(s); i++) s = walk(s, [dirs[i % 2]!]);
  return s;
}
const FORWARD: Record<string, string> = { [VILLAGE]: "ev_to_field", [FIELD]: "ev_to_cave", [CAVE]: "ev_to_shrine" };
const BACKWARD: Record<string, string> = { [FIELD]: "ev_to_village", [CAVE]: "ev_cave_out", [SHRINE]: "ev_shrine_out" };
const ORDER = [VILLAGE, FIELD, CAVE, SHRINE];
/** 出入り口をたどって、そのマップまで歩いていく（村 ↔ 草原 ↔ 洞窟 ↔ ほこら）。 */
function goTo(state: State, mapId: string): State {
  let s = state;
  for (let i = 0; i < 6 && s.map.mapId !== mapId && s.scene.kind === "map"; i++) {
    const forward = ORDER.indexOf(mapId) > ORDER.indexOf(s.map.mapId);
    const door = at(s.map.mapId, (forward ? FORWARD : BACKWARD)[s.map.mapId]!);
    s = walkTo(s, door.x, door.y);
  }
  return s;
}
/** 回復の手段（ミナの MP・ポーション・エーテル）が尽きて、だれかの HP が低い。 */
function needsRest(s: State): boolean {
  const low = s.party.members.some((id) => ratio(s, id) < 0.5);
  const mina = s.actors[MINA]!;
  return low && mina.mp < 3 && (s.party.items[item("item_potion")] ?? 0) === 0 && (s.party.items[item("item_ether")] ?? 0) === 0;
}
/** 村の宿屋で休む（1 泊 15G）。元いた場所には戻らない。 */
function restAtInn(state: State): State {
  const inn = at(VILLAGE, "ev_inn");
  return talk(goTo(state, VILLAGE), inn.x, inn.y, fight, [0]);
}
/** `done` になるまで往復して歩いて戦う。HP を回復する手段が尽きたら、宿屋で休んでから村から草原へ戻る。 */
function grind(state: State, done: (s: State) => boolean, map: string, max = 1500): State {
  let s = state;
  for (let walked = 0; walked < max && s.scene.kind === "map" && !done(s); walked += 20) {
    if (needsRest(s)) s = goTo(restAtInn(s), map);
    s = pace(s, 20, done);
  }
  return s;
}
const refill = (s: State): State => ({ ...s, actors: { ...s.actors, [HERO]: { ...s.actors[HERO]!, hp: 9999, mp: 999 }, [MINA]: { ...s.actors[MINA]!, hp: 9999, mp: 999 } } });

describe("ほこらの冒険のデモ（fixtures/projects/v1/hokora）", () => {
  it("村・草原・洞窟・ほこらの 4 枚のマップ。画面は 15×11 タイル（480×352）。メニューにスキルが並ぶ", () => {
    expect(Object.keys(maps).sort()).toEqual([CAVE, FIELD, SHRINE, VILLAGE]);
    expect(project.system.screen).toEqual({ width: 15 * 32, height: 11 * 32 });
    expect(project.system.initialParty).toEqual(["actor_hero", "actor_mina"]);
    expect(project.system.menuSkill).toBe(true);
    expect(project.system.startMap).toBe(VILLAGE);
  });

  it("ランダムエンカウントは草原と洞窟だけ。敵グループは存在し、洞窟のほうが出やすい（平均歩数が短い）", () => {
    for (const id of [FIELD, CAVE]) {
      const map = mapOf(id);
      expect(map.encounters!.length, id).toBeGreaterThanOrEqual(5);
      for (const e of map.encounters!) expect(project.database.troops[e.troop], `${id} の ${e.troop}`).toBeDefined();
    }
    expect(mapOf(FIELD).encounterStep).toBe(18);
    expect(mapOf(CAVE).encounterStep).toBe(13);
    expect(mapOf(VILLAGE).encounters).toBeUndefined();
    expect(mapOf(SHRINE).encounters).toBeUndefined();
    // 草原の敵は洞窟の敵とかぶらない（洞窟の骸骨は草原に出ない）
    expect(mapOf(FIELD).encounters!.some((e) => e.troop.includes("skel"))).toBe(false);
    expect(mapOf(CAVE).encounters!.some((e) => e.troop.includes("skel"))).toBe(true);
  });

  it("出入り口の行き先は通れるタイルで、4 つのマップが一本につながる（村 ↔ 草原 ↔ 洞窟 ↔ ほこら）", () => {
    const links: [string, string, string][] = [
      [VILLAGE, "ev_to_field", FIELD],
      [FIELD, "ev_to_village", VILLAGE],
      [FIELD, "ev_to_cave", CAVE],
      [CAVE, "ev_cave_out", FIELD],
      [CAVE, "ev_to_shrine", SHRINE],
      [SHRINE, "ev_shrine_out", CAVE],
    ];
    for (const [from, id, to] of links) {
      const t = at(from, id).pages[0]!.commands.find((c: EventCommand) => c.code === "TransferPlayer")!.params as { mapId: string; x: number; y: number };
      expect(t.mapId, `${from} の ${id}`).toBe(to);
      const dest = mapOf(to);
      for (const l of dest.layers) {
        const tile = l.tiles[t.y * dest.width + t.x] ?? 0;
        expect(tile === 0 || passage[tile] !== 0, `${to} の (${t.x}, ${t.y})`).toBe(true);
      }
    }
  });

  it("村とほこらの中では、いくら歩いても魔物に出会わない", () => {
    encounters = [];
    let s = settle(newGame("hokora-safe"), fight);
    s = pace(s, 80);
    expect(s.map.mapId).toBe(VILLAGE);
    expect(s.map.encounterSteps).toBe(0);
    s = warp(s, SHRINE, 7, 8);
    expect(s.map.mapId).toBe(SHRINE);
    s = pace(s, 80);
    expect(s.map.mapId).toBe(SHRINE);
    expect(encounters).toEqual([]);
  });

  it("草原を歩くと、平均 18 歩に 1 回ほど魔物に出会う。戦闘を始めると歩数は 0 に戻る", () => {
    encounters = [];
    let s = afterElder("hokora-steps");
    s = walkTo(s, at(VILLAGE, "ev_to_field").x, at(VILLAGE, "ev_to_field").y);
    expect(s.map.mapId).toBe(FIELD);
    // レベルを上げて、戦闘は勝つだけ（回復は気にしない）。道を往復して 400 歩
    s = withLevel(s, 7);
    const dirs = pacer(s);
    for (let i = 0; i < 400; i++) s = refill(walk(s, [dirs[i % 2]!]));
    expect(s.scene.kind).toBe("map");
    // 平均 18 歩（戦闘のあと 9 歩は安全）→ 400 歩でおよそ 22 回。ばらつきを見込んで広めに
    expect(encounters.length).toBeGreaterThan(14);
    expect(encounters.length).toBeLessThan(34);
    for (const troop of encounters) expect(mapOf(FIELD).encounters!.map((e) => e.troop)).toContain(troop);
  });

  it("逃げると戦闘から出て、そのあと少しのあいだは魔物に出会わない", () => {
    encounters = [];
    let s = afterElder("hokora-escape");
    s = walkTo(s, at(VILLAGE, "ev_to_field").x, at(VILLAGE, "ev_to_field").y);
    // 最初の遭遇まで歩く
    const dirs = pacer(s);
    for (let i = 0; i < 200 && s.scene.kind === "map"; i++) {
      s = drive(s, ctx, [press(dirs[i % 2]!)]).state;
      s = driveUntil(s, ctx, (x) => x.scene.kind !== "map" || !x.map.player.moving, 60);
    }
    expect(s.scene.kind).toBe("battle");
    expect(s.battle!.canEscape).toBe(true);
    // 「逃げる」（コマンドの最後）を選び、成功するまで繰り返す
    for (let i = 0; i < 12 && s.scene.kind === "battle"; i++) {
      if (s.battle!.phase === "input" && s.battle!.inputCursor.menu === "command") {
        s = tap(s, ...(s.battle!.inputCursor.index === 4 ? [] : ["up" as const]), "ok");
      } else s = tap(s, "ok");
      s = driveUntil(s, ctx, (x) => x.scene.kind !== "battle" || x.battle!.phase === "input" || x.battle!.phase === "escape", 600);
      if (s.scene.kind === "battle" && s.battle!.phase === "escape") s = driveUntil(tap(s, "ok"), ctx, (x) => x.scene.kind !== "battle", 600);
    }
    expect(s.scene.kind).toBe("map");
    expect(s.map.encounterSteps).toBe(0);
    // 平均 18 歩の半分（9 歩）は、続けて歩いても出会わない
    const walked = pace(s, 9);
    expect(walked.scene.kind).toBe("map");
    expect(walked.map.encounterSteps).toBe(9);
  });

  it("メニューのアイテムからポーションを、スキルからミナのヒールを味方に使える（満タンの相手には使えない）", () => {
    let s = afterElder("hokora-menu");
    expect(s.party.items[item("item_potion")]).toBe(3);
    s = hurtAll(s, 20);
    // アイテム：ポーションを勇者に（60 回復。最大 HP で止まる）
    const potion = itemIndex(s, "item_potion");
    s = useItem(s, potion, 0);
    expect(s.actors[HERO]!.hp).toBe(mhpOf(s, HERO));
    expect(s.party.items[item("item_potion")]).toBe(2);
    // 満タンの勇者にはもう使えない（減らない）
    s = useItem(s, potion, 0);
    expect(s.party.items[item("item_potion")]).toBe(2);
    // スキル：ミナのヒールを自分に（MP を使う）
    const mp = s.actors[MINA]!.mp;
    s = healWithSkill(s, 1);
    expect(s.actors[MINA]!.hp).toBeGreaterThan(20);
    expect(s.actors[MINA]!.mp).toBe(mp - 3);
    expect(s.scene.kind).toBe("map");
  });

  it("宿屋：15G で泊まると HP/MP が回復する。おかねが足りないと泊まれない", () => {
    const inn = at(VILLAGE, "ev_inn");
    /** 宿屋の戸口の前まで歩いてから、傷ついた状態で話しかける（歩いている間は、戦闘の回復の手当てが入るので）。 */
    const atInn = (seed: string, gold?: number): State => {
      let s = afterElder(seed);
      s = walkTo(s, inn.x, inn.y + 1);
      s = hurtAll(s, 5);
      s = { ...s, party: { ...s.party, gold: gold ?? s.party.gold }, actors: { ...s.actors, [MINA]: { ...s.actors[MINA]!, mp: 0 } } };
      return talk(s, inn.x, inn.y, fight, [0]);
    };
    const rested = atInn("hokora-inn");
    expect(rested.party.gold).toBe(35);
    expect(rested.actors[HERO]!.hp).toBe(mhpOf(rested, HERO));
    expect(rested.actors[MINA]!.hp).toBe(mhpOf(rested, MINA));
    expect(rested.actors[MINA]!.mp).toBeGreaterThan(0);
    // おかねが足りない
    const poor = atInn("hokora-inn-2", 10);
    expect(poor.party.gold).toBe(10);
    expect(poor.actors[HERO]!.hp).toBe(5);
    expect(poor.actors[MINA]!.mp).toBe(0);
  });

  it("宿屋は「冒険を記録する」で SaveGame（セーブ画面）が開き、よろず屋はポーション・ハイポーション・エーテルを売る", () => {
    const inn = at(VILLAGE, "ev_inn").pages[0]!.commands;
    expect(inn.some((c) => c.code === "SaveGame")).toBe(true);
    expect(inn.some((c) => c.code === "ConditionalBranch" && c.params["condition"] === "gold >= 15")).toBe(true);
    const shop = at(VILLAGE, "ev_shop").pages[0]!.commands.find((c) => c.code === "ShopProcessing")!.params as { goods: string[]; canSell: boolean };
    expect(shop.goods).toEqual(["item_potion", "item_hipotion", "item_ether"]);
    expect(shop.canSell).toBe(true);
  });

  it("洞窟の封印の扉は、かぎが無いと開かない（扉のむこうの階段へ行けない）。かぎを持って話しかけると開く", () => {
    let s = warp(afterElder("hokora-door"), CAVE, 15, 8);
    const seal = at(CAVE, "ev_seal");
    const stairs = at(CAVE, "ev_to_shrine");
    s = talk(s, seal.x, seal.y);
    expect(s.switches["sw_door" as keyof State["switches"]]).not.toBe(true);
    expect(route(s, stairs.x, stairs.y)).toBeUndefined();
    // かぎ（スイッチ）を持っていれば開く
    s = { ...s, switches: { ...s.switches, ["sw_key" as keyof State["switches"]]: true } };
    s = talk(s, seal.x, seal.y);
    expect(s.switches["sw_door" as keyof State["switches"]]).toBe(true);
    expect(route(s, stairs.x, stairs.y)).toBeDefined();
  });

  it("ほこらの主に負けると村に戻され、HP/MP が回復する。主はそのまま残り、また挑める", () => {
    encounters = [];
    let s = afterElder("hokora-lose");
    const boss = at(SHRINE, "ev_boss");
    // ほこらまで直接移動してから挑む（ここまでの道のりは別のテストで通る）
    s = warp(s, SHRINE, 7, 8);
    expect(s.map.mapId).toBe(SHRINE);
    s = talk(s, boss.x, boss.y, guardOnly, [0]);
    expect(s.map.mapId).toBe(VILLAGE);
    expect([s.map.player.x, s.map.player.y]).toEqual([project.system.startX, project.system.startY]);
    for (const id of s.party.members) expect(s.actors[id]!.hp).toBeGreaterThan(1);
    expect(s.switches["sw_boss" as keyof State["switches"]]).not.toBe(true);
  });

  it.each(["hokora-1", "hokora-2", "hokora-3"])("素直な作戦で、村から草原・洞窟・ほこらを抜けて、ほこらの主を倒すとタイトルに戻る（シード %s）", (seed) => {
    encounters = [];
    menuHeals = 0;
    let s = afterElder(seed);
    expect(s.party.items[item("item_potion")]).toBe(3);
    expect(s.party.gold).toBe(50);

    // 草原：宝箱（ポーション 2 個）を開けて、レベル 4 になるまで歩いて鍛える（魔物に出会うたびに戦う。傷はメニューで手当て）
    s = goTo(s, FIELD);
    expect(s.map.mapId).toBe(FIELD);
    const fieldChest = at(FIELD, "ev_chest_field");
    const potions = s.party.items[item("item_potion")] ?? 0;
    s = talk(s, fieldChest.x, fieldChest.y);
    expect(s.party.items[item("item_potion")]).toBeGreaterThanOrEqual(potions + 2 - 3); // 戦闘の手当てで使った分を引いても
    s = grind(s, (x) => x.actors[HERO]!.level >= 4, FIELD);
    expect(s.scene.kind).toBe("map");
    expect(s.actors[HERO]!.level).toBeGreaterThanOrEqual(4);

    // 洞窟：封印の扉は、かぎが無いと開かない。かぎの宝箱 → エーテルの宝箱 → 扉
    s = goTo(s, CAVE);
    expect(s.map.mapId).toBe(CAVE);
    const seal = at(CAVE, "ev_seal");
    s = talk(s, seal.x, seal.y);
    expect(s.switches["sw_door" as keyof State["switches"]]).not.toBe(true);
    expect(route(s, at(CAVE, "ev_to_shrine").x, at(CAVE, "ev_to_shrine").y)).toBeUndefined();
    s = talk(s, at(CAVE, "ev_key").x, at(CAVE, "ev_key").y);
    expect(s.switches["sw_key" as keyof State["switches"]]).toBe(true);
    s = talk(s, at(CAVE, "ev_chest_cave").x, at(CAVE, "ev_chest_cave").y);
    expect(s.party.items[item("item_ether")] ?? 0).toBeGreaterThanOrEqual(1);

    // ほこらの主に挑む前に、レベル 5 になるまで洞窟で鍛える
    s = grind(s, (x) => x.actors[HERO]!.level >= 5, CAVE);
    expect(s.scene.kind).toBe("map");
    s = goTo(s, CAVE);
    s = talk(s, seal.x, seal.y);
    expect(s.switches["sw_door" as keyof State["switches"]]).toBe(true);
    s = goTo(s, SHRINE);
    expect(s.map.mapId).toBe(SHRINE);

    // ほこら：泉で回復して（記録はしない）、主に挑む。負けて村に戻されたら、もう少し鍛えてから挑み直す（3 回まで）
    const spring = at(SHRINE, "ev_spring");
    const boss = at(SHRINE, "ev_boss");
    for (let tries = 0; tries < 3 && s.scene.kind === "map"; tries++) {
      if (s.map.mapId !== SHRINE) {
        s = grind(s, (x) => x.actors[HERO]!.level >= 6 + tries, FIELD);
        s = goTo(s, CAVE);
        s = goTo(s, SHRINE);
      }
      s = talk(s, spring.x, spring.y, fight, [1]);
      for (const id of s.party.members) expect(s.actors[id]!.hp).toBe(mhpOf(s, id));
      s = talk(s, boss.x, boss.y, fight, [0]);
    }
    const names = s.party.members.map((id) => `${s.actors[id]!.name}Lv${s.actors[id]!.level}`).join(" ");
    expect(s.scene.kind, `${names}、ここまでの遭遇 ${encounters.length} 回（${encounters.slice(-4).join("・")}）`).toBe("title");
    expect(encounters.length, "洞窟と草原で、ランダムエンカウントが何度も起きた").toBeGreaterThan(8);
    expect(menuHeals, "傷はメニューのアイテム・スキルで手当てした").toBeGreaterThan(0);
    expect(new Set(encounters.map((t) => mapOf(CAVE).encounters!.some((e) => e.troop === t))).size, "草原の敵も洞窟の敵も出た").toBe(2);
  });

  it("エンカウントの有無・戦闘は同じシードなら同じ結果になる（歩き方も同じなら、同じ場所で同じ敵）", () => {
    const meet = (): string[] => {
      encounters = [];
      let s = afterElder("hokora-det");
      s = walkTo(s, at(VILLAGE, "ev_to_field").x, at(VILLAGE, "ev_to_field").y);
      s = withLevel(s, 6);
      const dirs = pacer(s);
      for (let i = 0; i < 120; i++) s = refill(walk(s, [dirs[i % 2]!]));
      return [...encounters];
    };
    const a = meet();
    expect(a.length).toBeGreaterThan(2);
    expect(meet()).toEqual(a);
  });

  it("[calibration] 勇者とミナ Lv5 は洞窟の敵に、Lv1 では勝てないガイコツ 2 体に勝てる（戦闘バランスの目安）", () => {
    const kit = { project, ctx, state: withLevel(newGame("hokora-balance"), 1) };
    const wins = (troop: string, level: number, n = 12): number => {
      let w = 0;
      for (let i = 0; i < n; i++) {
        const from = withLevel(newGame(`hk-${troop}-${i}`), level);
        const s = autoBattle(beginBattle(kit, troop, { canEscape: false, canLose: false }, { ...from, actors: { ...from.actors, [HERO]: { ...from.actors[HERO]!, hp: 9999, mp: 999 }, [MINA]: { ...from.actors[MINA]!, hp: 9999, mp: 999 } } }), ctx, fight);
        if (s.scene.kind === "map") w++;
      }
      return w;
    };
    expect(wins("tr_skeletons", 5)).toBeGreaterThanOrEqual(11);
    expect(wins("tr_skeletons", 1)).toBeLessThanOrEqual(3);
    expect(wins("tr_slime", 1)).toBe(12);
    // ほこらの主は、Lv3 ではまず勝てず、Lv6 ならほぼ勝てる
    expect(wins("tr_boss", 3)).toBeLessThanOrEqual(2);
    expect(wins("tr_boss", 6)).toBeGreaterThanOrEqual(11);
  });
});
