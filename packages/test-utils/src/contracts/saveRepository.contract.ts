import { describe, expect, it } from "vitest";
import { initialState, SNAPSHOT_VERSION, toSnapshot } from "@rpg/core";
import type { SaveSnapshot } from "@rpg/core";
import type { SaveRepository, SaveRepositoryOpts } from "@rpg/runtime";
import { loadFixtureProject } from "../harness/project.js";
import type { ContractFactory } from "./contract.js";

/** 契約テストが実装に要求する操作口。同じ保存先を別の設定で開き直せる必要がある。 */
export interface SaveRepositoryFixture {
  /** 同じ保存先を指す SaveRepository を（新しい設定で）作る。 */
  open(opts: SaveRepositoryOpts): SaveRepository;
  /** 保存された payload を、checksum はそのままに書き換える（改ざんの再現）。 */
  tamper(projectId: string, slot: number): Promise<void>;
}

const OPTS: SaveRepositoryOpts = { projectId: "proj-a", projectHash: "hash-1" };

/** minimal フィクスチャの初期状態から作ったスナップショット。 */
export function sampleSnapshot(overrides: Partial<Pick<SaveSnapshot, "projectId" | "projectHash" | "savedAt">> & { version?: number; tick?: number } = {}): SaveSnapshot {
  const { ctx } = loadFixtureProject("minimal");
  const state = initialState(ctx, "seed");
  const snap = toSnapshot(
    { ...state, tick: overrides.tick ?? 0, playtimeTicks: overrides.tick ?? 0 },
    { projectId: overrides.projectId ?? OPTS.projectId, projectHash: overrides.projectHash ?? OPTS.projectHash, savedAt: overrides.savedAt ?? "2026-01-01T00:00:00.000Z" },
  );
  return overrides.version === undefined ? snap : { ...snap, version: overrides.version };
}

/**
 * SaveRepository の契約スイート。すべての SaveRepository アダプタが通さなければならない（docs/11-save-store.md の不変条件）。
 */
