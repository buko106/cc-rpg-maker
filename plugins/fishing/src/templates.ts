import { defineEventTemplate, z } from "@rpg/plugin-api";
import type { Diagnostic, EventDraft, PluginDocument } from "@rpg/plugin-api";
import { parseConfig } from "./config.js";

type Cmd = EventDraft["pages"][number]["commands"][number];
const cmd = (code: string, params: Record<string, unknown>): Cmd => ({ code, params, indent: 0 }) as Cmd;
const say = (text: string): Cmd => cmd("ShowText", { text, position: "bottom", background: "window" });
const texts = (t: string): Cmd[] => t.split(/\n\s*\n/).filter((x) => x.trim() !== "").map(say);

/** プロジェクトの設定にあるイベント用の変数名（設定が読めなければ既定）。 */
const eventVarOf = (params: Readonly<Record<string, unknown>> | undefined): string => {
  const r = parseConfig(params ?? {});
  return r.ok ? r.config.vars.event : "var_fishing_event";
};

/** エディタのひな形：釣り場・つり手帳・大会の進行役。 */
export function fishingTemplates(): ReturnType<typeof defineEventTemplate>[] {
  const spot = defineEventTemplate({
    id: "spot",
    label: "釣り場",
    description: "水辺に向かって決定ボタンを押すと、竿を振る。魚のかかり方は、釣り場の種類（設定の fish.spots）で変わる。",
    input: z.strictObject({
      name: z.string().meta({ title: "イベント名", initial: "釣り場" }),
      spot: z.string().meta({ title: "釣り場の種類", initial: "pier" }),
    }),
    build: (i) => ({ name: i.name, pages: [{ conditions: [], trigger: "action", through: false, priority: "same", commands: [cmd("plugin:fishing/Cast", { spot: i.spot })] }] }),
  });

  const album = defineEventTemplate({
    id: "album",
    label: "つり手帳（図鑑）",
    description: "話しかけると、釣った魚の一覧を開く。",
    input: z.strictObject({ name: z.string().meta({ title: "イベント名", initial: "魚拓の板" }) }),
    build: (i) => ({ name: i.name, pages: [{ conditions: [], trigger: "action", through: false, priority: "same", commands: [cmd("plugin:fishing/Album", {})] }] }),
  });

  const controller = defineEventTemplate({
    id: "controller",
    label: "大会の進行役",
    description: "大会を開くマップに 1 つだけ置く。制限時間を見張り、時間が来たら、セリフを出して結果を発表する。",
    input: z.strictObject({
      name: z.string().meta({ title: "イベント名", initial: "大会の進行役" }),
      bell: z.string().meta({ title: "時間が来たときのセリフ", multiline: true, initial: "カーン　カーン　カーン！\n\n終了の鐘が 鳴った。釣りは そこまで！" }),
      after: z.string().meta({ title: "発表のあとのセリフ", multiline: true, initial: "大会は 終わった。" }),
    }),
    build(i, project) {
      const v = eventVarOf(project.system.plugins.find((p) => p.name === "fishing")?.params);
      return {
        name: i.name,
        pages: [
          { conditions: [], trigger: "parallel", through: true, priority: "below", commands: [cmd("plugin:fishing/Watch", {})] },
          {
            conditions: [{ kind: "variable", id: v, op: "==", value: 1 }],
            trigger: "autorun",
            through: true,
            priority: "below",
            commands: [...texts(i.bell), cmd("plugin:fishing/Result", {}), ...texts(i.after)],
          },
        ],
      } as EventDraft;
    },
  });
  return [spot, album, controller];
}

const FISHING_COMMANDS = "plugin:fishing/";

/** エディタの診断：設定・データベースの参照・釣り場の種類・進行役の有無を調べる。 */
export function fishingDiagnostics(doc: PluginDocument): Diagnostic[] {
  const ref = doc.project.system.plugins.find((p) => p.name === "fishing");
  if (ref === undefined) return [];
  const parsed = parseConfig(ref.params);
  if (!parsed.ok) return [{ severity: "error", code: "fishingConfig", message: parsed.message }];
  const cfg = parsed.config;
  const out: Diagnostic[] = [];
  const db = doc.project.database;
  const item = (id: string, what: string): void => {
    if (!Object.hasOwn(db.items, id)) out.push({ severity: "error", code: "fishingItem", message: `釣り：${what} のアイテム ${id} がデータベースに無い` });
  };
  for (const f of cfg.fish) item(f.item, `魚 ${f.key}`);
  for (const r of cfg.rods) item(r.item, `竿 ${r.name}`);
  for (const b of cfg.baits) item(b.item, `エサ ${b.name}`);
  if (cfg.tournament.trophy !== undefined) item(cfg.tournament.trophy, "トロフィー");

  const spots = new Set(cfg.fish.flatMap((f) => f.spots));
  const used = new Set<string>();
  let watch = false;
  let start = false;
  for (const map of Object.values(doc.maps)) {
    for (const ev of Object.values(map.events)) {
      for (const page of ev.pages) {
        for (const c of page.commands) {
          if (c.code === `${FISHING_COMMANDS}Cast`) {
            const s = (c.params as { spot?: unknown }).spot;
            if (typeof s === "string") {
              used.add(s);
              if (!spots.has(s)) out.push({ severity: "warning", code: "fishingSpot", message: `釣り場の種類 ${s} で釣れる魚が、設定の fish に無い（マップ ${map.id}・イベント ${ev.id}）` });
            }
          }
          if (c.code === `${FISHING_COMMANDS}Watch`) watch = true;
          if (c.code === `${FISHING_COMMANDS}Start`) start = true;
        }
      }
    }
  }
  if (start && !watch) out.push({ severity: "warning", code: "fishingNoController", message: "plugin:fishing/Start で大会を始めているのに、plugin:fishing/Watch を呼ぶイベント（大会の進行役）がどのマップにも無い。時間が来ても終わらない" });
  return out;
}
