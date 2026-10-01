import fc from "fast-check";
import { loadFixtureProject, reachableStateArb } from "@rpg/test-utils";
import { describe, expect, it } from "vitest";
import { dispatch, initialState, step } from "./game/index.js";
import { emptyInput, inputFrame } from "./input.js";
import { startInterpreter } from "./interpreter/index.js";
import { fromSnapshot, migrateSnapshot, progressFingerprint, SNAPSHOT_VERSION, snapshotMigrations, stripTransient, toSnapshot } from "./snapshot.js";
import type { SaveSnapshot } from "./snapshot.js";
import { pluginStateOf, withPluginState } from "./state.js";
import type { GameState } from "./state.js";

const { ctx } = loadFixtureProject("minimal");
const meta = { projectId: "minimal", projectHash: "hash-1", savedAt: "2026-01-01T00:00:00Z" };

const walked = (): GameState => {
  let s = initialState(ctx, "snap");
  for (let i = 0; i < 24; i++) s = step(s, inputFrame(["right"], i === 0 ? ["right"] : []), ctx).state; // 2 歩目の途中
  return s;
};
const load = (snap: unknown) => fromSnapshot(snap as SaveSnapshot, ctx);
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

describe("toSnapshot", () => {
  it("records the version, metadata, playtime and a preview", () => {
    const s = walked();
    const snap = toSnapshot(s, meta);
    expect(snap).toMatchObject({
      version: SNAPSHOT_VERSION, projectId: "minimal", projectHash: "hash-1", savedAt: "2026-01-01T00:00:00Z",
      playtimeTicks: 24, preview: { mapName: "map_start", partyNames: ["勇者"], level: 1 },
    });
  });

  it("produces plain JSON data", () => {
    const snap = toSnapshot(walked(), meta);
    expect(JSON.parse(JSON.stringify(snap))).toEqual(snap);
  });

  it("does not alias the source state", () => {
    const s = walked();
    const snap = toSnapshot(s, meta);
    expect(snap.state).not.toBe(s);
    expect(snap.state.map).not.toBe(s.map);
  });

  it("snaps characters mid-step to their destination tile (transient state is dropped)", () => {
    const s = walked();
    expect(s.map.player).toMatchObject({ x: 4, moving: true }); // 歩行の途中
    const stripped = stripTransient(s);
    expect(stripped.map.player).toMatchObject({ x: s.map.player.x, realX: s.map.player.x, moving: false });
    expect(stripTransient(stripped)).toEqual(stripped);
  });
});

describe("pluginState（プラグインの保存領域）", () => {
  const withState = (): GameState => withPluginState(withPluginState(walked(), "dungeon", { floor: 3, log: ["a", "b"], seen: null, ok: true }), "other", 7);

  it("書き込むまで無く、プラグインごとのキーに読み書きできる（ほかのプラグインの値は変わらない）", () => {
    const s = walked();
    expect(s.pluginState).toBeUndefined();
    expect(pluginStateOf(s, "dungeon")).toBeUndefined();
    const a = withPluginState(s, "dungeon", { floor: 1 });
    const b = withPluginState(a, "other", 2);
    expect(pluginStateOf(b, "dungeon")).toEqual({ floor: 1 });
    expect(pluginStateOf(b, "other")).toBe(2);
    expect(pluginStateOf(b, "toString")).toBeUndefined();
    expect(s.pluginState).toBeUndefined(); // 元の状態は変わらない
  });

  it("セーブして読み込むと戻る（JSON を経由しても同じ）。使っていない状態のセーブには、キー自体が増えない", () => {
    const s = withState();
    const r = load(clone(toSnapshot(s, meta)));
    expect(r).toEqual({ ok: true, value: stripTransient(s) });
    expect(Object.hasOwn(toSnapshot(walked(), meta).state, "pluginState")).toBe(false);
  });

  it("JSON でない値の入ったセーブは弾く", () => {
    const snap = clone(toSnapshot(withState(), meta));
    (snap.state as unknown as Record<string, unknown>)["pluginState"] = { dungeon: { f: () => 1, n: undefined, d: new Date(0) } };
    expect(load(snap).ok).toBe(false);
    (snap.state as unknown as Record<string, unknown>)["pluginState"] = [1];
    expect(load(snap).ok).toBe(false);
  });
});

