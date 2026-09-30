import type { ProjectRepository } from "./ports/projectRepository.js";
import { createDirectoryBackend } from "./directory.js";
import { createRepository } from "./repository.js";
import type { RepositoryOptions } from "./repository.js";

/**
 * OPFS（ブラウザの私有ファイルシステム）の `root` の下にプロジェクトを置く ProjectRepository。
 * `navigator.storage.getDirectory()` の下位フォルダを渡す（`openOpfsProjectRepository` が用意する）。
 */
export function createOpfsProjectRepository(root: FileSystemDirectoryHandle, opts: RepositoryOptions = {}): ProjectRepository {
  return createRepository(createDirectoryBackend(root), opts);
}

/**
 * File System Access API で利用者が選んだフォルダ（`showDirectoryPicker()` の結果）の下にプロジェクトを置く ProjectRepository。
 * 保存の中身は OPFS 版と同じレイアウトなので、フォルダをそのままコピー・バージョン管理できる。
 */
export function createFsaProjectRepository(dir: FileSystemDirectoryHandle, opts: RepositoryOptions = {}): ProjectRepository {
  return createRepository(createDirectoryBackend(dir), opts);
}

/** ブラウザの OPFS を開いて、その中の `name` フォルダ（既定 `rpg-projects`）を保存先にする。OPFS が無い環境では reject。 */
export async function openOpfsProjectRepository(name = "rpg-projects", opts: RepositoryOptions = {}): Promise<ProjectRepository> {
  const storage = typeof navigator === "undefined" ? undefined : navigator.storage;
  if (storage === undefined || typeof storage.getDirectory !== "function") throw new Error("この環境では OPFS を使えない");
  const root = await storage.getDirectory();
  return createOpfsProjectRepository(await root.getDirectoryHandle(name, { create: true }), opts);
}

/** `showDirectoryPicker` で選ばせたフォルダを保存先にする。File System Access API が無い環境では reject。 */
export async function pickFsaProjectRepository(opts: RepositoryOptions = {}): Promise<ProjectRepository> {
  const picker = (globalThis as { showDirectoryPicker?: (o?: { mode?: "read" | "readwrite" }) => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker;
  if (typeof picker !== "function") throw new Error("この環境ではフォルダを選べない（File System Access API 非対応）");
  return createFsaProjectRepository(await picker({ mode: "readwrite" }), opts);
}
