import type { BattleLogEntry, BattleState, GameState, ProjectView } from "@rpg/core";
import { fill, term } from "./terms.js";

/** 戦闘者の id → 表示名。 */
export function nameOf(b: BattleState, id: string): string {
  return b.allies[id]?.name ?? b.enemies[id]?.name ?? id;
}

/**
 * ログ 1 件 → 表示する文章（0 行以上）。文言は `system.terms` が優先で、無ければ既定。
 * `turn` や、倒れている戦闘者の行動不能（`dead`）のように、文にしないものは空。
 */
export function formatLogEntry(entry: BattleLogEntry, state: GameState, view: ProjectView): string[] {
  const b = state.battle;
  if (b === undefined) return [];
  const name = (id: string): string => nameOf(b, id);
  const t = (key: Parameters<typeof term>[1], values: Record<string, string | number> = {}): string => fill(term(view, key), values);
  const itemName = (id: string): string => view.item(id as never)?.name ?? id;

  switch (entry.kind) {
    case "appear": {
      const names = b.enemyOrder.map((id) => b.enemies[id]?.name).filter((n): n is string => n !== undefined);
      if (names.length === 0) return [];
      return [names.length === 1 ? t("battleAppear", { name: names[0]! }) : t("battleAppearMany", { name: names[0]! })];
    }
    case "turn":
      return [];
    case "action": {
      const subject = name(entry.subject);
      switch (entry.action) {
        case "attack":
          return [t("actionAttack", { subject })];
        case "skill":
          return [t("actionSkill", { subject, skill: entry.skillId === undefined ? "" : (view.skill(entry.skillId)?.name ?? entry.skillId) })];
        case "item":
          return [t("actionItem", { subject, item: entry.itemId === undefined ? "" : itemName(entry.itemId) })];
        case "guard":
          return [t("actionGuard", { subject })];
        case "escape":
          return [t("actionEscape", { subject })];
      }
      return [];
    }
    case "damage": {
      const lines = [t("damage", { target: name(entry.target), amount: entry.amount })];
      return entry.critical ? [t("critical"), ...lines] : lines;
    }
    case "heal":
      return [t(entry.stat === "hp" ? "healHp" : "healMp", { target: name(entry.target), amount: entry.amount })];
    case "miss":
      return [t("miss", { target: name(entry.target) })];
    case "defeated":
      return [t("defeated", { target: name(entry.target) })];
    case "revived":
      return [t("revived", { target: name(entry.target) })];
    case "state":
      return [t(entry.added ? "stateAdded" : "stateRemoved", { target: name(entry.target), state: view.state(entry.state)?.name ?? entry.state })];
    case "buff": {
      const param = term(view, entry.param);
      return [t(entry.level >= 0 ? "buffUp" : "buffDown", { target: name(entry.target), param })];
    }
    case "cannotAct": {
      if (entry.reason === "dead") return [];
      const subject = name(entry.subject);
      const key = entry.reason === "state" ? "cannotActState" : entry.reason === "mp" ? "cannotActMp" : entry.reason === "item" ? "cannotActItem" : "cannotActSkill";
      return [t(key, { subject })];
    }
    case "escape":
      return [t(entry.success ? "escapeSuccess" : "escapeFail")];
    case "victory":
      return [t("victory")];
    case "defeat":
      return [t("defeat")];
    case "rewards":
      return [t("rewards", { exp: entry.exp, gold: entry.gold }), ...entry.items.map((id) => t("drop", { item: itemName(id) }))];
    case "levelUp":
      return [t("levelUp", { actor: name(entry.actor), level: entry.level })];
  }
}
