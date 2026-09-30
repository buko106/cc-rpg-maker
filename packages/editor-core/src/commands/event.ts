import { mapEventSchema, newId } from "@rpg/schema";
import type { EventCommand, EventId, EventPage, MapData, MapEvent, MapId } from "@rpg/schema";
import type { ProjectDocument } from "@rpg/project-store";
import type { Result } from "@rpg/schema";
import { defineEdit, err, invalid, mapOf, notFound, ok, withEntry, withMap } from "../command.js";
import type { EditorCommand } from "../command.js";
import type { EditError } from "../errors.js";
import type { EventTemplate } from "../templates.js";

/** 新しいイベントページの既定。 */
export const defaultPage = (): EventPage => ({ conditions: [], trigger: "action", through: false, priority: "same", commands: [] });

/** 新しい EventCommand（`indent` は 0）。 */
export const eventCommand = (code: string, params: Record<string, unknown> = {}, indent = 0): EventCommand => ({ code, params, indent });

const eventOf = (map: MapData, id: EventId): MapEvent | undefined => (Object.hasOwn(map.events, id) ? map.events[id] : undefined);

const withEvent = (doc: ProjectDocument, map: MapData, event: MapEvent): ProjectDocument => withMap(doc, { ...map, events: { ...map.events, [event.id]: event } });

const inMap = (map: MapData, x: number, y: number): boolean => Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < map.width && y < map.height;

/** マップとイベントを取り出す。 */
function locate(doc: ProjectDocument, mapId: MapId, eventId: EventId): Result<{ map: MapData; event: MapEvent }, EditError> {
  const map = mapOf(doc, mapId);
  if (map === undefined) return err(notFound("マップ", mapId));
  const event = eventOf(map, eventId);
  return event === undefined ? err(notFound("イベント", eventId)) : ok({ map, event });
}

/** ページを取り出して `f` で作り替える。 */
function editPage(
  doc: ProjectDocument,
  mapId: MapId,
  eventId: EventId,
  pageIndex: number,
  f: (page: EventPage) => Result<EventPage, EditError>,
): Result<ProjectDocument, EditError> {
  const at = locate(doc, mapId, eventId);
  if (!at.ok) return at;
  const page = Number.isInteger(pageIndex) ? at.value.event.pages[pageIndex] : undefined;
  if (page === undefined) return err(notFound("ページ", String(pageIndex)));
  const next = f(page);
  if (!next.ok) return next;
  const pages = at.value.event.pages.map((p, i) => (i === pageIndex ? next.value : p));
  return ok(withEvent(doc, at.value.map, { ...at.value.event, pages }));
}

/** マップ上の `(x, y)` に、ページ 1 つの新しいイベントを置く。ID は省略すると新しく採番する。 */
export function createEvent(mapId: MapId, x: number, y: number, id: EventId = newId<"EventId">("ev")): EditorCommand {
  return defineEdit({
    kind: "createEvent",
    label: "イベントの作成",
    maps: [mapId],
    apply(doc) {
      const map = mapOf(doc, mapId);
      if (map === undefined) return err(notFound("マップ", mapId));
      if (!inMap(map, x, y)) return err(invalid(`(${x},${y}) はマップ ${mapId} の外`));
      if (eventOf(map, id) !== undefined) return err({ kind: "duplicate", message: `イベント ${id} は既にある` });
      const n = Object.keys(map.events).length + 1;
      return ok(withEvent(doc, map, { id, name: `EV${String(n).padStart(3, "0")}`, x, y, pages: [defaultPage()] }));
    },
  });
}

/**
 * ひな形（`template`）に入力（`input`）を渡して作ったイベントを、マップ上の `(x, y)` に置く。1 回の Undo で消える。
 * 入力は `template.input` で検証し、作られたイベントも `mapEventSchema` で検証する（プラグインのひな形の誤りで文書を壊さない）。
 * そのセルに既にイベントがあるときは置かない。
 */
