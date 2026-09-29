// 各パッケージの package.json が、依存ルール（tools/dependency-rules.cjs）に反する
// `@rpg/*` 依存を宣言していないかを検査する。
// devDependencies はテスト用なので、test-utils も許可する。
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import rules from "./dependency-rules.cjs";

const { LOCATIONS, NAMES, isAllowed } = rules;
const DEP_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

/**
 * @param {string} root リポジトリルート
 * @returns {string[]} 違反メッセージ
 */
export function checkManifests(root) {
  const errors = [];

  for (const parent of ["packages", "apps"]) {
    const parentDir = join(root, parent);
    if (!existsSync(parentDir)) continue;
    for (const entry of readdirSync(parentDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      if (LOCATIONS[name] !== parent) {
        errors.push(`${parent}/${name}: 未登録のパッケージ（tools/dependency-rules.cjs に追加する）`);
        continue;
      }
      const manifestPath = join(parentDir, name, "package.json");
      if (!existsSync(manifestPath)) {
        errors.push(`${parent}/${name}: package.json がない`);
        continue;
      }
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (manifest.name !== `@rpg/${name}`) {
        errors.push(`${parent}/${name}: name は "@rpg/${name}" でなければならない（実際: ${manifest.name}）`);
      }
      for (const field of DEP_FIELDS) {
        for (const dep of Object.keys(manifest[field] ?? {})) {
          if (!dep.startsWith("@rpg/")) continue;
          const target = dep.slice("@rpg/".length);
          if (!NAMES.includes(target)) {
            errors.push(`${parent}/${name}: ${field} に未知のパッケージ ${dep}`);
          } else if (!isAllowed(name, target, { test: field === "devDependencies" })) {
            errors.push(`${parent}/${name}: ${field} の ${dep} は依存ルールで許可されていない`);
          }
        }
      }
    }
  }

  for (const name of NAMES) {
    if (!existsSync(join(root, LOCATIONS[name], name))) {
      errors.push(`${LOCATIONS[name]}/${name}: ディレクトリがない`);
    }
  }
  return errors;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const errors = checkManifests(process.cwd());
  if (errors.length > 0) {
    console.error(errors.map((e) => `✗ ${e}`).join("\n"));
    process.exit(1);
  }
  console.log(`✓ ${NAMES.length} パッケージの package.json は依存ルールに適合している`);
}
