import type { ProjectView } from "@rpg/core";
import type { Item, Param, Scope, Skill, SkillEffect } from "@rpg/schema";
import type { UiNode } from "../frame-spec.js";
import { term } from "./terms.js";
import type { TermKey } from "./terms.js";
import { textColor, UI_PADDING } from "./theme.js";
import { textNode, windowNode } from "./ui.js";

const SCOPE_LABEL: Record<Scope, string> = {
  none: "",
  self: "自分",
  "one-enemy": "敵1体",
  "all-enemies": "敵全体",
  "one-ally": "味方1人",
  "all-allies": "味方全体",
  "one-dead-ally": "戦闘不能の味方1人",
};

const HOSTILE: ReadonlySet<Scope> = new Set(["one-enemy", "all-enemies"]);
const PARAM_ORDER: readonly Param[] = ["mhp", "mmp", "atk", "def", "mat", "mdf", "agi", "luk"];

const isSkill = (def: Item | Skill): def is Skill => "scope" in def;

const signed = (n: number): string => (n >= 0 ? `+${n}` : String(n));

function describeEffect(view: ProjectView, effect: SkillEffect): string | undefined {
  switch (effect.kind) {
    case "recoverHp":
      return `${term(view, "hp")}を${effect.value}回復`;
    case "recoverMp":
      return `${term(view, "mp")}を${effect.value}回復`;
    case "addState": {
      const name = view.state(effect.state)?.name ?? effect.state;
      return effect.chance >= 1 ? `${name}にする` : `${Math.round(effect.chance * 100)}%で${name}にする`;
    }
    case "removeState":
      return `${view.state(effect.state)?.name ?? effect.state}を治す`;
    case "buff": {
      const name = term(view, effect.param as TermKey);
      return effect.level >= 0 ? `${name}を上げる` : `${name}を下げる`;
    }
    case "commonEvent":
      return undefined; // 中身が分からない効果は書かない（説明文を書いてもらう）
  }
}

/**
 * アイテム/スキルの説明文。`description` があればそのまま（`""` なら何も出さない）。
 * なければ、対象・式・効果・装備の能力値から作る。式は具体的な数値が出せないので「ダメージ」「回復」とだけ書く。
 */
export function describeDef(view: ProjectView, def: Item | Skill | undefined): string {
  if (def === undefined) return "";
  if (def.description !== undefined) return def.description;
  const parts: string[] = [];
  const formula = (def.formula ?? "").trim();
  if (formula !== "") {
    const hostile = isSkill(def) && HOSTILE.has(def.scope);
    parts.push(hostile || !formula.startsWith("-") ? "ダメージを与える" : `${term(view, "hp")}を回復`);
  }
  for (const effect of def.effects) {
    const text = describeEffect(view, effect);
    if (text !== undefined) parts.push(text);
  }
  if (!isSkill(def) && def.params !== undefined) {
    for (const param of PARAM_ORDER) {
      const value = def.params[param];
      if (value !== undefined && value !== 0) parts.push(`${term(view, param)}${signed(value)}`);
    }
  }
  if (parts.length === 0) return "";
  const scope = isSkill(def) ? SCOPE_LABEL[def.scope] : def.effects.length > 0 || formula !== "" ? "味方1人" : "";
  return scope === "" ? parts.join("、") : `${scope}：${parts.join("、")}`;
}

const HELP_FONT = { family: "sans-serif", size: 12 } as const;
const HELP_LINE = 16;
const HELP_LINES = 2;
/** 説明の窓の高さ（2 行ぶん）。 */
export const HELP_HEIGHT = HELP_LINES * HELP_LINE + UI_PADDING * 2;

/** 全角は 1em、半角は約 0.55em として、幅 `width` に収まる行へ折り返す（改行 `\n` も効く）。 */
export function wrapLines(text: string, width: number, size: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    let used = 0;
    for (const ch of paragraph) {
      const w = ch.charCodeAt(0) < 0x100 ? size * 0.55 : size;
      if (used + w > width && line !== "") {
        lines.push(line);
        line = "";
        used = 0;
      }
      line += ch;
      used += w;
    }
    lines.push(line);
  }
  return lines;
}

/** 説明の窓（幅いっぱい・2 行まで）。説明が空なら空の窓だけを出す（レイアウトが揺れないように）。 */
export function helpWindow(view: ProjectView, def: Item | Skill | undefined, x: number, y: number, w: number): UiNode {
  const text = describeDef(view, def);
  const lines = wrapLines(text, w - UI_PADDING * 2, HELP_FONT.size).slice(0, HELP_LINES);
  return windowNode(
    x,
    y,
    w,
    HELP_HEIGHT,
    lines.map((line, i) => textNode(x + UI_PADDING, y + UI_PADDING + i * HELP_LINE, line, textColor(0), { font: HELP_FONT })),
  );
}

