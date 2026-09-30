import { collectRefs, findDanglingRefs } from "@rpg/schema";
import type { CommandRefResolver, EventCommand, MapData, MapId, Project, Ref, RefKind, RefTarget } from "@rpg/schema";
import type { CommandRegistry } from "@rpg/core";
import type { ProjectDocument } from "@rpg/project-store";
import type { Diagnostic, Impact } from "./errors.js";

const KIND_LABEL: Record<RefKind, string> = {
  actor: "アクター",
  class: "職業",
  skill: "スキル",
  item: "アイテム",
  enemy: "敵",
  troop: "敵グループ",
  map: "マップ",
  commonEvent: "コモンイベント",
  state: "ステート",
  asset: "アセット",
  switch: "スイッチ",
  variable: "変数",
  tileset: "タイルセット",
};

export const kindLabel = (kind: RefKind): string => KIND_LABEL[kind];

/** コマンドの参照先を、レジストリの `meta.refs` から得る。未登録・パラメータ不正のコマンドは参照なしとして扱う。 */
export function commandRefResolver(registry: CommandRegistry): CommandRefResolver {
  return (c: EventCommand): RefTarget[] => {
    const handler = registry.get(c.code);
    if (handler === undefined) return [];
    const parsed = handler.params.safeParse(c.params);
    return parsed.success ? handler.meta.refs(parsed.data) : [];
  };
}

/** `map:m1/event:e1/page:0/command:2` を人が読める形にする。 */
export function describeFrom(from: string, doc: ProjectDocument): string {
  const parts = from.split("/");
  const out: string[] = [];
  for (const part of parts) {
    const [key, value = ""] = [part.slice(0, part.indexOf(":")), part.slice(part.indexOf(":") + 1)];
    if (part.startsWith("map:")) out.push(`マップ「${doc.project.maps[value as MapId]?.name ?? value}」`);
    else if (key === "event") {
      const mapId = parts[0]?.startsWith("map:") ? (parts[0].slice(4) as MapId) : undefined;
      const event = mapId === undefined ? undefined : doc.maps[mapId]?.events[value as never];
      out.push(`イベント「${event?.name ?? value}」`);
    } else if (key === "page") out.push(`ページ${Number(value) + 1}`);
    else if (key === "command") out.push(`コマンド${Number(value) + 1}`);
    else out.push(part);
  }
  return out.join(" ");
}

/** `target` を参照しているもの（削除前の影響範囲）。 */
export function impactOf(doc: ProjectDocument, resolve: CommandRefResolver, target: RefTarget): Impact[] {
  return collectRefs(doc.project, doc.maps, resolve)
    .filter((r) => r.to.kind === target.kind && r.to.id === target.id)
    .map((r) => ({ from: r.from, description: `${describeFrom(r.from, doc)} が使っている` }));
}

function locationOf(from: string): NonNullable<Diagnostic["location"]> {
  const location: NonNullable<Diagnostic["location"]> = {};
  const map = /^map:([^/]+)/.exec(from)?.[1];
  const event = /event:([^/]+)/.exec(from)?.[1];
  const page = /page:(\d+)/.exec(from)?.[1];
  const command = /command:(\d+)/.exec(from)?.[1];
  if (map !== undefined) location.mapId = map;
  if (event !== undefined) location.eventId = event;
  if (page !== undefined) location.page = Number(page);
  if (command !== undefined) location.commandIndex = Number(command);
  return location;
}

/** プロジェクト内のすべてのコマンド列（場所つき）。 */
function* allCommands(project: Project, maps: Record<MapId, MapData>): Generator<{ from: string; commands: readonly EventCommand[] }> {
  for (const map of Object.values(maps)) {
    for (const ev of Object.values(map.events)) {
      for (const [i, page] of ev.pages.entries()) yield { from: `map:${map.id}/event:${ev.id}/page:${i}`, commands: page.commands };
    }
  }
  for (const t of Object.values(project.database.troops)) {
    for (const [i, page] of t.pages.entries()) yield { from: `database.troops.${t.id}/page:${i}`, commands: page.commands };
  }
  for (const ce of Object.values(project.database.commonEvents)) yield { from: `database.commonEvents.${ce.id}`, commands: ce.commands };
}

/**
 * 整合性チェック。参照切れ・不明なコマンド・不正なパラメータ・開始位置はエラー、未使用アセットなどは警告。
 * エディタのコマンド（force なし）で作れる文書は、エラーを含まない。
 */
export function validateDoc(doc: ProjectDocument, registry: CommandRegistry): Diagnostic[] {
  const { project, maps } = doc;
  const resolve = commandRefResolver(registry);
  const out: Diagnostic[] = [];

  const dangling = findDanglingRefs(project, maps, resolve);
  if (dangling.length > 0) {
    const key = (t: RefTarget): string => `${t.kind}:${t.id}`;
    const missing = new Set(dangling.map(key));
    for (const ref of collectRefs(project, maps, resolve)) {
      if (!missing.has(key(ref.to))) continue;
      out.push({
        severity: "error",
        code: "danglingRef",
        message: `${describeFrom(ref.from, doc)} が、存在しない${kindLabel(ref.to.kind)} ${ref.to.id} を参照している`,
        target: ref.to,
        location: locationOf(ref.from),
      });
    }
  }

  for (const { from, commands } of allCommands(project, maps)) {
    commands.forEach((c, i) => {
      const where = { ...locationOf(from), commandIndex: i };
      if (registry.get(c.code) === undefined) {
        const isPlugin = c.code.startsWith("plugin:");
        out.push({
          severity: isPlugin ? "warning" : "error",
          code: isPlugin ? "pluginCommand" : "unknownCommand",
          message: `${describeFrom(`${from}/command:${i}`, doc)}：${isPlugin ? "プラグインのコマンド" : "未知のコマンド"} ${c.code}`,
          location: where,
        });
        return;
      }
      const checked = registry.validate(c);
      if (!checked.ok && checked.error.kind === "invalidParams") {
        out.push({
          severity: "error",
          code: "invalidParams",
          message: `${describeFrom(`${from}/command:${i}`, doc)}：${c.code} の設定が不正（${checked.error.issues.map((x) => `${x.path} ${x.message}`).join("、")}）`,
          location: where,
        });
      }
    });
  }

  const start = maps[project.system.startMap];
  if (start !== undefined && (project.system.startX >= start.width || project.system.startY >= start.height)) {
    out.push({ severity: "error", code: "startOutOfMap", message: `開始位置 (${project.system.startX},${project.system.startY}) が開始マップの外`, target: { kind: "map", id: project.system.startMap } });
  }
  if (project.system.initialParty.length === 0) out.push({ severity: "warning", code: "noParty", message: "初期パーティが空" });

  const used = new Set<string>(collectRefs(project, maps, resolve).filter((r: Ref) => r.to.kind === "asset").map((r) => r.to.id));
  for (const [id, entry] of Object.entries(project.assets.entries)) {
    if (!used.has(id)) out.push({ severity: "warning", code: "unusedAsset", message: `アセット ${entry.name}（${id}）はどこからも使われていない`, target: { kind: "asset", id } });
  }
  return out;
}
