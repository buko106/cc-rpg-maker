/**
 * パッケージ間の依存ルール（docs/00-principles.md §2）の単一情報源。
 * `.dependency-cruiser.cjs`（ソースの import 検査）と
 * `tools/check-manifests.mjs`（package.json の dependencies 検査）が共有する。
 *
 * ドキュメントの依存ルールを変更するときは、このファイルを同時に更新すること。
 */

/** パッケージ名 → 置き場所（ディレクトリ）。名前空間は `@rpg/<name>`。 */
const LOCATIONS = {
  schema: "packages",
  core: "packages",
  runtime: "packages",
  "render-canvas2d": "packages",
  "render-webgl": "packages",
  "render-null": "packages",
  "audio-webaudio": "packages",
  "audio-null": "packages",
  "input-browser": "packages",
  "input-script": "packages",
  assets: "packages",
  "project-store": "packages",
  "save-store": "packages",
  "editor-core": "packages",
  "plugin-api": "packages",
  "test-utils": "packages",
  "editor-ui": "apps",
  player: "apps",
};

/** 「任意のアダプタ」に含まれるパッケージ。 */
const ADAPTERS = [
  "render-canvas2d",
  "render-webgl",
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
  "render-null": ["runtime"],
  "audio-webaudio": ["runtime"],
  "audio-null": ["runtime"],
  "input-browser": ["runtime"],
  "input-script": ["runtime"],
  assets: ["runtime"],
  "project-store": ["schema"],
  "save-store": ["core"],
  "editor-core": ["schema", "project-store"],
  "plugin-api": ["core", "runtime", "editor-core"],
  "editor-ui": ["editor-core", "runtime", "plugin-api", ...ADAPTERS],
  player: ["runtime", "plugin-api", ...ADAPTERS],
  "test-utils": "*",
};

const NAMES = Object.keys(LOCATIONS);

/** `from` が `to` を import してよいか。 */
function isAllowed(from, to) {
  if (from === to) return true;
  const allowed = ALLOWED[from];
  return allowed === "*" || allowed.includes(to);
}

/** `from` が import してよいパッケージ一覧（自分自身を除く）。 */
function allowedOf(from) {
  const allowed = ALLOWED[from];
  return allowed === "*" ? NAMES.filter((n) => n !== from) : [...allowed];
}

module.exports = { LOCATIONS, ADAPTERS, ALLOWED, NAMES, isAllowed, allowedOf };
