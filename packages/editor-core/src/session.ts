import { err, MapDataSchema, ok, ProjectSchema } from "@rpg/schema";
import type { AssetId, AssetEntry, MapData, MapId, Project, RefTarget, Result } from "@rpg/schema";
import type { CommandRegistry } from "@rpg/core";
import type { AssetKind, ProjectAssetStore, ProjectDocument, ProjectRepository, ProjectStoreError } from "@rpg/project-store";
import { batch } from "./command.js";
import { cmd } from "./commands/index.js";
import type { EditorCommand } from "./command.js";
import { commandRefResolver, impactOf as computeImpact, validateDoc } from "./diagnostics.js";
import type { Diagnostic, EditError, Impact } from "./errors.js";
import { initialUiState } from "./ui-state.js";
import type { EditorUiState } from "./ui-state.js";

/** Undo できる回数の上限。 */
export const UNDO_LIMIT = 200;
/** 同じ種類のコマンドを 1 回の Undo にまとめる時間（ms）。 */
export const COALESCE_MS = 500;

export type SaveStatus =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved"; revision: number }
  | { kind: "error"; error: ProjectStoreError }
  /** 別の場所で先に保存された。`save({ overwrite: true })` で上書きするか、開き直す。 */
  | { kind: "conflict"; currentRevision: number };

/** テストプレイ用に `runtime` へ渡せる `ProjectSource`（構造的に同じ形。editor-core は runtime に依存しない）。 */
export interface DocProjectSource {
  project(): Promise<Project>;
  mapData(id: MapId): Promise<MapData>;
  projectHash(): Promise<string>;
}

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface EditorSessionDeps {
  repo: ProjectRepository;
  doc: ProjectDocument;
  commands: CommandRegistry;
  /** 指定すると、編集の `debounceMs` 後に自動で保存する。 */
  autosave?: { debounceMs: number };
  /** プラグインなどによる追加の診断（`validate()` の結果に足される）。 */
  diagnostics?: readonly ((doc: ProjectDocument) => Diagnostic[])[];
  /** 現在時刻（Unix ms）。まとめ判定に使う。既定は `Date.now`。 */
  now?: () => number;
  /** タイマー。既定はグローバルの `setTimeout` / `clearTimeout`。 */
  timers?: Timers;
}

export interface EditorSession {
  readonly doc: ProjectDocument;
  readonly ui: EditorUiState;
  /** 未保存の編集がある */
  readonly dirty: boolean;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  /** 次の Undo / Redo で戻る操作の名前 */
  readonly undoLabel: string | undefined;
  readonly redoLabel: string | undefined;
  readonly saveStatus: SaveStatus;
  /** 何かが変わるたびに増える（UI が変化を検知するための値）。 */
  readonly version: number;

  /**
   * コマンドを実行する。`force` で「参照が残る削除」を許す。失敗しても文書は変わらない。
   * `groupWithNext` は「次の編集の下準備」：直後（`COALESCE_MS` 以内）に実行した編集と 1 回の Undo にまとめる
   * （例：フォームの中でスイッチを作り、そのまま選ぶ）。続く編集が無ければ単独の Undo になる。
   */
  execute(c: EditorCommand, opts?: ExecuteOptions): Result<void, EditError>;
  undo(): void;
  redo(): void;
  setUi(patch: Partial<EditorUiState>): void;
  subscribe(listener: (s: EditorSession) => void): () => void;

  validate(): Diagnostic[];
  /** `target` を参照しているもの（削除前の影響範囲）。 */
  impactOf(target: RefTarget): Impact[];
  /** 保存する。`overwrite` は競合していても上書きする。 */
  save(opts?: { overwrite?: boolean }): Promise<Result<void, ProjectStoreError>>;
  /** アセットのバイト列を保存してマニフェストに登録する（1 回の Undo で戻る）。 */
  importAsset(bytes: ArrayBuffer, name: string, kind: AssetKind): Promise<Result<{ id: AssetId; entry: AssetEntry }, EditError>>;
  assetStore(): ProjectAssetStore;
  /** 呼んだ時点の文書のスナップショットを返す `ProjectSource`（テストプレイ用）。 */
  projectSource(): DocProjectSource;
  /** 自動保存のタイマーを止める。 */
  dispose(): void;
}

export interface ExecuteOptions {
  force?: boolean;
  groupWithNext?: boolean;
}

interface HistoryEntry {
  command: EditorCommand;
  inverse: EditorCommand;
}

const globalTimers = (): Timers => {
  const g = globalThis as unknown as { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(h: unknown): void };
  return { set: (fn, ms) => g.setTimeout(fn, ms), clear: (h) => g.clearTimeout(h) };
};

