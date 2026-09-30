import type { AssetId } from "@rpg/schema";
import type { CommitBatch, StoreBackend, StoredMeta } from "./backend.js";

/**
 * ディレクトリ（`FileSystemDirectoryHandle`）に置く永続層：OPFS（ブラウザの私有ファイルシステム）と、
 * File System Access API（利用者が選んだフォルダ）の両方で使える。レイアウトは docs/10-project-store.md のとおり：
 *
 * ```
 * <root>/<project-id>/project.json
 *                     meta.json
 *                     maps/<mapId>.json
 *                     assets/<assetId>.bin
 * ```
 *
 * 1 つのファイルの書き込みは `createWritable` が原子的に行う（閉じるまで元のファイルは変わらない）。
 * 複数のファイルにまたがる `commit` は、マップ → project.json → meta.json の順に書く：`meta.json` が最後なので、
 * 途中で止まっても `meta.revision` は古いまま残り、`save` の楽観ロックが次の保存で整合を取り直す。
 */

const isNotFound = (e: unknown): boolean => typeof e === "object" && e !== null && ["NotFoundError", "TypeMismatchError"].includes((e as { name?: string }).name ?? "");

/** ID やファイル名として安全か（パスの区切りや `..` を含まない）。 */
const safe = (name: string): string => {
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(name) || name === "." || name === "..") throw new Error(`ファイル名として使えない: "${name}"`);
  return name;
};

async function readFile(dir: FileSystemDirectoryHandle, name: string): Promise<File | undefined> {
  try {
    return await (await dir.getFileHandle(name)).getFile();
  } catch (e) {
    if (isNotFound(e)) return undefined;
    throw e;
  }
}

async function readJson(dir: FileSystemDirectoryHandle, name: string): Promise<unknown> {
  const file = await readFile(dir, name);
  return file === undefined ? undefined : (JSON.parse(await file.text()) as unknown);
}

async function writeFile(dir: FileSystemDirectoryHandle, name: string, data: string | ArrayBuffer): Promise<void> {
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(data);
  } catch (e) {
    await writable.abort?.().catch(() => undefined);
    throw e;
  }
  await writable.close();
}

async function removeFile(dir: FileSystemDirectoryHandle, name: string): Promise<void> {
  try {
    await dir.removeEntry(name);
  } catch (e) {
    if (!isNotFound(e)) throw e;
  }
}

async function subdir(parent: FileSystemDirectoryHandle, name: string, create: boolean): Promise<FileSystemDirectoryHandle | undefined> {
  try {
    return await parent.getDirectoryHandle(name, { create });
  } catch (e) {
    if (isNotFound(e)) return undefined;
    throw e;
  }
}

export function createDirectoryBackend(root: FileSystemDirectoryHandle): StoreBackend {
  return {
    async listMeta() {
      const out: { id: string; meta: StoredMeta }[] = [];
      for await (const [name, handle] of root.entries()) {
        if (handle.kind !== "directory") continue;
        try {
          const meta = (await readJson(handle as FileSystemDirectoryHandle, "meta.json")) as StoredMeta | undefined;
          if (meta !== undefined) out.push({ id: name, meta });
        } catch {
          // 壊れた・関係ないフォルダは一覧に出さない
        }
      }
      return out;
    },

    async getMeta(id) {
      const dir = await subdir(root, safe(id), false);
      return dir === undefined ? undefined : ((await readJson(dir, "meta.json")) as StoredMeta | undefined);
    },

    async getProject(id) {
      const dir = await subdir(root, safe(id), false);
      const project = dir === undefined ? undefined : await readJson(dir, "project.json");
      if (project === undefined) throw new Error(`${id}/project.json が無い`);
      return project;
    },

    async getMap(id, mapId) {
      const dir = await subdir(root, safe(id), false);
      const maps = dir === undefined ? undefined : await subdir(dir, "maps", false);
      return maps === undefined ? undefined : readJson(maps, `${safe(mapId)}.json`);
    },

    async commit(id, batch: CommitBatch) {
      const dir = (await subdir(root, safe(id), true))!;
      const maps = (await subdir(dir, "maps", true))!;
      for (const [mapId, json] of Object.entries(batch.maps)) {
        if (json === null) await removeFile(maps, `${safe(mapId)}.json`);
        else await writeFile(maps, `${safe(mapId)}.json`, JSON.stringify(json));
      }
      await writeFile(dir, "project.json", JSON.stringify(batch.project));
      await writeFile(dir, "meta.json", JSON.stringify(batch.meta)); // 最後に書く（コミットの印）
    },

    async removeProject(id) {
      try {
        await root.removeEntry(safe(id), { recursive: true });
      } catch (e) {
        if (!isNotFound(e)) throw e;
      }
    },

    async putAsset(id, assetId, bytes) {
      const dir = (await subdir(root, safe(id), true))!;
      const assets = (await subdir(dir, "assets", true))!;
      await writeFile(assets, `${safe(assetId)}.bin`, bytes);
    },

    async getAsset(id, assetId) {
      const dir = await subdir(root, safe(id), false);
      const assets = dir === undefined ? undefined : await subdir(dir, "assets", false);
      if (assets === undefined) return undefined;
      // 拡張子は問わない（ほかのツールが `hero.png` の形で置いたものも読める）
      for await (const [name, handle] of assets.entries()) {
        if (handle.kind === "file" && name.split(".")[0] === assetId) return (await (handle as FileSystemFileHandle).getFile()).arrayBuffer();
      }
      return undefined;
    },

    async deleteAsset(id, assetId: AssetId) {
      const dir = await subdir(root, safe(id), false);
      const assets = dir === undefined ? undefined : await subdir(dir, "assets", false);
      if (assets === undefined) return;
      const names: string[] = [];
      for await (const [name, handle] of assets.entries()) if (handle.kind === "file" && name.split(".")[0] === assetId) names.push(name);
      for (const name of names) await removeFile(assets, name);
    },
  };
}