export function createEventFromTemplate(mapId: MapId, x: number, y: number, template: EventTemplate, input: unknown, id: EventId = newId<"EventId">("ev")): EditorCommand {
  return defineEdit({
    kind: "createEventFromTemplate",
    label: `イベントの作成（${template.label}）`,
    maps: [mapId],
    apply(doc) {
      const map = mapOf(doc, mapId);
      if (map === undefined) return err(notFound("マップ", mapId));
      if (!inMap(map, x, y)) return err(invalid(`(${x},${y}) はマップ ${mapId} の外`));
      if (eventOf(map, id) !== undefined) return err({ kind: "duplicate", message: `イベント ${id} は既にある` });
      const there = Object.values(map.events).find((e) => e.x === x && e.y === y);
      if (there !== undefined) return err({ kind: "duplicate", message: `(${x},${y}) には既にイベント「${there.name}」がある` });
      const parsed = template.input.safeParse(input);
      if (!parsed.success) return err(invalid(`ひな形「${template.label}」の入力が正しくない：${parsed.error.issues.map((i) => i.message).join("、")}`));
      let built: ReturnType<EventTemplate["build"]>;
      try {
        built = template.build(parsed.data, doc.project);
      } catch (e) {
        return err(invalid(`ひな形「${template.label}」でイベントを作れなかった：${e instanceof Error ? e.message : String(e)}`));
      }
      const event = mapEventSchema.safeParse({ id, name: built.name, x, y, pages: built.pages });
      if (!event.success || event.data.pages.length === 0) {
        return err(invalid(`ひな形「${template.label}」が作ったイベントが正しくない：${event.success ? "ページが無い" : event.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("、")}`));
      }
      return ok(withEvent(doc, map, event.data));
    },
  });
}

/**
 * コピーしておいたイベント（`source`）を `(x, y)` に貼り付ける。ページの中身は JSON として複製し、ID は新しく採番する（名前はそのまま）。
 * 別のマップにも貼れる。そのセルに既にイベントがあるときは貼らない（重なるとクリックで選べなくなる）。
 * `source` は文書の外のスナップショットなので、元のイベントを後から編集・削除しても影響しない。
 */
export function pasteEvent(mapId: MapId, source: MapEvent, x: number, y: number, id: EventId = newId<"EventId">("ev")): EditorCommand {
  return defineEdit({
    kind: "pasteEvent",
    label: "イベントの貼り付け",
    maps: [mapId],
    apply(doc) {
      const map = mapOf(doc, mapId);
      if (map === undefined) return err(notFound("マップ", mapId));
      if (!inMap(map, x, y)) return err(invalid(`(${x},${y}) はマップ ${mapId} の外`));
      if (eventOf(map, id) !== undefined) return err({ kind: "duplicate", message: `イベント ${id} は既にある` });
      const there = Object.values(map.events).find((e) => e.x === x && e.y === y);
      if (there !== undefined) return err({ kind: "duplicate", message: `(${x},${y}) には既にイベント「${there.name}」がある` });
      return ok(withEvent(doc, map, { ...(JSON.parse(JSON.stringify(source)) as MapEvent), id, x, y }));
    },
  });
}

interface MoveEventCommand extends EditorCommand {
  readonly mapId: MapId;
  readonly eventId: EventId;
}

/** イベントを動かす。ドラッグ中の連続した移動は 1 つにまとまる。 */
export function moveEvent(mapId: MapId, eventId: EventId, x: number, y: number): EditorCommand {
  const base = defineEdit({
    kind: "moveEvent",
    label: "イベントの移動",
    maps: [mapId],
    apply(doc) {
      const at = locate(doc, mapId, eventId);
      if (!at.ok) return at;
      if (!inMap(at.value.map, x, y)) return err(invalid(`(${x},${y}) はマップ ${mapId} の外`));
      if (at.value.event.x === x && at.value.event.y === y) return ok(doc);
      return ok(withEvent(doc, at.value.map, { ...at.value.event, x, y }));
    },
    coalesce: (prev) => {
      const p = prev as MoveEventCommand;
      return prev.kind === "moveEvent" && p.mapId === mapId && p.eventId === eventId ? moveEvent(mapId, eventId, x, y) : undefined;
    },
  });
  return Object.assign(base, { mapId, eventId }) as MoveEventCommand;
}

export function deleteEvent(mapId: MapId, eventId: EventId): EditorCommand {
  return defineEdit({
    kind: "deleteEvent",
    label: "イベントの削除",
    maps: [mapId],
    apply(doc) {
      const at = locate(doc, mapId, eventId);
      if (!at.ok) return at;
      return ok(withMap(doc, { ...at.value.map, events: withEntry(at.value.map.events, eventId, undefined) }));
    },
  });
}

export function setEventName(mapId: MapId, eventId: EventId, name: string): EditorCommand {
  const base = defineEdit({
    kind: "setEventName",
    label: "イベント名の変更",
    maps: [mapId],
    apply(doc) {
      const at = locate(doc, mapId, eventId);
      if (!at.ok) return at;
      return ok(at.value.event.name === name ? doc : withEvent(doc, at.value.map, { ...at.value.event, name }));
    },
    coalesce: (prev) => {
      const p = prev as unknown as { mapId?: MapId; eventId?: EventId };
      return prev.kind === "setEventName" && p.mapId === mapId && p.eventId === eventId ? setEventName(mapId, eventId, name) : undefined;
    },
  });
  return tagged(base, { mapId, eventId });
}

