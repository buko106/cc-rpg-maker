import { createCommandRegistry, registerBuiltins } from "@rpg/core";
import { createMemoryProjectRepository } from "@rpg/project-store";
import type { ProjectDocument, ProjectRepository } from "@rpg/project-store";
import type { EventId, MapId } from "@rpg/schema";
import { editorCommandArb } from "@rpg/test-utils";
import fc from "fast-check";
import { beforeEach, describe, expect, it } from "vitest";
import { cmd, eventCommand } from "./commands/index.js";
import { COALESCE_MS, createEditorSession, UNDO_LIMIT } from "./session.js";
import type { EditorSession, Timers } from "./session.js";

const M1 = "map_001" as MapId;
const registry = createCommandRegistry();
registerBuiltins(registry);

/** 呼ぶたびに 1 秒進む時計（何もしなければ「まとめ」が起きない）。 */
const slowClock = (): (() => number) => {
  let t = 0;
  return () => (t += 1000);
};

/** 手で進められるタイマー。 */
function manualTimers(): Timers & { fire(): void; pending(): number; delays: number[] } {
  let next = 1;
  const timers = new Map<number, () => void>();
  const delays: number[] = [];
  return {
    set(fn, ms) {
      const h = next++;
      timers.set(h, fn);
      delays.push(ms);
      return h;
    },
    clear: (h) => void timers.delete(h as number),
    fire() {
      const all = [...timers.values()];
      timers.clear();
      for (const fn of all) fn();
    },
    pending: () => timers.size,
    delays,
  };
}

let repo: ProjectRepository;
let doc: ProjectDocument;
const open = (extra: Partial<Parameters<typeof createEditorSession>[0]> = {}): EditorSession => createEditorSession({ repo, doc, commands: registry, now: slowClock(), ...extra });

beforeEach(async () => {
  repo = createMemoryProjectRepository();
  doc = await repo.create("t");
});

