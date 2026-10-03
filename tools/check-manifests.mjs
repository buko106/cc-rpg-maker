// 各パッケージの package.json が、依存ルール（tools/dependency-rules.cjs）に反する
// `@rpg/*` 依存を宣言していないかを検査する。
// devDependencies はテスト用なので、test-utils も許可する。
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import rules from "./dependency-rules.cjs";

const { ROOTS, NAMES, isAllowed, pathOf, nameAt } = rules;
const DEP_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

/**
 * @param {string} root リポジトリルート
 * @returns {string[]} 違反メッセージ
 */
export function checkManifests(root) {
  const errors = [];

  for (const parent of ROOTS) {
    const parentDir = join(root, parent);
    if (!existsSync(parentDir)) continue;
    for (const entry of readdirSync(parentDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dirPath = `${parent}/${entry.name}`;
      const name = nameAt(parent, entry.name);
      if (name === undefined) {
        errors.push(`${dirPath}: 未登録のパッケージ（tools/dependency-rules.cjs に追加する）`);
        continue;
      }
      const manifestPath = join(parentDir, entry.name, "package.json");
      if (!existsSync(manifestPath)) {
        errors.push(`${dirPath}: package.json がない`);
        continue;
      }
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (manifest.name !== `@rpg/${name}`) {
        errors.push(`${dirPath}: name は "@rpg/${name}" でなければならない（実際: ${manifest.name}）`);
      }
      for (const field of DEP_FIELDS) {
        for (const dep of Object.keys(manifest[field] ?? {})) {
          if (!dep.startsWith("@rpg/")) continue;
          const target = dep.slice("@rpg/".length);
          if (!NAMES.includes(target)) {
            errors.push(`${dirPath}: ${field} に未知のパッケージ ${dep}`);
          } else if (!isAllowed(name, target, { test: field === "devDependencies" })) {
            errors.push(`${dirPath}: ${field} の ${dep} は依存ルールで許可されていない`);
          }
        }
      }
    }
  }

  for (const name of NAMES) {
    if (!existsSync(join(root, pathOf(name)))) {
      errors.push(`${pathOf(name)}: ディレクトリがない`);
    }
  }
  errors.push(...checkExternalVersions(root));
  return errors;
}

/**
 * 外部依存のバージョンが exact 指定で、workspace 間で食い違っていないかを検査する。
 * @param {string} root リポジトリルート
 * @returns {string[]} 違反メッセージ
 */
export function checkExternalVersions(root) {
  const errors = [];
  /** @type {Map<string, Map<string, string[]>>} 依存名 → バージョン → 宣言元 */
  const seen = new Map();
  const manifests = existsSync(join(root, "package.json")) ? ["package.json"] : [];
  for (const parent of ROOTS) {
    const parentDir = join(root, parent);
    if (!existsSync(parentDir)) continue;
    for (const entry of readdirSync(parentDir, { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(parentDir, entry.name, "package.json"))) {
        manifests.push(`${parent}/${entry.name}/package.json`);
      }
    }
  }
  for (const path of manifests) {
    const manifest = JSON.parse(readFileSync(join(root, path), "utf8"));
    for (const field of DEP_FIELDS) {
      if (field === "peerDependencies") continue;
      for (const [dep, version] of Object.entries(manifest[field] ?? {})) {
        if (dep.startsWith("@rpg/")) continue;
        if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
          errors.push(`${path}: ${field} の ${dep} は exact version でなければならない（実際: ${version}）`);
        }
        const byVersion = seen.get(dep) ?? new Map();
        byVersion.set(version, [...(byVersion.get(version) ?? []), path]);
        seen.set(dep, byVersion);
      }
    }
  }
  for (const [dep, byVersion] of seen) {
    if (byVersion.size > 1) {
      const detail = [...byVersion].map(([v, paths]) => `${v} (${paths.join(", ")})`).join(" / ");
      errors.push(`${dep}: workspace 間でバージョンが食い違っている: ${detail}`);
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