describe("fromSnapshot", () => {
  it("[inv-4] round-trips: fromSnapshot(toSnapshot(s)) equals s without transient state", () => {
    fc.assert(
      fc.property(reachableStateArb(ctx, 150), (s) => {
        const r = load(clone(toSnapshot(s, meta)));
        expect(r).toEqual({ ok: true, value: stripTransient(s) });
      }),
      { numRuns: 80 },
    );
  });

  it("restores a game mid-conversation (message open, interpreter waiting)", () => {
    let s = initialState(ctx, "talk");
    for (let i = 0; i < 200; i++) s = step(s, inputFrame(["right"], i === 0 ? ["right"] : []), ctx).state;
    s = step(s, inputFrame(["ok"], ["ok"]), ctx).state;
    expect(s.message.open).toBe(true);

    const restored = load(clone(toSnapshot(s, meta)));
    if (!restored.ok) throw new Error(JSON.stringify(restored.error));
    let a = restored.value;
    let b = stripTransient(s) as GameState;
    // 再開後の進行が元のゲームと一致する
    for (const input of [inputFrame(["ok"], ["ok"]), emptyInput(), emptyInput(), emptyInput()]) {
      a = step(a, input, ctx).state;
      b = step(b, input, ctx).state;
    }
    expect(a).toEqual(b);
    expect(a.switches["sw_talked" as never]).toBe(true);
  });

  it("resumes at the same position after save → JSON → load (M3 の完了条件の下地)", () => {
    const s = walked();
    const r = load(JSON.parse(JSON.stringify(toSnapshot(s, meta))));
    if (!r.ok) throw new Error("must load");
    expect(r.value.map.player).toMatchObject({ x: s.map.player.x, y: s.map.player.y, direction: "right" });
    expect(r.value.tick).toBe(s.tick);
  });

  it("returns a state that does not alias the snapshot", () => {
    const snap = clone(toSnapshot(walked(), meta));
    const r = load(snap);
    if (!r.ok) throw new Error("must load");
    expect(r.value.map).not.toBe(snap.state.map);
    const before = JSON.stringify(snap);
    (r.value.switches as Record<string, boolean>)["mutated"] = true;
    expect(JSON.stringify(snap)).toBe(before);
  });

  it("rejects a snapshot from a newer version", () => {
    const snap = { ...clone(toSnapshot(walked(), meta)), version: SNAPSHOT_VERSION + 1 };
    expect(load(snap)).toEqual({ ok: false, error: { kind: "newer-version", found: SNAPSHOT_VERSION + 1, supported: SNAPSHOT_VERSION } });
  });

  it.each([undefined, 0, -1, 1.5, "1", null])("rejects an invalid version %j", (version) => {
    const snap = { ...clone(toSnapshot(walked(), meta)), version };
    expect(load(snap)).toMatchObject({ ok: false, error: { kind: "invalid" } });
  });

  it("rejects a snapshot pointing at a map that does not exist in the project", () => {
    const snap = clone(toSnapshot(walked(), meta));
    (snap.state as { map: unknown }).map = { ...snap.state.map, mapId: "map_gone" };
    expect(load(snap)).toEqual({ ok: false, error: { kind: "missing-map", mapId: "map_gone" } });
  });

  describe("rejects corrupted payloads", () => {
    const mutations: [string, (snap: any) => void][] = [
      ["missing state", (s) => delete s.state],
      ["missing map.player", (s) => delete s.state.map.player],
      ["player.x is a string", (s) => (s.state.map.player.x = "3")],
      ["player.direction is invalid", (s) => (s.state.map.player.direction = "north")],
      ["tick is negative", (s) => (s.state.tick = -1)],
      ["rng state is all zero-length", (s) => (s.state.rng.s = [1, 2, 3])],
      ["rng state is out of uint32 range", (s) => (s.state.rng.s[0] = 2 ** 40)],
      ["switches value is not boolean", (s) => (s.state.switches = { a: 1 })],
      ["unknown top-level state key", (s) => (s.state.extra = 1)],
      ["interpreter with a bad wait", (s) => (s.state.interpreters = [{ id: "i0", origin: { kind: "plugin", name: "x" }, mode: "normal", commands: [], pc: 0, wait: { kind: "zzz" }, branch: {}, callStack: [], locals: {} }])],
      ["message.open is not boolean", (s) => (s.state.message.open = "yes")],
      ["preview missing", (s) => delete s.preview],
      ["extra top-level key", (s) => (s.extra = true)],
    ];
    it.each(mutations)("%s", (_name, mutate) => {
      const snap = clone(toSnapshot(walked(), meta));
      mutate(snap);
      const r = load(snap);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.kind).toBe("invalid");
    });
  });

  it("never throws on arbitrary input", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (json) => {
        expect(typeof load(json).ok).toBe("boolean");
      }),
    );
    expect(() => load(undefined)).not.toThrow();
    expect(() => load(null)).not.toThrow();
  });

  it("has no migrations yet (v1 is the first format)", () => {
    expect(SNAPSHOT_VERSION).toBe(1);
    expect(snapshotMigrations).toEqual([]);
  });
});

describe("progressFingerprint", () => {
  const start = initialState(ctx, "seed");
  const walked = Array.from({ length: 16 }).reduce<GameState>((s) => step(s, inputFrame(["right"], ["right"]), ctx).state, start);

  it("時間だけが進んでも、メニューを開閉しても変わらない", () => {
    const waited = Array.from({ length: 30 }).reduce<GameState>((s) => step(s, emptyInput(), ctx).state, start);
    expect(waited.tick).toBeGreaterThan(start.tick);
    expect(progressFingerprint(waited)).toBe(progressFingerprint(start));
    expect(progressFingerprint({ ...start, scene: { kind: "menu", screen: "save", cursor: 3 } })).toBe(progressFingerprint(start));
  });

  it("移動や所持品・スイッチの変化で変わる", () => {
    expect(walked.map.player.x).not.toBe(start.map.player.x);
    expect(progressFingerprint(walked)).not.toBe(progressFingerprint(start));
    expect(progressFingerprint({ ...start, party: { ...start.party, gold: start.party.gold + 1 } })).not.toBe(progressFingerprint(start));
    expect(progressFingerprint({ ...start, switches: { ...start.switches, ["s1" as never]: true } })).not.toBe(progressFingerprint(start));
  });

  it("キーの順序や補間中の位置には左右されない", () => {
    const { tick, ...rest } = start;
    expect(progressFingerprint({ ...rest, tick } as GameState)).toBe(progressFingerprint(start));
    expect(progressFingerprint({ ...start, map: { ...start.map, player: { ...start.map.player, realX: start.map.player.x + 0.5, moving: true } } })).toBe(progressFingerprint(start));
  });
});