describe("execute / undo / redo", () => {
  it("[inv-1,2] execute → undo で元の文書、redo で execute 直後の文書に戻る", () => {
    const s = open();
    const before = s.doc;
    expect(s.canUndo).toBe(false);
    expect(s.execute(cmd.paintTiles(M1, 0, [{ x: 1, y: 1, tile: 4 }])).ok).toBe(true);
    const after = s.doc;
    expect(after).not.toEqual(before);
    expect([s.canUndo, s.canRedo, s.undoLabel]).toEqual([true, false, "タイルを描く"]);
    s.undo();
    expect(s.doc).toEqual(before);
    expect([s.canUndo, s.canRedo, s.redoLabel]).toEqual([false, true, "タイルを描く"]);
    s.redo();
    expect(s.doc).toEqual(after);
  });

  it("新しい操作をすると redo は捨てられる。空の undo / redo は何もしない", () => {
    const s = open();
    s.undo();
    s.redo();
    s.execute(cmd.paintTiles(M1, 0, [{ x: 0, y: 0, tile: 2 }]));
    s.undo();
    s.execute(cmd.paintTiles(M1, 0, [{ x: 0, y: 0, tile: 3 }]));
    expect(s.canRedo).toBe(false);
  });

  it("[inv-3] 失敗した execute は文書も履歴も変えない", () => {
    const s = open();
    const before = s.doc;
    const r = s.execute(cmd.paintTiles(M1, 0, [{ x: 99, y: 0, tile: 2 }]));
    expect(!r.ok && r.error.kind).toBe("invalid");
    expect(s.doc).toBe(before);
    expect([s.canUndo, s.dirty]).toEqual([false, false]);
  });

  it("何も変わらないコマンドは履歴に積まれず dirty にもならない", () => {
    const s = open();
    expect(s.execute(cmd.paintTiles(M1, 0, [{ x: 0, y: 0, tile: 1 }])).ok).toBe(true);
    expect([s.canUndo, s.dirty]).toEqual([false, false]);
  });

  it("[inv-5] batch は 1 回の undo で全部戻る", () => {
    const s = open();
    const before = s.doc;
    s.execute(cmd.batch("まとめ", [cmd.createEvent(M1, 1, 1, "ev_a" as EventId), cmd.paintTiles(M1, 0, [{ x: 0, y: 0, tile: 3 }])]));
    s.undo();
    expect(s.doc).toEqual(before);
  });

  it("スキーマを壊す結果は軽量検証で弾かれる（文書は変わらない）", () => {
    const s = open();
    const before = s.doc;
    const r = s.execute(cmd.setSystem({ tileSize: 7 as never }));
    expect(!r.ok && r.error.kind).toBe("schema");
    expect(s.doc).toBe(before);
    const bad = s.execute(cmd.upsertTileset({ id: "ts_default", name: "x", passage: [], image: { asset: "zz" as never } } as never));
    expect(!bad.ok && bad.error.kind).toBe("schema");
  });

  it("履歴は UNDO_LIMIT 件まで", () => {
    const s = open();
    for (let i = 0; i < UNDO_LIMIT + 5; i++) s.execute(cmd.setSwitchName(`sw_${i}` as never, "x"));
    let undone = 0;
    while (s.canUndo) {
      s.undo();
      undone++;
    }
    expect(undone).toBe(UNDO_LIMIT);
  });

  it("undo / redo で開けなくなったマップ・イベントの選択は外れる", () => {
    const s = open();
    s.execute(cmd.createMap({ name: "2", order: 1 }, {}, "map_2" as MapId));
    s.setUi({ currentMap: "map_2" as MapId, currentLayer: 1 });
    expect(s.ui.currentMap).toBe("map_2");
    s.undo(); // map_2 が消える
    expect(s.ui.currentMap).toBe(M1);
    s.execute(cmd.createEvent(M1, 1, 1, "ev_a" as EventId));
    s.setUi({ selection: { kind: "event", eventId: "ev_a" as EventId } });
    s.undo();
    expect(s.ui.selection).toEqual({ kind: "none" });
  });

  it("subscribe：変更のたびに通知され、解除できる。version が増える", () => {
    const s = open();
    const seen: number[] = [];
    const off = s.subscribe((x) => seen.push(x.version));
    s.execute(cmd.setSwitchName("a" as never, "x"));
    s.setUi({ zoom: 2 });
    off();
    s.undo();
    expect(seen).toEqual([1, 2]);
    expect(s.version).toBe(3);
  });
});

describe("coalesce", () => {
  it("500ms 以内の連続した paintTiles は 1 回の undo にまとまる", () => {
    let t = 0;
    const s = createEditorSession({ repo, doc, commands: registry, now: () => t });
    const before = s.doc;
    for (let i = 0; i < 5; i++) {
      t += 100;
      s.execute(cmd.paintTiles(M1, 0, [{ x: i, y: 0, tile: 3 }]));
    }
    s.undo();
    expect(s.doc).toEqual(before);
    expect(s.canUndo).toBe(false);
    s.redo();
    expect(Array.from(s.doc.maps[M1]!.layers[0]!.tiles.slice(0, 6))).toEqual([3, 3, 3, 3, 3, 1]);
  });

  it("間が空けばまとまらない。別の種類・undo をはさんでもまとまらない", () => {
    let t = 0;
    const s = createEditorSession({ repo, doc, commands: registry, now: () => t });
    s.execute(cmd.paintTiles(M1, 0, [{ x: 0, y: 0, tile: 3 }]));
    t += COALESCE_MS + 1;
    s.execute(cmd.paintTiles(M1, 0, [{ x: 1, y: 0, tile: 3 }]));
    s.undo();
    expect(Array.from(s.doc.maps[M1]!.layers[0]!.tiles.slice(0, 2))).toEqual([3, 1]);

    s.execute(cmd.paintTiles(M1, 0, [{ x: 2, y: 0, tile: 4 }])); // undo の直後はまとめない
    s.execute(cmd.fillTiles(M1, 1, 0, 0, 2));
    s.undo();
    expect(Array.from(s.doc.maps[M1]!.layers[0]!.tiles.slice(0, 3))).toEqual([3, 1, 4]);
  });
});

