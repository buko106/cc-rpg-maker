import { describe, expect, it } from "vitest";
import { autoBattle, drive, driveUntil, idleFrames, loadFixtureProject, press, runReplay } from "@rpg/test-utils";
import type { AutoBattlePolicy } from "@rpg/test-utils";
import type { MapData } from "@rpg/schema";

// バトルタワーのデモ（fixtures/projects/v1/tower。tools/make-tower-demo.mjs が生成する）の約束ごと
const { project, maps, ctx } = loadFixtureProject("tower");
type State = ReturnType<typeof runReplay>["state"];
type Dir = "up" | "down" | "left" | "right";

const FLOORS = 6;
const floorId = (n: number): string => `map_f${n}`;
const mapOf = (id: string): MapData => maps[id as keyof typeof maps]!;
const passage = Object.values(project.tilesets)[0]!.passage;
const STEPS: [Dir, number, number][] = [["up", 0, -1], ["down", 0, 1], ["left", -1, 0], ["right", 1, 0]];

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

/**
 * イベントの処理が終わるまで進める。メッセージは決定で送り、選択肢は `answers` の順に答え（尽きたら先頭）、戦闘は `policy` で戦う。
 * タイトルに戻ったらそこで止まる。
 */
function settle(state: State, policy: AutoBattlePolicy, answers: number[] = []): State {
  let s = state;
  for (let i = 0; i < 400 && busy(s); i++) {
    if (s.scene.kind === "title") return s;
    if (s.scene.kind === "battle") s = autoBattle(s, ctx, policy);
    else if (s.message.open && s.message.choices !== null) {
      const want = answers.shift() ?? 0;
      s = drive(s, ctx, idleFrames(2)).state;
      while ((s.message.cursor ?? 0) !== want) s = drive(s, ctx, [press("down"), ...idleFrames(1)]).state;
      s = drive(s, ctx, [press("ok"), ...idleFrames(1)]).state;
    } else if (s.message.open) s = drive(s, ctx, [...idleFrames(2), press("ok"), ...idleFrames(1)]).state;
    else s = driveUntil(s, ctx, (x) => !busy(x) || x.message.open || x.scene.kind !== "map", 600);
  }
  return drive(s, ctx, idleFrames(2)).state;
}

