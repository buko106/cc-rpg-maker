/** フォルダ形式の配布物に置く Service Worker のファイル名。 */
export const SW_FILE = "sw.js";

/** `index.html` に入れる登録のスクリプト（対応していないブラウザでは何もしない）。 */
export const SW_REGISTER = `<script>if ("serviceWorker" in navigator) navigator.serviceWorker.register("${SW_FILE}").catch(function () {});</script>`;

/**
 * オフラインで動かすための Service Worker のソース。
 * - インストール時に `paths`（配布物のすべてのファイル）をキャッシュへ入れる。キャッシュ名は内容から決めた `version` を含むので、
 *   ゲームを更新して置き直すと新しいキャッシュが作られ、古いものは activate で消える。
 * - 取得はキャッシュ優先、無ければネットワーク。ページ（`./`）はキャッシュの `index.html` を返す。
 * - GET 以外・別オリジンには触らない。
 */
export function renderServiceWorker(paths: readonly string[], version: string): string {
  const urls = ["./", ...paths.filter((p) => p !== SW_FILE)];
  return `/* cc-rpg-maker: オフライン用 Service Worker（書き出しで生成） */
const CACHE = ${JSON.stringify(`rpg-${version}`)};
const FILES = ${JSON.stringify(urls)};

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith("rpg-") && key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(
    caches.open(CACHE).then((cache) =>
      cache.match(request, { ignoreSearch: true }).then((hit) => hit || fetch(request)),
    ),
  );
});
`;
}