describe("削除と参照", () => {
  const withActorUse = (s: EditorSession): void => {
    // 初期パーティがアクターを参照している
    expect(s.impactOf({ kind: "actor", id: "actor_001" })).toEqual([{ from: "system.initialParty", description: "system.initialParty が使っている" }]);
  };

  it("参照が残る削除は hasReferences。force なら実行でき、validate がエラーを返す", () => {
    const s = open();
    withActorUse(s);
    const r = s.execute(cmd.deleteEntity("actors", "actor_001"));
    expect(!r.ok && r.error.kind === "hasReferences" && r.error.references).toHaveLength(1);
    expect(s.doc.project.database.actors).toHaveProperty("actor_001");

    expect(s.execute(cmd.deleteEntity("actors", "actor_001"), { force: true }).ok).toBe(true);
    const errors = s.validate().filter((d) => d.severity === "error");
    expect(errors).toMatchObject([{ code: "danglingRef", target: { kind: "actor", id: "actor_001" } }]);
    s.undo();
    expect(s.validate().filter((d) => d.severity === "error")).toEqual([]);
  });

  it("イベントのコマンドが参照するスイッチ・マップも影響範囲に出る", () => {
    const s = open();
    s.execute(cmd.setSwitchName("sw_door" as never, "扉"));
    s.execute(cmd.createMap({ name: "2", order: 1 }, {}, "map_2" as MapId));
    s.execute(cmd.createEvent(M1, 2, 2, "ev_a" as EventId));
    s.execute(cmd.insertCommands(M1, "ev_a" as EventId, 0, 0, [eventCommand("ControlSwitches", { ids: ["sw_door"], value: true }), eventCommand("TransferPlayer", { mapId: "map_2", x: 1, y: 1 })]));
    const sw = s.impactOf({ kind: "switch", id: "sw_door" });
    expect(sw).toEqual([{ from: "map:map_001/event:ev_a/page:0/command:0", description: "マップ「MAP001」 イベント「EV001」 ページ1 コマンド1 が使っている" }]);
    expect(s.impactOf({ kind: "map", id: "map_2" })).toHaveLength(1);
    const r = s.execute(cmd.removeSwitch("sw_door" as never));
    expect(!r.ok && r.error.kind).toBe("hasReferences");
    // 参照元のイベントと一緒に削除するなら OK（適用後に参照が残らない）
    expect(s.execute(cmd.batch("消す", [cmd.deleteEvent(M1, "ev_a" as EventId), cmd.removeSwitch("sw_door" as never)])).ok).toBe(true);
  });

  it("開始マップ・使用中のタイルセット・使用中のアセットは削除できない", () => {
    const s = open();
    expect(s.execute(cmd.deleteMap(M1)).ok).toBe(false);
    expect(s.execute(cmd.deleteTileset("ts_default" as never)).ok).toBe(false);
    const asset = Object.keys(s.doc.project.assets.entries)[0] as never;
    expect(s.execute(cmd.unregisterAsset(asset)).ok).toBe(false);
  });
});

