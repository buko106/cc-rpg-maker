/**
 * 依存ルール検査の設定（docs/00-principles.md §2）。
 * パッケージ間の許可関係は tools/dependency-rules.cjs から生成する。
 */
const { LOCATIONS, NAMES, TEST_SUPPORT, allowedOf } = require("./tools/dependency-rules.cjs");

const dir = (name) => `${LOCATIONS[name]}/${name}`;

const TEST_FILE = "\\.test\\.tsx?$";

/**
 * パッケージごとに「許可されていない他パッケージへの依存」を禁止するルール。
 * テストファイル（*.test.ts）だけは、許可関係に加えて test-utils を import できる。
 */
const packageRules = NAMES.filter((name) => allowedOf(name).length < NAMES.length - 1).flatMap((name) => {
  const permitted = (extra) => [name, ...allowedOf(name), ...extra].map((n) => `${dir(n)}/`).join("|");
  return [
    {
      name: `package-deps-${name}`,
      comment: `@rpg/${name} は docs/00-principles.md の依存ルールで許可されたパッケージ以外を import してはならない。`,
      severity: "error",
      from: { path: `^${dir(name)}/`, pathNot: TEST_FILE },
      to: { path: `^(packages|apps)/`, pathNot: `^(${permitted([])})` },
    },
    {
      name: `package-deps-${name}-tests`,
      comment: `@rpg/${name} のテストは、許可されたパッケージと ${TEST_SUPPORT} 以外を import してはならない。`,
      severity: "error",
      from: { path: `^${dir(name)}/.*${TEST_FILE}` },
      to: { path: `^(packages|apps)/`, pathNot: `^(${permitted([TEST_SUPPORT])})` },
    },
  ];
});

module.exports = {
  forbidden: [
    ...packageRules,
    {
      name: "only-public-entry",
      comment: "他パッケージは公開エントリ（src/index.ts）経由でのみ import する。内部実装に依存してはならない。",
      severity: "error",
      from: { path: "^(?:packages|apps)/([^/]+)/" },
      to: {
        path: "^(?:packages|apps)/[^/]+/",
        pathNot: ["^(?:packages|apps)/$1/", "^(?:packages|apps)/[^/]+/src/index\\.ts$"],
      },
    },
    {
      name: "no-circular",
      comment: "循環依存を禁止する。",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    {
      name: "not-to-unresolvable",
      comment: "解決できない import を禁止する（依存の宣言漏れ・typo 検出）。",
      severity: "error",
      from: {},
      to: { couldNotResolve: true },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    // `import type` も依存として数える（ポート型だけの依存も依存ルールの対象）
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.typecheck.json" },
    exclude: { path: "(^|/)dist/" },
  },
};
