import { createIdbProjectRepository } from "@rpg/project-store";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { createBrowserEnv } from "./browser-env.js";
import "./styles.css";

/** ブラウザのエントリポイント（`editor.js`）。プロジェクトは IndexedDB に保存する。 */
const root = document.getElementById("app");
if (root === null) throw new Error("#app が無い");
void createBrowserEnv().then((env) => createRoot(root).render(<App env={env} repo={createIdbProjectRepository()} />));
