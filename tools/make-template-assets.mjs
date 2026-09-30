#!/usr/bin/env node
/**
 * 新規プロジェクトのテンプレート（packages/project-store/src/template-assets.ts）に埋め込む画像を、
 * デモプロジェクトのアセットから作り直す。デモの画像を変えたときだけ実行する。
 *
 *   node tools/make-template-assets.mjs
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const read = (name) => {
  const bytes = readFileSync(join(root, "fixtures/projects/v1/demo/assets", name));
  return { bytes, id: createHash("sha256").update(bytes).digest("hex").slice(0, 16) };
};
const tileset = read("b9b596c2f04468ac.png");
const walk = read("bb2e23b45d1f4d4d.png");
if (tileset.id !== "b9b596c2f04468ac" || walk.id !== "bb2e23b45d1f4d4d") throw new Error("デモのアセット名が内容ハッシュと一致しない");
writeFileSync(
  join(root, "packages/project-store/src/template-assets.ts"),
  `// 生成物：tools/make-template-assets.mjs（デモの tileset / walk 画像を base64 で埋め込む）。手で編集しない。
export const TEMPLATE_TILESET_ID = "${tileset.id}";
export const TEMPLATE_WALK_ID = "${walk.id}";
export const TEMPLATE_TILESET_BASE64 = "${tileset.bytes.toString("base64")}";
export const TEMPLATE_WALK_BASE64 = "${walk.bytes.toString("base64")}";
`,
);
console.log("template-assets.ts を更新した");
