/**
 * 本物のブラウザの OPFS で ProjectRepository（ディレクトリ版）を一通り動かすハーネス（e2e/opfs.spec.ts がバンドルして流し込む）。
 */
import { openOpfsProjectRepository } from "../../packages/project-store/src/index";

export interface OpfsReport {
  created: { revision: number; title: string };
  listed: string[];
  loadedEqual: boolean;
  savedRevision: number | undefined;
  conflict: string | undefined;
  reloadedTitle: string | undefined;
  assetBytes: number;
  zipBytes: number;
  importedTitle: string | undefined;
  importedIsNew: boolean;
  importedAssetBytes: number;
  listedAfterImport: number;
  afterRemove: string[];
  loadAfterRemove: string | undefined;
  layout: string[];
}

async function listTree(dir: FileSystemDirectoryHandle, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind === "directory") out.push(...(await listTree(handle as FileSystemDirectoryHandle, `${prefix}${name}/`)));
    else out.push(`${prefix}${name}`);
  }
  return out.sort();
}

export async function run(): Promise<OpfsReport> {
  const name = `e2e-projects-${Math.random().toString(36).slice(2)}`;
  const repo = await openOpfsProjectRepository(name);
  const root = await (await navigator.storage.getDirectory()).getDirectoryHandle(name);
  try {
    const doc = await repo.create("OPFS のゲーム");
    const id = doc.project.meta.id;
    const listed = (await repo.list()).map((m) => m.id);
    const loaded = await repo.load(id);
    const loadedEqual = loaded.ok && JSON.stringify(loaded.value) === JSON.stringify(doc);

    const saved = await repo.save({ ...doc, project: { ...doc.project, meta: { ...doc.project.meta, title: "改題した" } } }, { expectedRevision: 1 });
    const stale = await repo.save(doc, { expectedRevision: 1 });
    const reloaded = await repo.load(id);
    const assetId = Object.keys(doc.project.assets.entries)[0] as never;
    const assetBytes = (await repo.assets(id).get(assetId))?.byteLength ?? 0;
    const layout = await listTree(root);

    const zip = await repo.exportZip(id);
    const imported = zip.ok ? await repo.importZip(zip.value) : undefined;
    const importedDoc = imported?.ok ? await repo.load(imported.value.id) : undefined;
    const importedAssetBytes = imported?.ok ? ((await repo.assets(imported.value.id).get(assetId))?.byteLength ?? 0) : 0;
    const listedAfterImport = (await repo.list()).length;

    await repo.remove(id);
    if (imported?.ok) await repo.remove(imported.value.id);
    const afterRemove = (await repo.list()).map((m) => m.id);
    const gone = await repo.load(id);

    return {
      created: { revision: doc.revision, title: doc.project.meta.title },
      listed,
      loadedEqual,
      savedRevision: saved.ok ? saved.value.revision : undefined,
      conflict: stale.ok ? undefined : stale.error.kind,
      reloadedTitle: reloaded.ok ? reloaded.value.project.meta.title : undefined,
      assetBytes,
      zipBytes: zip.ok ? zip.value.length : 0,
      importedTitle: importedDoc?.ok ? importedDoc.value.project.meta.title : undefined,
      importedIsNew: imported?.ok === true && imported.value.id !== id,
      importedAssetBytes,
      listedAfterImport,
      afterRemove,
      loadAfterRemove: gone.ok ? undefined : gone.error.kind,
      layout: layout.map((p) => p.replace(id, "<id>")),
    };
  } finally {
    await (await navigator.storage.getDirectory()).removeEntry(name, { recursive: true });
  }
}

(window as unknown as { __opfs: unknown }).__opfs = { run };