describe("migrateSnapshot", () => {
  const fake = [
    { from: 1, to: 2, migrate: (s: unknown) => ({ ...(s as object), a: 1 }) },
    { from: 2, to: 3, migrate: (s: unknown) => ({ ...(s as object), b: 2 }) },
  ];

  it("applies migrations in order", () => {
    expect(migrateSnapshot({}, 1, 3, fake)).toEqual({ ok: true, value: { a: 1, b: 2 } });
    expect(migrateSnapshot({}, 2, 3, fake)).toEqual({ ok: true, value: { b: 2 } });
  });

  it("is the identity at the target version", () => {
    const snap = { x: 1 };
    expect(migrateSnapshot(snap, 3, 3, fake)).toEqual({ ok: true, value: snap });
  });

  it("fails when a step is missing", () => {
    expect(migrateSnapshot({}, 1, 4, fake)).toMatchObject({ ok: false, error: { kind: "migration" } });
  });
});

describe("dispatch loadSnapshot", () => {
  it("replaces the state on success", () => {
    const saved = toSnapshot(walked(), meta);
    const r = dispatch(initialState(ctx, "other"), { type: "loadSnapshot", snapshot: clone(saved) }, ctx);
    expect(r.state).toEqual(stripTransient(walked()));
    expect(r.effects).toEqual([]);
  });

  it("keeps the state and warns on failure", () => {
    const s = initialState(ctx, "keep");
    const r = dispatch(s, { type: "loadSnapshot", snapshot: { version: 99 } as never }, ctx);
    expect(r.state).toBe(s);
    expect(r.effects).toEqual([expect.objectContaining({ kind: "log", level: "warn" })]);
  });
});

describe("選択肢・数値入力・タイマー・移動ルート（M6）の状態", () => {
  it("survives a save/load round trip while a choice window, a number input and a timer are active", () => {
    const base = walked();
    const withChoices: GameState = {
      ...base,
      message: { ...base.message, open: true, owner: "i0", text: "どうする？", choices: ["A", "B"], cursor: 1 },
      timers: { active: true, ticks: 100 },
    };
    const back = load(clone(toSnapshot(withChoices, meta)));
    expect(back.ok && back.value.message).toMatchObject({ choices: ["A", "B"], cursor: 1 });
    expect(back.ok && back.value.timers).toEqual({ active: true, ticks: 100 });

    const withNumber: GameState = { ...base, message: { ...base.message, open: true, owner: "i0", numberInput: { digits: 3, value: 42 }, cursor: 2 } };
    const back2 = load(clone(toSnapshot(withNumber, meta)));
    expect(back2.ok && back2.value.message).toMatchObject({ numberInput: { digits: 3, value: 42 }, cursor: 2 });
  });

  it("older saves without cursor / numberInput still load", () => {
    const snap = clone(toSnapshot(walked(), meta));
    expect(snap.state.message).not.toHaveProperty("cursor");
    expect(load(snap).ok).toBe(true);
  });

  it("rejects a number input with an impossible digit count", () => {
    const snap = clone(toSnapshot(walked(), meta)) as unknown as { state: { message: Record<string, unknown> } };
    snap.state.message["numberInput"] = { digits: 0, value: 0 };
    expect(load(snap).ok).toBe(false);
  });

  it("a running move route resumes identically after a save/load round trip", () => {
    const route = { code: "SetMoveRoute", params: { target: "player", wait: false, route: { repeat: true, skippable: true, steps: [{ kind: "move", dir: "right" }, { kind: "wait", frames: 3 }, { kind: "move", dir: "left" }] } }, indent: 0 };
    let s = startInterpreter(initialState(ctx, "route"), { kind: "plugin", name: "t" }, [route], "normal");
    for (let i = 0; i < 20; i++) s = step(s, emptyInput(), ctx).state;
    expect(s.interpreters.some((i) => i.origin.kind === "plugin" && i.origin.name.startsWith("moveRoute"))).toBe(true);

    const restored = load(clone(toSnapshot(s, meta)));
    expect(restored.ok).toBe(true);
    let a = stripTransient(s);
    let b = restored.ok ? restored.value : a;
    for (let i = 0; i < 60; i++) {
      a = step(a, emptyInput(), ctx).state;
      b = step(b, emptyInput(), ctx).state;
    }
    expect(b).toEqual(a);
  });
});
