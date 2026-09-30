import { SW_REGISTER } from "./service-worker.js";

/** 単一 HTML に埋め込むゲーム一式（プレイヤーの `PlayerConfig.embedded` と同じ形）。 */
export interface EmbeddedGame {
  project: unknown;
  maps: Record<string, unknown>;
  /** AssetId → base64 */
  assets: Record<string, string>;
  /** `project.json`（書き出したバイト列）の sha256（hex）。フォルダ形式と同じ値になる。 */
  projectHash: string;
}

const escapeHtml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const STYLE = `html, body { margin: 0; height: 100%; background: #111; overscroll-behavior: none; }
#app { min-height: 100%; display: flex; flex-direction: column; justify-content: center; }`;

/** 書き出しで選べる描画方式（プレイヤーの `data-renderer` になる）。 */
export type RendererKind = "canvas2d" | "webgl" | "auto";

/** フォルダ形式の `index.html`（`player.js` と `project/project.json` を相対パスで読む）。 */
export function renderIndexHtml(title: string, renderer: RendererKind = "auto", offline = false): string {
  return `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>${escapeHtml(title)}</title>
    <style>
${STYLE}
    </style>
  </head>
  <body>
    <div id="app" data-renderer="${renderer}"></div>
    <script type="module" src="player.js"></script>${offline ? `\n    ${SW_REGISTER}` : ""}
  </body>
</html>
`;
}

/**
 * 単一 HTML：ゲームの JSON（`<script type="application/json" id="rpg-embedded">`）とプレイヤー（インラインの module スクリプト）を
 * 1 ファイルに入れる。外部のファイルは読まない（favicon も `data:` で空にする）。
 * `playerJs` と `embeddedJson` は、それぞれ `escapeForScript` / `escapeJsonForScript` で処理済みであること。
 */
export function renderSingleHtml(title: string, embeddedJson: string, playerJs: string, renderer: RendererKind = "auto"): string {
  return `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <link rel="icon" href="data:," />
    <title>${escapeHtml(title)}</title>
    <style>
${STYLE}
    </style>
  </head>
  <body>
    <div id="app" data-renderer="${renderer}"></div>
    <script type="application/json" id="rpg-embedded">${embeddedJson}</script>
    <script type="module">
${playerJs}
    </script>
  </body>
</html>
`;
}

/** フォルダ形式に同梱する README。 */
export const README_TEXT = `このフォルダは cc-rpg-maker で書き出したゲームです。

遊び方
  静的ファイルを配信できるサーバ（GitHub Pages、Netlify、S3 など）に、このフォルダの中身をそのまま置いて
  index.html を開いてください。ファイルを直接開く（file://）だけでは、ブラウザの制限で動かないことがあります。
  1 ファイルで配りたいときは、エディタの「配布物を書き出す」で「単一 HTML」を選んでください。

構成
  index.html            起動ページ
  player.js             プレイヤー本体
  project/project.json  ゲームの定義
  project/maps/         マップ
  assets/               画像・音声（ファイル名は内容のハッシュ）

キャッシュ
  assets/ の中のファイル名は内容のハッシュなので、中身が変わらない限り同じ名前です。
  配信するときは assets/ に「Cache-Control: public, max-age=31536000, immutable」を付けると、2 回目以降が速くなります。
  index.html と project/ は更新されるので、長くキャッシュしないでください。
`;
