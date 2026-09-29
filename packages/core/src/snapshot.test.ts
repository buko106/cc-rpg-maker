import fc from "fast-check";
import { loadFixtureProject, reachableStateArb } from "@rpg/test-utils";
import { describe, expect, it } from "vitest";
import { dispatch, initialState, step } from "./game/index.js";
import { emptyInput, inputFrame } from "./input.js";
import { fromSnapshot, migrateSnapshot, SNAPSHOT_VERSION, snapshotMigrations, stripTransient, toSnapshot } from "./snapshot.js";
import type { SaveSnapshot } from "./snapshot.js";
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
