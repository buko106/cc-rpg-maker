import type { EventCommand } from "./command.js";
import type { SkillEffect } from "./database.js";
import type { MapId } from "./ids.js";
import type { MapData } from "./map.js";
import type { Project } from "./project.js";

export type RefKind =
  | "actor"
  | "class"
  | "skill"
  | "item"
  | "enemy"
  | "troop"
  | "map"
  | "commonEvent"
  | "state"
  | "asset"
  | "switch"
  | "variable"
  | "tileset";

export interface RefTarget {
  kind: RefKind;
  id: string;
}

export interface Ref {
  /** 参照元を人が読める形で表す。例: `map:m1/event:e1/page:0`、`database.actors.a1` */
  from: string;
  to: RefTarget;
}

/** コマンド内の参照を返す関数。コマンドの意味を知っているのは `core` のレジストリなので注入する。 */
export type CommandRefResolver = (c: EventCommand) => RefTarget[];

const t = (kind: RefKind, id: string): RefTarget => ({ kind, id });

/** Project とロード済み MapData から、すべての参照（参照元 → 参照先）を集める。 */
export function collectRefs(p: Project, maps: Record<MapId, MapData>, resolveCommandRefs: CommandRefResolver): Ref[] {
  const refs: Ref[] = [];
  const add = (from: string, to: RefTarget): void => {
    refs.push({ from, to });
  };
  const addCommands = (from: string, commands: readonly EventCommand[]): void => {
    commands.forEach((c, i) => {
      for (const to of resolveCommandRefs(c)) add(`${from}/command:${i}`, to);
    });
  };
  const addSkillEffects = (from: string, effects: readonly SkillEffect[]): void => {
    for (const e of effects) {
      if (e.kind === "commonEvent") add(from, t("commonEvent", e.id));
      else if (e.kind === "addState" || e.kind === "removeState") add(from, t("state", e.state));
    }
  };

  const { system, database: db } = p;
  add("system", t("map", system.startMap));
  for (const a of system.initialParty) add("system.initialParty", t("actor", a));
  for (const key of ["title", "battle"] as const) {
    const bgm = system.bgm[key];
    if (bgm) add(`system.bgm.${key}`, t("asset", bgm.asset));
  }

  for (const ts of Object.values(p.tilesets)) if (ts.image) add(`tilesets.${ts.id}`, t("asset", ts.image.asset));
  for (const m of Object.values(p.maps)) if (m.parent) add(`maps.${m.id}`, t("map", m.parent));

  for (const a of Object.values(db.actors)) {
    const from = `database.actors.${a.id}`;
    add(from, t("class", a.classId));
    if (a.face) add(from, t("asset", a.face.asset));
    if (a.walk) add(from, t("asset", a.walk.asset));
    for (const item of Object.values(a.equips)) add(from, t("item", item));
  }
  for (const c of Object.values(db.classes)) for (const s of c.skills) add(`database.classes.${c.id}`, t("skill", s.skill));
  for (const s of Object.values(db.skills)) {
    const from = `database.skills.${s.id}`;
    if (s.animation) add(from, t("asset", s.animation.asset));
    addSkillEffects(from, s.effects);
  }
  for (const i of Object.values(db.items)) addSkillEffects(`database.items.${i.id}`, i.effects);
  for (const e of Object.values(db.enemies)) {
    const from = `database.enemies.${e.id}`;
    if (e.graphic) add(from, t("asset", e.graphic.asset));
    for (const act of e.actions) add(from, t("skill", act.skill));
    for (const d of e.drops) add(from, t("item", d.item));
  }
  for (const tr of Object.values(db.troops)) {
    const from = `database.troops.${tr.id}`;
    for (const m of tr.members) add(from, t("enemy", m.enemy));
    tr.pages.forEach((page, i) => {
      if (page.condition.kind === "switch") add(`${from}/page:${i}`, t("switch", page.condition.id));
      addCommands(`${from}/page:${i}`, page.commands);
    });
  }
  for (const ce of Object.values(db.commonEvents)) {
    const from = `database.commonEvents.${ce.id}`;
    if (ce.switch) add(from, t("switch", ce.switch));
    addCommands(from, ce.commands);
  }

  for (const map of Object.values(maps)) {
    const from = `map:${map.id}`;
    add(from, t("tileset", map.tileset));
    if (map.bgm) add(from, t("asset", map.bgm.asset));
    for (const enc of map.encounters ?? []) add(from, t("troop", enc.troop));
    for (const ev of Object.values(map.events)) {
      ev.pages.forEach((page, i) => {
        const pageFrom = `${from}/event:${ev.id}/page:${i}`;
        for (const cond of page.conditions) {
          if (cond.kind === "switch") add(pageFrom, t("switch", cond.id));
          else if (cond.kind === "variable") add(pageFrom, t("variable", cond.id));
          else if (cond.kind === "item") add(pageFrom, t("item", cond.id));
          else if (cond.kind === "actor") add(pageFrom, t("actor", cond.id));
        }
        if (page.graphic) add(pageFrom, t("asset", page.graphic.asset));
        addCommands(pageFrom, page.commands);
      });
    }
  }
  return refs;
}

function exists(p: Project, target: RefTarget): boolean {
  const has = (table: object): boolean => Object.hasOwn(table, target.id);
  switch (target.kind) {
    case "actor": return has(p.database.actors);
    case "class": return has(p.database.classes);
    case "skill": return has(p.database.skills);
    case "item": return has(p.database.items);
    case "enemy": return has(p.database.enemies);
    case "troop": return has(p.database.troops);
    case "commonEvent": return has(p.database.commonEvents);
    case "state": return has(p.database.states);
    case "map": return has(p.maps);
    case "tileset": return has(p.tilesets);
    case "asset": return has(p.assets.entries);
    case "switch": return has(p.switches);
    case "variable": return has(p.variables);
  }
}

/** 参照先が存在しない参照（参照切れ）を、重複なしで返す。 */
export function findDanglingRefs(p: Project, maps: Record<MapId, MapData>, resolveCommandRefs: CommandRefResolver): RefTarget[] {
  const seen = new Set<string>();
  const dangling: RefTarget[] = [];
  for (const { to } of collectRefs(p, maps, resolveCommandRefs)) {
    const key = `${to.kind}:${to.id}`;
    if (seen.has(key) || exists(p, to)) continue;
    seen.add(key);
    dangling.push(to);
  }
  return dangling;
}