export function saveRepositoryContract(name: string, make: ContractFactory<SaveRepositoryFixture>): void {
  describe(`SaveRepository contract: ${name}`, () => {
    it("[inv-1] write → read は同じ内容（deep-equal）", async () => {
      const repo = (await make()).open(OPTS);
      const snap = sampleSnapshot({ tick: 123 });
      expect((await repo.write(3, snap)).ok).toBe(true);
      const read = await repo.read(3);
      expect(read.ok && read.value).toEqual(snap);
    });

    it("空のスロットの read は notFound、範囲外のスロットの write は io", async () => {
      const repo = (await make()).open({ ...OPTS, maxSlots: 4 });
      expect(await repo.read(1)).toEqual({ ok: false, error: { kind: "notFound" } });
      expect(await repo.read(99)).toEqual({ ok: false, error: { kind: "notFound" } });
      const r = await repo.write(4, sampleSnapshot());
      expect(!r.ok && r.error.kind).toBe("io");
    });

    it("上書き・削除ができ、listSlots はスロット番号の昇順で返す", async () => {
      const repo = (await make()).open(OPTS);
      await repo.write(5, sampleSnapshot({ tick: 5 }));
      await repo.write(1, sampleSnapshot({ tick: 1 }));
      await repo.write(1, sampleSnapshot({ tick: 2, savedAt: "2026-02-02T00:00:00.000Z" }));
      const list = await repo.listSlots();
      expect(list.map((m) => m.slot)).toEqual([1, 5]);
      expect(list[0]).toMatchObject({ slot: 1, playtimeTicks: 2, savedAt: "2026-02-02T00:00:00.000Z", version: SNAPSHOT_VERSION, projectHash: "hash-1", compatible: "yes" });
      expect(list[0]?.preview).toEqual(sampleSnapshot().preview);
      await repo.remove(1);
      await repo.remove(9); // 無いスロットの削除は何も起きない
      expect((await repo.listSlots()).map((m) => m.slot)).toEqual([5]);
      expect((await repo.read(1)).ok).toBe(false);
    });

    it("[inv-2] 改ざんされた payload は corrupted で拒否される", async () => {
      const fx = await make();
      const repo = fx.open(OPTS);
      await repo.write(2, sampleSnapshot());
      await fx.tamper(OPTS.projectId, 2);
      const r = await repo.read(2);
      expect(!r.ok && r.error.kind).toBe("corrupted");
      // 取り込みも同様に、checksum が合わなければ拒否する
      const exported = await fx.open(OPTS).exportSlot(2);
      const imported = await repo.importSlot(7, exported);
      expect(!imported.ok && imported.error.kind).toBe("corrupted");
      expect((await repo.listSlots()).map((m) => m.slot)).toEqual([2]);
    });

    it("[inv-3] 異なる projectId のスナップショットは write できず、セーブは projectId ごとに分離される", async () => {
      const fx = await make();
      const a = fx.open(OPTS);
      const r = await a.write(1, sampleSnapshot({ projectId: "proj-b" }));
      expect(r).toEqual({ ok: false, error: { kind: "incompatible", reason: "projectMismatch" } });
      await a.write(1, sampleSnapshot());
      const b = fx.open({ ...OPTS, projectId: "proj-b" });
      expect(await b.listSlots()).toEqual([]);
      expect(await b.read(1)).toEqual({ ok: false, error: { kind: "notFound" } });
    });

    it("[inv-4] importSlot(s, exportSlot(s)) は同じ内容", async () => {
      const repo = (await make()).open(OPTS);
      const snap = sampleSnapshot({ tick: 77 });
      await repo.write(1, snap);
      const file = await repo.exportSlot(1);
      const imported = await repo.importSlot(6, file);
      expect(imported.ok && imported.value).toMatchObject({ slot: 6, playtimeTicks: 77, compatible: "yes" });
      const read = await repo.read(6);
      expect(read.ok && read.value).toEqual(snap);
      await expect(repo.exportSlot(15)).rejects.toThrow();
    });

    it("importSlot は不正なファイルを corrupted、別プロジェクトのセーブを incompatible で拒否する", async () => {
      const fx = await make();
      const repo = fx.open(OPTS);
      const notJson = await repo.importSlot(1, new Blob(["これは JSON ではない"]));
      expect(!notJson.ok && notJson.error.kind).toBe("corrupted");
      const wrongShape = await repo.importSlot(1, new Blob([JSON.stringify({ hello: "world" })]));
      expect(!wrongShape.ok && wrongShape.error.kind).toBe("corrupted");

      const other = fx.open({ ...OPTS, projectId: "proj-b" });
      await other.write(1, sampleSnapshot({ projectId: "proj-b" }));
      const foreign = await repo.importSlot(2, await other.exportSlot(1));
      expect(foreign).toEqual({ ok: false, error: { kind: "incompatible", reason: "projectMismatch" } });
    });

    it("[inv-5] listSlots は payload を読まない（payload が壊れていても一覧できる）", async () => {
      const fx = await make();
      const repo = fx.open(OPTS);
      await repo.write(1, sampleSnapshot({ tick: 9 }));
      await fx.tamper(OPTS.projectId, 1);
      const list = await repo.listSlots();
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ slot: 1, playtimeTicks: 9 });
    });

    it("互換判定：projectHash の不一致は既定で incompatible、allowProjectMismatch なら読めて migratable", async () => {
      const fx = await make();
      await fx.open(OPTS).write(1, sampleSnapshot());

      const changed = fx.open({ ...OPTS, projectHash: "hash-2" });
      expect((await changed.listSlots())[0]?.compatible).toBe("no");
      expect(await changed.read(1)).toEqual({ ok: false, error: { kind: "incompatible", reason: "projectMismatch" } });

      const lenient = fx.open({ ...OPTS, projectHash: "hash-2", allowProjectMismatch: true });
      expect((await lenient.listSlots())[0]?.compatible).toBe("migratable");
      expect((await lenient.read(1)).ok).toBe(true);
    });

    it("互換判定：新しい version のセーブは incompatible（newerVersion）", async () => {
      const repo = (await make()).open(OPTS);
      await repo.write(1, sampleSnapshot({ version: SNAPSHOT_VERSION + 1 }));
      expect((await repo.listSlots())[0]?.compatible).toBe("no");
      expect(await repo.read(1)).toEqual({ ok: false, error: { kind: "incompatible", reason: "newerVersion" } });
    });
  });
}
