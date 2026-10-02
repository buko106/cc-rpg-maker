import { defineEventTemplate, z } from "@rpg/plugin-api";
import type { Diagnostic, EventDraft, PluginDocument } from "@rpg/plugin-api";
import { parseConfig } from "./config.js";
import type { Config } from "./config.js";

type Cmd = EventDraft["pages"][number]["commands"][number];
const cmd = (code: string, params: Record<string, unknown>): Cmd => ({ code, params, indent: 0 }) as Cmd;
const say = (text: string): Cmd => cmd("ShowText", { text, position: "bottom", background: "window" });

/** プロジェクトの設定にあるイベント用の変数名（設定が読めなければ既定）。 */
const eventVarOf = (params: Readonly<Record<string, unknown>> | undefined): string => {
  const r = parseConfig(params ?? {});
  return r.ok ? r.config.vars.event : "var_dungeon_event";
};

/** エディタのひな形：ダンジョンの入口と、フロアのコントローラ。 */
export function dungeonTemplates(): ReturnType<typeof defineEventTemplate>[] {
  const entrance = defineEventTemplate({
    id: "entrance",
    label: "ダンジョンの入口",
    description: "話しかけると、ダンジョンの 1 階に入る（入るたびに地形が変わる）。",
    input: z.strictObject({
      name: z.string().meta({ title: "イベント名", initial: "ダンジョンの入口" }),
      message: z.string().meta({ title: "入るときのセリフ", multiline: true, initial: "暗い洞窟が 口を開けている。\n\n……入ってみよう。" }),
    }),
    build: (i) => ({
      name: i.name,
      pages: [{ conditions: [], trigger: "action", through: false, priority: "same", commands: [...i.message.split(/\n\s*\n/).filter((t) => t.trim() !== "").map(say), cmd("plugin:dungeon/Enter", {})] }],
    }),
  });

  const controller = defineEventTemplate({
    id: "controller",
    label: "ダンジョンのコントローラ",
    description: "フロアのひな形のマップに 1 つだけ置く。毎フレーム 1 コマ進め、倒れたとき・宝を手に入れたときに、セリフを出して町へ戻す。",
    input: z.strictObject({
      name: z.string().meta({ title: "イベント名", initial: "ダンジョンのコントローラ" }),
      dead: z.string().meta({ title: "倒れたときのセリフ", multiline: true, initial: "目の前が 真っ暗になった……\n\n気がつくと、洞窟の入口に 倒れていた。\n持ち物とお金を 失ってしまったようだ。" }),
      clear: z.string().meta({ title: "宝を手に入れたときのセリフ", multiline: true, initial: "ついに 宝を 手に入れた！\n\n光に包まれて、洞窟の入口に 戻ってきた。" }),
    }),
    build(i, project) {
      const v = eventVarOf(project.system.plugins.find((p) => p.name === "dungeon")?.params);
      const texts = (t: string): Cmd[] => t.split(/\n\s*\n/).filter((x) => x.trim() !== "").map(say);
      const page = (op: number, trigger: "parallel" | "autorun", commands: Cmd[]) => ({
        conditions: op === 0 ? [] : [{ kind: "variable" as const, id: v, op: "==" as const, value: op }],
        trigger,
        through: true,
        priority: "below" as const,
        commands,
      });
      return {
        name: i.name,
        pages: [
          page(0, "parallel", [cmd("plugin:dungeon/Tick", {})]),
          page(1, "autorun", [...texts(i.dead), cmd("plugin:dungeon/Finish", { result: "dead" })]),
          page(2, "autorun", [cmd("FlashScreen", { color: { r: 255, g: 250, b: 210, a: 1 }, duration: 30, wait: true }), ...texts(i.clear), cmd("plugin:dungeon/Finish", { result: "clear" })]),
        ],
      } as EventDraft;
    },
  });
  return [entrance, controller];
}

/** エディタの診断：ひな形のマップの大きさ・コントローラ・敵や物の参照を調べる。 */
export function dungeonDiagnostics(doc: PluginDocument): Diagnostic[] {
  const ref = doc.project.system.plugins.find((p) => p.name === "dungeon");
  if (ref === undefined) return [];
  const parsed = parseConfig(ref.params);
  if (!parsed.ok) return [{ severity: "error", code: "dungeonConfig", message: parsed.message }];
  const cfg: Config = parsed.config;
  const out: Diagnostic[] = [];
  const map = doc.maps[cfg.floorMap as keyof typeof doc.maps];
  if (doc.project.maps[cfg.floorMap as keyof typeof doc.project.maps] === undefined) out.push({ severity: "error", code: "dungeonFloorMap", message: `ダンジョンのひな形のマップ ${cfg.floorMap} が無い` });
  else if (map !== undefined) {
    if (map.width !== cfg.width || map.height !== cfg.height) {
      out.push({ severity: "error", code: "dungeonFloorSize", message: `ひな形のマップ ${cfg.floorMap} の大きさ (${map.width}×${map.height}) が、設定の width × height (${cfg.width}×${cfg.height}) と違う` });
    }
    const hasTick = Object.values(map.events).some((ev) => ev.pages.some((p) => p.commands.some((c) => c.code === "plugin:dungeon/Tick")));
    if (!hasTick) out.push({ severity: "warning", code: "dungeonNoController", message: `ひな形のマップ ${cfg.floorMap} に、plugin:dungeon/Tick を呼ぶイベント（ダンジョンのコントローラ）が無い。敵が動かない` });
  }
  const db = doc.project.database;
  for (const e of cfg.enemies) {
    if (!Object.hasOwn(db.enemies, e.enemy)) out.push({ severity: "error", code: "dungeonEnemy", message: `ダンジョンの敵 ${e.enemy} がデータベースに無い` });
  }
  for (const it of cfg.items) {
    if (it.kind === "item" && !Object.hasOwn(db.items, it.item)) out.push({ severity: "error", code: "dungeonItem", message: `ダンジョンの落ちている物 ${it.item} がデータベースに無い` });
  }
  return out;
}