/** 適用結果を軽量に検証する：書き換えた部分だけを zod で確かめる。 */
function lightValidate(next: ProjectDocument, c: EditorCommand): EditError | undefined {
  if (c.touchesProject()) {
    const r = ProjectSchema.safeParse(next.project);
    if (!r.success) return { kind: "schema", message: `プロジェクトの整合性が壊れる：${r.error.issues[0]?.message ?? ""}`, issues: r.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })) };
  }
  for (const id of c.touchedMaps()) {
    const map = Object.hasOwn(next.maps, id) ? next.maps[id] : undefined;
    if (map === undefined) continue; // 削除されたマップ
    const r = MapDataSchema.safeParse(map);
    if (!r.success) return { kind: "schema", message: `マップ ${id} の整合性が壊れる：${r.error.issues[0]?.message ?? ""}`, issues: r.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })) };
  }
  return undefined;
}

export function createEditorSession(deps: EditorSessionDeps): EditorSession {
  const now = deps.now ?? Date.now;
  const timers = deps.timers ?? globalTimers();
  const resolve = commandRefResolver(deps.commands);

  let doc = deps.doc;
  let ui = initialUiState(doc);
  let version = 0;
  let status: SaveStatus = { kind: "idle" };
  const undoStack: HistoryEntry[] = [];
  let redoStack: HistoryEntry[] = [];
  /** 直前の `execute` が積んだエントリと時刻（Undo / Redo / 他の操作でまとめの対象から外れる）。 */
  let last: { entry: HistoryEntry; at: number } | undefined;
  /** `groupWithNext` で積んだエントリと時刻。次の `execute` をこれにまとめる（Undo / Redo で外れる）。 */
  let opening: { entry: HistoryEntry; at: number } | undefined;

  // 保存管理：編集ごとに増える連番と、マップごとの最後に触った連番
  let editSeq = 0;
  let savedSeq = 0;
  let projectSeq = 0;
  const mapSeq = new Map<MapId, number>();
  let saveQueue: Promise<unknown> = Promise.resolve();
  let autosaveHandle: unknown;
  const listeners = new Set<(s: EditorSession) => void>();

  const notify = (): void => {
    version++;
    for (const l of [...listeners]) l(session);
  };

  const touch = (c: EditorCommand): void => {
    editSeq++;
    if (c.touchesProject()) projectSeq = editSeq;
    for (const id of c.touchedMaps()) mapSeq.set(id, editSeq);
    scheduleAutosave();
  };

  function scheduleAutosave(): void {
    if (deps.autosave === undefined) return;
    if (autosaveHandle !== undefined) timers.clear(autosaveHandle);
    if (status.kind === "conflict") return;
    autosaveHandle = timers.set(() => {
      autosaveHandle = undefined;
      void session.save();
    }, deps.autosave.debounceMs);
  }

  /** 新しい ui に、開けなくなったマップ・イベントの選択を合わせる。 */
  const reconcileUi = (): void => {
    if (ui.currentMap !== undefined && !Object.hasOwn(doc.project.maps, ui.currentMap)) {
      ui = { ...ui, currentMap: Object.keys(doc.project.maps)[0] as MapId | undefined, selection: { kind: "none" } };
    }
    if (ui.selection.kind === "event") {
      const map = ui.currentMap === undefined ? undefined : doc.maps[ui.currentMap];
      if (map === undefined || !Object.hasOwn(map.events, ui.selection.eventId)) ui = { ...ui, selection: { kind: "none" } };
    }
    const layers = ui.currentMap === undefined ? undefined : doc.maps[ui.currentMap]?.layers.length;
    if (layers !== undefined && ui.currentLayer >= layers) ui = { ...ui, currentLayer: layers - 1 };
  };

  function execute(c: EditorCommand, opts: ExecuteOptions = {}): Result<void, EditError> {
    const applied = c.apply(doc);
    if (!applied.ok) return applied;
    const next = applied.value;
    if (next === doc) return ok(undefined); // 何も変わらない
    const invalid = lightValidate(next, c);
    if (invalid !== undefined) return err(invalid);
    if (opts.force !== true) {
      const references = c.removes().flatMap((t) => computeImpact(next, resolve, t));
      if (references.length > 0) {
        return err({ kind: "hasReferences", message: `まだ使われているので削除できない（${references.length} 件）`, references });
      }
    }

    const at = now();
    const group = opening !== undefined && opening.entry === last?.entry && at - opening.at <= COALESCE_MS ? opening.entry : undefined;
    opening = undefined;
    // 下準備そのものは前の編集にまとめない（まとめると、前の編集まで一緒に戻ってしまう）
    const merged = group === undefined && opts.groupWithNext !== true && last !== undefined && at - last.at <= COALESCE_MS ? c.coalesce?.(last.entry.command) : undefined;
    if (group !== undefined) {
      // 下準備の編集と 1 つに：やり直しは順に、元に戻すは逆順に
      group.inverse = batch(c.label, [c.invert(doc, next), group.inverse]);
      group.command = batch(c.label, [group.command, c]);
      last = { entry: group, at };
    } else if (merged !== undefined && last !== undefined) {
      last.entry.command = merged;
      last.at = at;
    } else {
      const entry: HistoryEntry = { command: c, inverse: c.invert(doc, next) };
      undoStack.push(entry);
      if (undoStack.length > UNDO_LIMIT) undoStack.shift();
      last = { entry, at };
    }
    if (opts.groupWithNext === true && last !== undefined) opening = { entry: last.entry, at };
    redoStack = [];
    doc = next;
    reconcileUi();
    touch(c);
    if (status.kind === "saved" || status.kind === "error") status = { kind: "idle" };
    notify();
    return ok(undefined);
  }

  function step(from: HistoryEntry[], to: HistoryEntry[], pick: (e: HistoryEntry) => EditorCommand, opposite: (e: HistoryEntry) => EditorCommand): void {
    const entry = from.pop();
    if (entry === undefined) return;
    const c = pick(entry);
    const applied = c.apply(doc);
    if (!applied.ok) {
      from.push(entry); // 起きないはず（履歴は直線）だが、壊れたら元に戻す
      return;
    }
    doc = applied.value;
    to.push(entry);
    last = undefined;
    opening = undefined;
    reconcileUi();
    touch(opposite(entry));
    notify();
  }

  function save(opts: { overwrite?: boolean } = {}): Promise<Result<void, ProjectStoreError>> {
    const run = async (): Promise<Result<void, ProjectStoreError>> => {
      if (editSeq === savedSeq && opts.overwrite !== true && status.kind !== "error") return ok(undefined);
      const snapshot = doc;
      const seq = editSeq;
      const maps = [...mapSeq.keys()];
      status = { kind: "saving" };
      notify();
      const r = await deps.repo.save(snapshot, {
        changedMaps: maps,
        ...(opts.overwrite === true ? {} : { expectedRevision: snapshot.revision }),
      });
      if (!r.ok) {
        status = r.error.kind === "conflict" ? { kind: "conflict", currentRevision: r.error.currentRevision } : { kind: "error", error: r.error };
        notify();
        return r;
      }
      savedSeq = seq;
      for (const [id, s] of mapSeq) if (s <= seq) mapSeq.delete(id);
      if (projectSeq <= seq) projectSeq = 0;
      doc = { ...doc, revision: r.value.revision };
      status = { kind: "saved", revision: r.value.revision };
      notify();
      return ok(undefined);
    };
    const result = saveQueue.then(run, run);
    saveQueue = result.catch(() => undefined);
    return result;
  }

  const session: EditorSession = {
    get doc() {
      return doc;
    },
    get ui() {
      return ui;
    },
    get dirty() {
      return editSeq > savedSeq;
    },
    get canUndo() {
      return undoStack.length > 0;
    },
    get canRedo() {
      return redoStack.length > 0;
    },
    get undoLabel() {
      return undoStack[undoStack.length - 1]?.command.label;
    },
    get redoLabel() {
      return redoStack[redoStack.length - 1]?.command.label;
    },
    get saveStatus() {
      return status;
    },
    get version() {
      return version;
    },
    execute,
    undo: () => step(undoStack, redoStack, (e) => e.inverse, (e) => e.command),
    redo: () => step(redoStack, undoStack, (e) => e.command, (e) => e.inverse),
    setUi(patch) {
      ui = { ...ui, ...patch };
      reconcileUi();
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    validate: () => validateDoc(doc, deps.commands, deps.diagnostics),
    impactOf: (target) => computeImpact(doc, resolve, target),
    save,
    async importAsset(bytes, name, kind) {
      const put = await deps.repo.assets(doc.project.meta.id).put(bytes, name, kind);
      const r = execute(cmd.registerAsset(put.id, put.entry));
      return r.ok ? ok(put) : r;
    },
    assetStore: () => deps.repo.assets(doc.project.meta.id),
    projectSource() {
      const snapshot = doc;
      const stamp = `edit-${snapshot.project.meta.id}-${version}`;
      return {
        project: () => Promise.resolve(snapshot.project),
        projectHash: () => Promise.resolve(stamp),
        mapData(id) {
          const map = Object.hasOwn(snapshot.maps, id) ? snapshot.maps[id] : undefined;
          return map === undefined ? Promise.reject(new Error(`マップ ${id} はプロジェクトに無い`)) : Promise.resolve(map);
        },
      };
    },
    dispose() {
      if (autosaveHandle !== undefined) timers.clear(autosaveHandle);
      autosaveHandle = undefined;
    },
  };
  return session;
}