describe("validate", () => {
  it("新規プロジェクトはエラーなし。不明なコマンドと不正なパラメータ、開始位置、未使用アセットを報告する", () => {
    const s = open();
    expect(s.validate().filter((d) => d.severity === "error")).toEqual([]);
    s.execute(cmd.createEvent(M1, 2, 2, "ev_a" as EventId));
    s.execute(
      cmd.insertCommands(M1, "ev_a" as EventId, 0, 0, [eventCommand("Nope"), eventCommand("Wait", { frames: -1 }), eventCommand("plugin:demo/X"), eventCommand("ShowText", { text: "ok" })]),
    );
    s.execute(cmd.registerAsset("aaaaaaaaaaaaaaaa" as never, { name: "unused.png", kind: "image", mime: "image/png", size: 1 }));
    s.execute(cmd.setSystem({ initialParty: [] }));
    const found = s.validate();
    expect(found.map((d) => `${d.severity}:${d.code}`).sort()).toEqual(["error:invalidParams", "error:unknownCommand", "warning:noParty", "warning:pluginCommand", "warning:unusedAsset"]);
    expect(found.find((d) => d.code === "unknownCommand")?.location).toEqual({ mapId: M1, eventId: "ev_a", page: 0, commandIndex: 0 });
    expect(found.find((d) => d.code === "invalidParams")?.message).toContain("Wait");

    // 開始位置がマップの外になる文書
    const out = createEditorSession({ repo, doc: { ...doc, project: { ...doc.project, system: { ...doc.project.system, startX: 99 } } }, commands: registry });
    expect(out.validate().map((d) => d.code)).toContain("startOutOfMap");
  });
});

describe("importAsset / projectSource / assetStore", () => {
  it("importAsset は保存してマニフェストに登録し、1 回の undo で登録が外れる", async () => {
    const s = open();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5, 0, 0, 0, 7]).buffer;
    const r = await s.importAsset(png, "new.png", "image");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(s.doc.project.assets.entries[r.value.id]).toMatchObject({ name: "new.png", width: 5, height: 7 });
    expect((await s.assetStore().get(r.value.id))?.byteLength).toBe(png.byteLength);
    s.undo();
    expect(s.doc.project.assets.entries[r.value.id]).toBeUndefined();
  });

  it("projectSource は呼んだ時点の文書を返す（以後の編集は反映されない）", async () => {
    const s = open();
    const src = s.projectSource();
    s.execute(cmd.paintTiles(M1, 0, [{ x: 0, y: 0, tile: 5 }]));
    expect(Array.from((await src.mapData(M1)).layers[0]!.tiles)[0]).toBe(1);
    expect((await src.project()).meta.id).toBe(doc.project.meta.id);
    await expect(src.mapData("nope" as MapId)).rejects.toThrow("プロジェクトに無い");
    expect(await src.projectHash()).not.toBe(await s.projectSource().projectHash());
  });
});

