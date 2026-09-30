import { createIdbProjectRepository, openOpfsProjectRepository } from "@rpg/project-store";
import type { ProjectRepository } from "@rpg/project-store";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { createBrowserEnv } from "./browser-env.js";
import "./styles.css";

/**
 * ブラウザのエントリポイント（`editor.js`）。プロジェクトの保存先は既定では IndexedDB。
 * `?storage=opfs` を付けると、ブラウザの私有ファイルシステム（OPFS）に、フォルダ形式（project.json + maps/ + assets/）で保存する。
 */
const root = document.getElementById("app");
if (root === null) throw new Error("#app が無い");

async function openRepository(): Promise<ProjectRepository> {
  if (new URLSearchParams(location.search).get("storage") === "opfs") return openOpfsProjectRepository();
  return createIdbProjectRepository();
}

void Promise.all([createBrowserEnv(), openRepository()]).then(([env, repo]) => createRoot(root).render(<App env={env} repo={repo} />));