/** ページを置き換える。`pageIndex` がページ数と等しければ末尾に追加する。 */
export function setEventPage(mapId: MapId, eventId: EventId, pageIndex: number, page: EventPage): EditorCommand {
  const base = defineEdit({
    kind: "setEventPage",
    label: "イベントページの変更",
    maps: [mapId],
    apply(doc) {
      const at = locate(doc, mapId, eventId);
      if (!at.ok) return at;
      const { pages } = at.value.event;
      if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex > pages.length) return err(invalid(`ページ ${pageIndex} は指定できない（0〜${pages.length}）`));
      const next = pageIndex === pages.length ? [...pages, page] : pages.map((p, i) => (i === pageIndex ? page : p));
      return ok(withEvent(doc, at.value.map, { ...at.value.event, pages: next }));
    },
    coalesce: (prev) => {
      const p = prev as unknown as { mapId?: MapId; eventId?: EventId; pageIndex?: number };
      return prev.kind === "setEventPage" && p.mapId === mapId && p.eventId === eventId && p.pageIndex === pageIndex && pageIndex >= 0
        ? setEventPage(mapId, eventId, pageIndex, page)
        : undefined;
    },
  });
  return tagged(base, { mapId, eventId, pageIndex });
}

/** ページを削除する。最後の 1 ページは消せない。 */
export function removeEventPage(mapId: MapId, eventId: EventId, pageIndex: number): EditorCommand {
  return defineEdit({
    kind: "removeEventPage",
    label: "イベントページの削除",
    maps: [mapId],
    apply(doc) {
      const at = locate(doc, mapId, eventId);
      if (!at.ok) return at;
      const { pages } = at.value.event;
      if (pages[pageIndex] === undefined) return err(notFound("ページ", String(pageIndex)));
      if (pages.length === 1) return err(invalid("最後のページは削除できない"));
      return ok(withEvent(doc, at.value.map, { ...at.value.event, pages: pages.filter((_, i) => i !== pageIndex) }));
    },
  });
}

/** コマンドの位置 `at` に `commands` を挿入する（`at` は 0〜長さ）。 */
export function insertCommands(mapId: MapId, eventId: EventId, pageIndex: number, at: number, commands: readonly EventCommand[]): EditorCommand {
  return defineEdit({
    kind: "insertCommands",
    label: "コマンドの挿入",
    maps: [mapId],
    apply: (doc) =>
      editPage(doc, mapId, eventId, pageIndex, (page) => {
        if (!Number.isInteger(at) || at < 0 || at > page.commands.length) return err(invalid(`挿入位置 ${at} は指定できない（0〜${page.commands.length}）`));
        return ok({ ...page, commands: [...page.commands.slice(0, at), ...commands, ...page.commands.slice(at)] });
      }),
  });
}

/** コマンドの位置 `at` から `count` 個を削除する。 */
export function removeCommands(mapId: MapId, eventId: EventId, pageIndex: number, at: number, count: number): EditorCommand {
  return defineEdit({
    kind: "removeCommands",
    label: "コマンドの削除",
    maps: [mapId],
    apply: (doc) =>
      editPage(doc, mapId, eventId, pageIndex, (page) => {
        if (!Number.isInteger(at) || !Number.isInteger(count) || at < 0 || count < 0 || at + count > page.commands.length) {
          return err(invalid(`削除範囲 ${at}+${count} は指定できない（コマンドは ${page.commands.length} 個）`));
        }
        return ok({ ...page, commands: [...page.commands.slice(0, at), ...page.commands.slice(at + count)] });
      }),
  });
}

/** 位置 `at` のコマンドを差し替える。同じ位置への連続した差し替え（入力中の文字など）は 1 つにまとまる。 */
export function replaceCommand(mapId: MapId, eventId: EventId, pageIndex: number, at: number, command: EventCommand): EditorCommand {
  const where = `${mapId}/${eventId}/${pageIndex}/${at}`;
  const make = (): EditorCommand =>
    tagged(defineEdit({
      kind: "replaceCommand",
      label: "コマンドの変更",
      maps: [mapId],
      apply: (doc) =>
        editPage(doc, mapId, eventId, pageIndex, (page) => {
          if (page.commands[at] === undefined) return err(notFound("コマンド", String(at)));
          return ok({ ...page, commands: page.commands.map((c, i) => (i === at ? command : c)) });
        }),
      coalesce: (prev) => {
        const p = prev as unknown as { where?: string };
        return prev.kind === "replaceCommand" && p.where === where ? make() : undefined;
      },
    }), { where });
  return make();
}

/** コマンド（の一部）に、まとめる判定用の目印を付ける。 */
function tagged<T extends EditorCommand>(c: T, tag: Record<string, unknown>): T {
  return Object.assign(c, tag);
}