describe("save / autosave", () => {
  it("save：dirty が消え、revision が進み、changedMaps だけ保存される", async () => {
    const s = open();
    expect(await s.save()).toEqual({ ok: true, value: undefined }); // 変更なしなら何もしない
    s.execute(cmd.paintTiles(M1, 0, [{ x: 0, y: 0, tile: 4 }]));
    expect(s.dirty).toBe(true);
    expect((await s.save()).ok).toBe(true);
    expect([s.dirty, s.doc.revision, s.saveStatus]).toEqual([false, 2, { kind: "saved", revision: 2 }]);
    const loaded = await repo.load(doc.project.meta.id);
    expect(loaded.ok && Array.from(loaded.value.maps[M1]!.layers[0]!.tiles)[0]).toBe(4);
    s.execute(cmd.setSwitchName("a" as never, "x"));
    expect(s.saveStatus).toEqual({ kind: "idle" });
  });

  it("保存中に入った編集は次の保存に回る", async () => {
    let during: (() => void) | undefined;
    const hooked: ProjectRepository = {
      ...repo,
      save: (d, o) => {
        during?.(); // リポジトリが書いている最中に編集が入る
        during = undefined;
        return repo.save(d, o);
      },
    };
    const s = open({ repo: hooked });
    s.execute(cmd.paintTiles(M1, 0, [{ x: 0, y: 0, tile: 4 }]));
    during = () => void s.execute(cmd.paintTiles(M1, 0, [{ x: 1, y: 0, tile: 4 }]));
    await s.save();
    expect(s.dirty).toBe(true);
    await s.save();
    expect(s.dirty).toBe(false);
    const loaded = await repo.load(doc.project.meta.id);
    expect(loaded.ok && Array.from(loaded.value.maps[M1]!.layers[0]!.tiles.slice(0, 2))).toEqual([4, 4]);
  });

  it("別の場所で先に保存されていたら conflict。overwrite で上書きできる", async () => {
    const s = open();
    await repo.save(doc); // 先に保存された（revision 2）
    s.execute(cmd.paintTiles(M1, 0, [{ x: 0, y: 0, tile: 4 }]));
    const r = await s.save();
    expect(r).toEqual({ ok: false, error: { kind: "conflict", currentRevision: 2 } });
    expect(s.saveStatus).toEqual({ kind: "conflict", currentRevision: 2 });
    expect(s.dirty).toBe(true);
    expect((await s.save({ overwrite: true })).ok).toBe(true);
    expect(s.saveStatus.kind).toBe("saved");
    expect(s.dirty).toBe(false);
  });

  it("保存に失敗したら error になり、dirty のまま。次の save で再試行する", async () => {
    let fail = true;
    const flaky: ProjectRepository = { ...repo, save: (d, o) => (fail ? Promise.resolve({ ok: false, error: { kind: "quota" } }) : repo.save(d, o)) };
    const s = open({ repo: flaky });
    s.execute(cmd.paintTiles(M1, 0, [{ x: 0, y: 0, tile: 4 }]));
    expect(await s.save()).toEqual({ ok: false, error: { kind: "quota" } });
    expect([s.saveStatus, s.dirty]).toEqual([{ kind: "error", error: { kind: "quota" } }, true]);
    fail = false;
    expect((await s.save()).ok).toBe(true);
    expect(s.dirty).toBe(false);
  });

  it("autosave：編集のたびにデバウンスし、タイマーが鳴ったら保存する。conflict の間は止まる", async () => {
    const timers = manualTimers();
    const s = open({ autosave: { debounceMs: 800 }, timers });
    s.execute(cmd.paintTiles(M1, 0, [{ x: 0, y: 0, tile: 4 }]));
    s.execute(cmd.paintTiles(M1, 0, [{ x: 1, y: 0, tile: 4 }]));
    expect([timers.pending(), timers.delays]).toEqual([1, [800, 800]]); // 2 回目で張り直し
    timers.fire();
    await vi_flush();
    expect(s.dirty).toBe(false);
    expect(s.saveStatus.kind).toBe("saved");

    await repo.save(s.doc); // 別の場所での保存で競合させる
    s.execute(cmd.paintTiles(M1, 0, [{ x: 2, y: 0, tile: 4 }]));
    timers.fire();
    await vi_flush();
    expect(s.saveStatus.kind).toBe("conflict");
    s.execute(cmd.paintTiles(M1, 0, [{ x: 3, y: 0, tile: 4 }]));
    expect(timers.pending()).toBe(0); // 競合中は自動保存しない
  });

  it("autosave 無しならタイマーを使わない。dispose で保留中のタイマーを止める", () => {
    const timers = manualTimers();
    const plain = open({ timers });
    plain.execute(cmd.setSwitchName("a" as never, "x"));
    expect(timers.pending()).toBe(0);
    const s = open({ autosave: { debounceMs: 10 }, timers });
    s.execute(cmd.setSwitchName("a" as never, "x"));
    expect(timers.pending()).toBe(1);
    s.dispose();
    expect(timers.pending()).toBe(0);
    s.dispose();
  });

  it("既定のタイマー（setTimeout）でも動く", async () => {
    const s = open({ autosave: { debounceMs: 5 } });
    s.execute(cmd.setSwitchName("a" as never, "x"));
    await new Promise((r) => setTimeout(r, 40));
    expect(s.dirty).toBe(false);
    s.dispose();
  });
});

/** マイクロタスクを流して、非同期の保存を終わらせる。 */
const vi_flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

