import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { cruise, type IConfiguration, type ICruiseOptions } from "dependency-cruiser";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error -- .mjs（型宣言なし）
import { checkManifests } from "./check-manifests.mjs";

const require = createRequire(import.meta.url);
const rules = require("./dependency-rules.cjs") as typeof import("./dependency-rules.cjs");
const { options: baseOptions, ...ruleSet } = require("../.dependency-cruiser.cjs") as IConfiguration & {
  options: ICruiseOptions;
};
const { LOCATIONS, NAMES, isAllowed } = rules;

const write = (root: string, path: string, content: string): void => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
};

/** ルール検査を、実ソースではなく合成したツリーに対して実行する。 */
async function cruiseTree(root: string, files: Record<string, string>) {
  for (const dir of ["packages", "apps"]) mkdirSync(join(root, dir), { recursive: true });
  for (const [path, content] of Object.entries(files)) write(root, path, content);
  // 合成ツリーには tsconfig が無いので、tsConfig 以外は本物の設定をそのまま使う
  const { tsConfig: _tsConfig, ...options } = baseOptions;
  const result = await cruise(["packages", "apps"], { ...options, ruleSet, validate: true, baseDir: root });
  if (typeof result.output === "string") throw new Error("unexpected string output");
  return result.output.summary.violations;
}

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "rpg-deps-"));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("dependency rules (docs/00-principles.md §2)", () => {
  it("flags exactly the forbidden package pairs", async () => {
    const files: Record<string, string> = {};
    for (const name of NAMES) files[`${LOCATIONS[name]}/${name}/src/index.ts`] = "export const x = 1;\n";
    const expected = new Set<string>();
    for (const from of NAMES) {
      for (const to of NAMES) {
        if (from === to) continue;
        const target = `import { x } from "../../../${LOCATIONS[to]}/${to}/src/index";\nexport const y = x;\n`;
        files[`${LOCATIONS[from]}/${from}/src/to-${to}.ts`] = target;
        files[`${LOCATIONS[from]}/${from}/src/to-${to}.test.ts`] = target;
        if (!isAllowed(from, to)) expected.add(`${from} -> ${to}`);
        if (!isAllowed(from, to, { test: true })) expected.add(`${from} (test) -> ${to}`);
      }
    }

    const violations = await cruiseTree(root, files);
    const actual = new Set(
      violations
        .filter((v) => v.rule.name.startsWith("package-deps-"))
        .map((v) => {
          const to = /^(?:packages|apps)\/([^/]+)\//.exec(v.to)?.[1];
          const from = v.rule.name.slice("package-deps-".length);
          return from.endsWith("-tests") ? `${from.slice(0, -"-tests".length)} (test) -> ${to}` : `${from} -> ${to}`;
        }),
    );
    expect(actual).toEqual(expected);
    // 循環（例: 相互に禁止された 2 パッケージ）は別ルールでも検出されるが、許可された関係だけのツリーでは出ない
    expect(expected.size).toBeGreaterThan(0);
  });

  it("flags a deep import into another package's internals", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rpg-deps-deep-"));
    try {
      const violations = await cruiseTree(dir, {
        "packages/schema/src/index.ts": 'export * from "./internal";\n',
        "packages/schema/src/internal.ts": "export const secret = 1;\n",
        "packages/core/src/index.ts": 'import { secret } from "../../schema/src/internal";\nexport const y = secret;\n',
      });
      expect(violations.map((v) => v.rule.name)).toEqual(["only-public-entry"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("allows imports through the public entry of an allowed package", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rpg-deps-ok-"));
    try {
      const violations = await cruiseTree(dir, {
        "packages/schema/src/index.ts": "export const x = 1;\n",
        "packages/core/src/index.ts": 'import { x } from "../../schema/src/index";\nexport const y = x;\n',
      });
      expect(violations).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("flags unresolvable imports", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rpg-deps-unresolved-"));
    try {
      const violations = await cruiseTree(dir, {
        "packages/core/src/index.ts": 'import { x } from "@rpg/does-not-exist";\nexport const y = x;\n',
      });
      expect(violations.map((v) => v.rule.name)).toContain("not-to-unresolvable");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("package manifests", () => {
  const manifest = (name: string, deps: Record<string, string> = {}) =>
    JSON.stringify({ name: `@rpg/${name}`, dependencies: deps });

  function scaffold(overrides: Record<string, string> = {}): string {
    const dir = mkdtempSync(join(tmpdir(), "rpg-manifests-"));
    for (const name of NAMES) write(dir, `${LOCATIONS[name]}/${name}/package.json`, manifest(name));
    for (const [path, content] of Object.entries(overrides)) write(dir, path, content);
    return dir;
  }

  it("accepts the real repository", () => {
    expect(checkManifests(join(import.meta.dirname, ".."))).toEqual([]);
  });

  it("allows test-utils only as a devDependency", () => {
    const dev = scaffold({
      "packages/schema/package.json": JSON.stringify({ name: "@rpg/schema", devDependencies: { "@rpg/test-utils": "workspace:*" } }),
    });
    const prod = scaffold({
      "packages/schema/package.json": JSON.stringify({ name: "@rpg/schema", dependencies: { "@rpg/test-utils": "workspace:*" } }),
    });
    try {
      expect(checkManifests(dev)).toEqual([]);
      expect(checkManifests(prod)).toEqual([expect.stringContaining("@rpg/test-utils")]);
    } finally {
      rmSync(dev, { recursive: true, force: true });
      rmSync(prod, { recursive: true, force: true });
    }
  });

  it("rejects a forbidden @rpg dependency", () => {
    const dir = scaffold({ "packages/schema/package.json": manifest("schema", { "@rpg/core": "workspace:*" }) });
    try {
      expect(checkManifests(dir)).toEqual([expect.stringContaining("@rpg/core")]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects an unregistered package and a wrong package name", () => {
    const dir = scaffold({
      "packages/mystery/package.json": manifest("mystery"),
      "packages/core/package.json": JSON.stringify({ name: "core" }),
    });
    try {
      const errors = checkManifests(dir);
      expect(errors).toHaveLength(2);
      expect(errors.join("\n")).toContain("mystery");
      expect(errors.join("\n")).toContain('"@rpg/core"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