/** 1 歩ずつ歩く。途中でイベントが動いたら終わるまで進める。 */
function walk(state: State, dirs: readonly Dir[], policy: AutoBattlePolicy = fight): State {
  let s = state;
  for (const d of dirs) s = settle(drive(s, ctx, [press(d)]).state, policy);
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

/** 素直な作戦：僧侶は蘇生・回復・目覚まし、魔法使いは全体魔法か強い魔法、勇者は強打。回復役がいなければ勇者が薬を使う。 */
const fight: AutoBattlePolicy = ({ battle, actor, skills, items }) => {
  const allies = battle.party.flatMap((id) => (battle.allies[id] === undefined ? [] : [battle.allies[id]!]));
  const enemies = battle.enemyOrder.flatMap((id) => (battle.enemies[id] !== undefined && battle.enemies[id]!.hp > 0 ? [battle.enemies[id]!] : []));
  const weakest = enemies.reduce((a, e) => (e.hp < a.hp ? e : a), enemies[0]!);
  const can = (id: string): boolean => skills.some((s) => s.id === id && s.mpCost <= actor.mp);
  const hurt = allies.filter((a) => a.hp > 0 && a.hp < a.params.mhp * 0.5).sort((a, b) => a.hp / a.params.mhp - b.hp / b.params.mhp);
  const dead = allies.filter((a) => a.hp <= 0);
  const asleep = allies.filter((a) => a.hp > 0 && a.states.some((s) => s.id === "st_sleep"));
  const healer = allies.some((a) => a.id === "actor_cleric" && a.hp > 0);
  switch (actor.id) {
    case "actor_cleric":
      if (dead.length > 0 && can("sk_raise")) return { kind: "skill", skill: "sk_raise", target: dead[0]!.id };
      if (hurt.length >= 2 && can("sk_healall")) return { kind: "skill", skill: "sk_healall" };
      if (hurt.length > 0 && can("sk_heal")) return { kind: "skill", skill: "sk_heal", target: hurt[0]!.id };
      if (asleep.length > 0 && can("sk_cure")) return { kind: "skill", skill: "sk_cure", target: asleep[0]!.id };
      return { kind: "attack", target: weakest.id };
    case "actor_mage":
      if (enemies.length >= 2 && can("sk_flame")) return { kind: "skill", skill: "sk_flame" };
      if (can("sk_thunder")) return { kind: "skill", skill: "sk_thunder", target: weakest.id };
      if (can("sk_fire")) return { kind: "skill", skill: "sk_fire", target: weakest.id };
      return { kind: "attack", target: weakest.id };
    default: {
      const potion = items.find((i) => i.id === "item_hipotion") ?? items.find((i) => i.id === "item_potion");
      if (!healer && hurt.length > 0 && potion !== undefined) return { kind: "item", item: potion.id, target: hurt[0]!.id };
      if (can("sk_smash")) return { kind: "skill", skill: "sk_smash", target: weakest.id };
      return { kind: "attack", target: weakest.id };
    }
  }
};

/** 何もしない（防御だけ）作戦。負けるときの流れを見る。 */
const guardOnly: AutoBattlePolicy = () => ({ kind: "guard" });

const newGame = (seed: string): State => runReplay({ project: "fixtures/projects/v1/tower", seed, inputs: [], expect: {} }).state;
const at = (s: State, id: string) => {
  const ev = mapOf(s.map.mapId).events[id as keyof MapData["events"]];
  if (ev === undefined) throw new Error(`${s.map.mapId} に ${id} が無い`);
  return ev;
};
const guardianAlive = (s: State): boolean => s.map.events["ev_guardian" as keyof State["map"]["events"]]?.pageIndex === 0;

/** 今の階の魔法陣で回復し、番人に挑む。勝てば上り階段へ。 */
function climbFloor(state: State, policy: AutoBattlePolicy = fight): State {
  let s = state;
  const circle = at(s, "ev_circle");
  s = walkTo(s, circle.x, circle.y, policy);
  const guardian = at(s, "ev_guardian");
  s = talk(s, guardian.x, guardian.y, policy, [0]);
  if (s.scene.kind === "title" || s.map.mapId === floorId(1) || guardianAlive(s)) return s;
  if (s.map.mapId === floorId(3)) {
    const cleric = at(s, "ev_cleric");
    s = talk(s, cleric.x, cleric.y, policy);
  }
  const up = at(s, "ev_up");
  return walkTo(s, up.x, up.y, policy);
}

describe("バトルタワーのデモ（fixtures/projects/v1/tower）", () => {
  it("1F〜5F と屋上の 6 枚のマップ。どの階も 13×12 で、画面（416×384）にちょうど収まる", () => {
    expect(Object.keys(maps).sort()).toEqual(Array.from({ length: FLOORS }, (_, i) => floorId(i + 1)));
    for (const map of Object.values(maps)) expect([map.width, map.height]).toEqual([13, 12]);
    expect(project.system.screen).toEqual({ width: 13 * 32, height: 12 * 32 });
    expect(project.system.initialParty).toEqual(["actor_hero", "actor_mage"]);
  });

  it("階段は隣の階どうしをつなぎ、着く場所は通れるタイル。場所移動は暗転する", () => {
    for (let n = 1; n <= FLOORS; n++) {
      const map = mapOf(floorId(n));
      for (const [id, to] of [["ev_up", n + 1], ["ev_down", n - 1]] as const) {
        const ev = map.events[id as keyof MapData["events"]];
        expect(ev !== undefined, `${map.id} の ${id}`).toBe(to >= 1 && to <= FLOORS);
        if (ev === undefined) continue;
        const t = ev.pages[0]!.commands.find((c) => c.code === "TransferPlayer")!.params as { mapId: string; x: number; y: number; fade: string };
        expect(t.mapId).toBe(floorId(to));
        expect(t.fade).toBe("black");
        const dest = mapOf(t.mapId);
        expect(dest.layers.every((l) => passage[l.tiles[t.y * dest.width + t.x] ?? 0] !== 0 || (l.tiles[t.y * dest.width + t.x] ?? 0) === 0)).toBe(true);
      }
    }
  });

  it("2F〜屋上には番人と回復の魔法陣がある。番人を倒すまで上り階段へは行けない", () => {
    for (let n = 2; n <= FLOORS; n++) {
      const map = mapOf(floorId(n));
      expect(map.events["ev_guardian" as keyof MapData["events"]], map.id).toBeDefined();
      expect(map.events["ev_circle" as keyof MapData["events"]], map.id).toBeDefined();
    }
    // 2F へ上がって確かめる
    let s = newGame("tower-blocked");
    s = walkTo(s, at(s, "ev_up").x, at(s, "ev_up").y);
    expect(s.map.mapId).toBe(floorId(2));
    expect(route(s, at(s, "ev_up").x, at(s, "ev_up").y)).toBeUndefined();
  });

  it.each(["tower-1", "tower-2", "tower-3"])("素直な作戦で 1F から屋上まで登り、炎の竜を倒すとタイトルに戻る（シード %s）", (seed) => {
    let s = newGame(seed);
    const reception = at(s, "ev_reception");
    s = talk(s, reception.x, reception.y);
    expect(s.party.items["item_potion" as keyof State["party"]["items"]]).toBe(3);
    const up = at(s, "ev_up");
    s = walkTo(s, up.x, up.y);
    const log: string[] = [];
    for (let n = 2; n <= FLOORS; n++) {
      // 負けたら入口から登り直す（3 回まで）
      for (let tries = 0; tries < 3 && s.map.mapId !== floorId(n + 1) && s.scene.kind !== "title"; tries++) {
        while (s.map.mapId !== floorId(n)) s = walkTo(s, at(s, "ev_up").x, at(s, "ev_up").y);
        s = climbFloor(s);
        const party = s.party.members.map((id) => `${s.actors[id]!.name}Lv${s.actors[id]!.level}`).join(" ");
        log.push(`${n}F: ${s.scene.kind === "title" ? "クリア" : s.map.mapId} ${party}`);
      }
      if (n < FLOORS) expect(s.map.mapId, log.join("\n")).toBe(floorId(n + 1));
    }
    expect(s.scene.kind, log.join("\n")).toBe("title");
  });

  it("負けると入口に戻され、HP/MP が戻る。番人はそのまま残り、また挑める", () => {
    let s = newGame("tower-lose");
    s = walkTo(s, at(s, "ev_up").x, at(s, "ev_up").y);
    const guardian = at(s, "ev_guardian");
    s = talk(s, guardian.x, guardian.y, guardOnly, [0]);
    expect(s.map.mapId).toBe(floorId(1));
    expect([s.map.player.x, s.map.player.y]).toEqual([project.system.startX, project.system.startY]);
    for (const id of s.party.members) expect(s.actors[id]!.hp).toBeGreaterThan(1);
    // 2F に戻ると番人はまだいる
    s = walkTo(s, at(s, "ev_up").x, at(s, "ev_up").y);
    expect(guardianAlive(s)).toBe(true);
  });

  it("訓練用のかかしとは何度でも戦えて、経験値が入る", () => {
    let s = newGame("tower-dummy");
    const dummy = at(s, "ev_dummy");
    for (let i = 0; i < 2; i++) s = talk(s, dummy.x, dummy.y, fight, [0]);
    expect(s.actors["actor_hero" as keyof State["actors"]]!.exp).toBe(16);
  });

  it("3F の大グモを倒すと僧侶が仲間になる（倒す前は話しかけても加わらない）", () => {
    let s = newGame("tower-cleric");
    s = walkTo(s, at(s, "ev_up").x, at(s, "ev_up").y);
    s = climbFloor(s);
    expect(s.map.mapId).toBe(floorId(3));
    const cleric = at(s, "ev_cleric");
    s = talk(s, cleric.x, cleric.y);
    expect(s.party.members).not.toContain("actor_cleric");
    s = climbFloor(s);
    expect(s.map.mapId).toBe(floorId(4));
    expect(s.party.members).toEqual(["actor_hero", "actor_mage", "actor_cleric"]);
  });
});