describe("性質：任意のコマンド列", () => {
  it("[inv-1,2,3,4] 各コマンドについて undo/redo が往復し、失敗は文書を変えず、成功後の validate にエラーが無い", () => {
    fc.assert(
      fc.property(fc.gen(), (g) => {
        const s = createEditorSession({ repo, doc, commands: registry, now: slowClock() });
        const initial = s.doc;
        let applied = 0;
        for (let i = 0; i < 14; i++) {
          const c = g(editorCommandArb, s.doc);
          const before = s.doc;
          const r = s.execute(c);
          if (!r.ok) {
            expect(s.doc).toBe(before);
            continue;
          }
          if (s.doc === before) continue;
          applied++;
          const after = s.doc;
          s.undo();
          expect(s.doc).toEqual(before);
          s.redo();
          expect(s.doc).toEqual(after);
          expect(s.validate().filter((d) => d.severity === "error")).toEqual([]);
        }
        // 全部戻して、全部やり直す
        const final = s.doc;
        for (let i = 0; i < applied; i++) s.undo();
        expect(s.doc).toEqual(initial);
        for (let i = 0; i < applied; i++) s.redo();
        expect(s.doc).toEqual(final);
      }),
      { numRuns: 40 },
    );
  }, 30_000);

  it("保存 → 読み込みで、編集後の文書に戻る", async () => {
    await fc.assert(
      fc.asyncProperty(fc.gen(), async (g) => {
        const local = createMemoryProjectRepository();
        const fresh = await local.create("p");
        const s = createEditorSession({ repo: local, doc: fresh, commands: registry, now: slowClock() });
        for (let i = 0; i < 10; i++) s.execute(g(editorCommandArb, s.doc));
        expect((await s.save()).ok).toBe(true);
        const loaded = await local.load(fresh.project.meta.id);
        expect(loaded.ok && loaded.value).toEqual(s.doc);
      }),
      { numRuns: 25 },
    );
  }, 30_000);

  describe("プラグイン", () => {
    const plugged = () => {
      const commands = createCommandRegistry();
      registerBuiltins(commands);
      // 空のオブジェクトだけを受け付ける params（組み込みの Else のものを借りる）
      const empty = commands.get("Else")!.params;
      commands.register({ code: "plugin:demo/X", params: empty, meta: { label: "X", category: "p", describe: () => "X", refs: () => [] }, run: () => ({}) });
      return commands;
    };

    it("登録済みのプラグインのコマンドを使っているのに、system.plugins で有効になっていなければ警告する。有効なら出ない", () => {
      const s = createEditorSession({ repo, doc, commands: plugged() });
      s.execute(cmd.createEvent(M1, 2, 2, "ev_a" as EventId));
      s.execute(cmd.insertCommands(M1, "ev_a" as EventId, 0, 0, [eventCommand("plugin:demo/X")]));
      const codes = () => s.validate().map((d) => d.code);
      expect(codes()).toContain("pluginNotEnabled");
      expect(codes()).not.toContain("pluginCommand");
      s.execute(cmd.setSystem({ plugins: [{ name: "demo", version: "1.0.0", params: {} }] }));
      expect(codes()).not.toContain("pluginNotEnabled");
    });

    it("deps.diagnostics の診断が validate に足される。例外を投げる診断があっても、ほかの診断は出る", () => {
      const s = createEditorSession({
        repo,
        doc,
        commands: registry,
        diagnostics: [
          () => [{ severity: "warning", code: "fromPlugin", message: "プラグインの診断" }],
          () => {
            throw new Error("診断が壊れている");
          },
        ],
      });
      const found = s.validate();
      expect(found.map((d) => d.code)).toEqual(expect.arrayContaining(["fromPlugin", "pluginDiagnosticsFailed"]));
      expect(found.find((d) => d.code === "pluginDiagnosticsFailed")?.message).toContain("診断が壊れている");
    });
  });
});
