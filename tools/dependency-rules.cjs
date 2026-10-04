/**
 * パッケージ間の依存ルール（docs/00-principles.md §2）の単一情報源。
 * `.dependency-cruiser.cjs`（ソースの import 検査）と
 * `tools/check-manifests.mjs`（package.json の dependencies 検査）が共有する。
 *
 * ドキュメントの依存ルールを変更するときは、このファイルを同時に更新すること。
 */

/**
 * パッケージを置くルートのディレクトリ（`<root>/<name>/`）。
 * `packages/`：ライブラリ（プラグインの土台 `plugin-api` を含む）、`plugins/`：プラグインの実装、`apps/`：アプリ。
 */
const ROOTS = ["packages", "plugins", "apps"];

/** パッケージ名 → 置き場所（ディレクトリ）。名前空間は `@rpg/<name>`。 */
const LOCATIONS = {
  schema: "packages",
  core: "packages",
  runtime: "packages",
  "render-canvas2d": "packages",
  "render-webgl": "packages",
  "render-dom": "packages",
  "render-null": "packages",
  "audio-webaudio": "packages",
  "audio-null": "packages",
  "input-browser": "packages",
  "input-script": "packages",
  assets: "packages",
  "project-store": "packages",
  exporter: "packages",
  "save-store": "packages",
  "editor-core": "packages",
  "plugin-api": "packages",
  bot: "packages",
  "plugin-samples": "plugins",
  "plugin-dungeon": "plugins",
  "plugin-fishing": "plugins",
  "test-utils": "packages",
  "editor-ui": "apps",
  player: "apps",
};

/** 「任意のアダプタ」に含まれるパッケージ。 */
const ADAPTERS = [
  "render-canvas2d",
  "render-webgl",
  "render-dom",
  "render-null",
  "audio-webaudio",
  "audio-null",
  "input-browser",
  "input-script",
  "assets",
  "project-store",
  "save-store",
];

/**
 * パッケージ → import してよいパッケージ。
 * `"*"` は「任意」（test-utils のみ）。
 */
const ALLOWED = {
  schema: [],
  core: ["schema"],
  runtime: ["core", "schema"],
  "render-canvas2d": ["runtime"],
  "render-webgl": ["runtime"],
  "render-dom": ["runtime"],
  "render-null": ["runtime"],
  "audio-webaudio": ["runtime"],
  "audio-null": ["runtime"],
  "input-browser": ["runtime"],
  "input-script": ["runtime"],
  assets: ["runtime"],
  "project-store": ["schema"],
  exporter: ["schema", "project-store"],
  "save-store": ["core", "runtime"],
  "editor-core": ["schema", "core", "project-store"],
  "plugin-api": ["core", "runtime", "editor-core"],
  bot: ["core", "schema"],
  "plugin-samples": ["plugin-api"],
  "plugin-dungeon": ["plugin-api"],
  "plugin-fishing": ["plugin-api"],
  "editor-ui": ["editor-core", "runtime", "plugin-api", "plugin-samples", "plugin-dungeon", "plugin-fishing", "schema", "core", "exporter", ...ADAPTERS],
  player: ["runtime", "plugin-api", "plugin-samples", "plugin-dungeon", "plugin-fishing", "schema", ...ADAPTERS],
  "test-utils": "*",
};

const NAMES = Object.keys(LOCATIONS);

/** パッケージ名 → ディレクトリ名。`plugins/` の下では、接頭辞 `plugin-` を省く（`@rpg/plugin-dungeon` → `plugins/dungeon/`）。 */
const dirName = (name) => (LOCATIONS[name] === "plugins" ? name.replace(/^plugin-/, "") : name);

/** パッケージ名 → リポジトリルートからのパス（`packages/core`・`plugins/dungeon` など）。 */
const pathOf = (name) => `${LOCATIONS[name]}/${dirName(name)}`;

/** `pathOf` の逆引き。`root`（`packages` など）と `dir`（ディレクトリ名）から、パッケージ名を返す（無ければ `undefined`）。 */
const nameAt = (root, dir) => NAMES.find((n) => LOCATIONS[n] === root && dirName(n) === dir);

/** テストコード（`*.test.ts`）だけが、許可関係に加えて import してよいパッケージ。 */
const TEST_SUPPORT = "test-utils";

/**
 * `from` が `to` を import してよいか。
 * `test: true` はテストファイル（`*.test.ts`）からの import で、`test-utils` が追加で許可される。
 */
function isAllowed(from, to, { test = false } = {}) {
  if (from === to) return true;
  if (test && to === TEST_SUPPORT) return true;
  const allowed = ALLOWED[from];
  return allowed === "*" || allowed.includes(to);
}

/** `from` が import してよいパッケージ一覧（自分自身を除く）。 */
function allowedOf(from) {
  const allowed = ALLOWED[from];
  return allowed === "*" ? NAMES.filter((n) => n !== from) : [...allowed];
}

module.exports = { dirName, pathOf, nameAt, ROOTS, LOCATIONS, ADAPTERS, ALLOWED, NAMES, TEST_SUPPORT, isAllowed, allowedOf };
