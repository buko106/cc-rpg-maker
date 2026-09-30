import { createIdbProjectRepository, openOpfsProjectRepository, pickFsaProjectRepository } from "@rpg/project-store";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import type { Storage } from "./App.js";
import { createBrowserEnv } from "./browser-env.js";
import "./styles.css";

/**
 * ブラウザのエントリポイント（`editor.js`）。プロジェクトの保存先は既定では IndexedDB。
 * `?storage=opfs` を付けると、ブラウザの私有ファイルシステム（OPFS）に、フォルダ形式（project.json + maps/ + assets/）で保存する。
 * File System Access API があるブラウザでは、一覧の「フォルダを選ぶ…」で、利用者のフォルダを保存先にできる（このタブの間だけ有効）。
 */
const root = document.getElementById("app");
if (root === null) throw new Error("#app が無い");

async function openStorage(): Promise<Storage> {
  if (new URLSearchParams(location.search).get("storage") === "opfs") return { repo: await openOpfsProjectRepository(), label: "ブラウザ内のファイル（OPFS）" };
  return { repo: await createIdbProjectRepository(), label: "ブラウザ内（IndexedDB）" };
}

const canPickFolder = typeof (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker === "function";
const pickFolder = async (): Promise<Storage> => ({ repo: await pickFsaProjectRepository(), label: "選んだフォルダ" });

void Promise.all([createBrowserEnv(), openStorage()]).then(([env, storage]) =>
  createRoot(root).render(<App env={env} repo={storage.repo} storageLabel={storage.label} {...(canPickFolder ? { pickFolder } : {})} />),
);
