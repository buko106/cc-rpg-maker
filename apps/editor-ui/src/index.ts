/**
 * @rpg/editor-ui — エディタ UI（React）。
 *
 * 設計: docs/13-editor-ui.md
 * ブラウザのエントリは main.tsx（`scripts/build-web.mjs` が editor.js にバンドルする）。ここは他から使う部品の公開口。
 */
export { App, AUTOSAVE_MS } from "./App.js";
export type { AppProps } from "./App.js";
export { EnvContext, RepoContext, SessionContext, useEnv, useFormContext, useRepo, useSession } from "./hooks.js";
export type { CommandFormOverrideProps, EditorEnv } from "./hooks.js";
export { startPlaytest } from "./playtest.js";
export type { Playtest, PlaytestDeps, PlaytestStart } from "./playtest.js";
export { describeSchema } from "./schema-form/introspect.js";
export type { FieldSpec } from "./schema-form/introspect.js";
export { SchemaForm } from "./schema-form/SchemaForm.js";
export type { FormContext } from "./schema-form/SchemaForm.js";
export { projectMapForEditor } from "./map/project-map.js";
