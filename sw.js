/* ============================================================
   AXONOM — sw.js（Service Worker）
   キャッシュ戦略：
   - アプリ本体（同一オリジン）…… キャッシュ優先＋裏で更新
   - CDN（フォント・ライブラリ）… キャッシュ優先（取得後に保存）
   バージョンを上げると旧キャッシュは activate 時に破棄される。
   ============================================================ */

const CACHE_NAME = "axonom-v7";

/* インストール時に確保しておくアプリの骨格 */
const APP_SHELL = [
  "./",
  "./index.html",
  "./editor.html",
  "./manifest.json",
  "./css/global.css",
  "./css/home.css",
  "./css/editor.css",
  "./js/home.js",
  "./js/editor.js",
  "./js/export.js",
  "./js/theme.js",
  "./assets/icons/icon.svg",
  "./assets/icons/icon-maskable.svg",
  "./assets/themes/themes.json",
];

/* ---- install：アプリの骨格を先読みキャッシュ ---------------- */
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

/* ---- activate：旧バージョンのキャッシュを掃除 ---------------- */
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(
          keys.filter((key) => key !== CACHE_NAME)
              .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

/* ---- fetch：キャッシュ優先で応答し、無ければ取得して保存 ------ */
self.addEventListener("fetch", (event) => {
  /* GET以外（POST等）はキャッシュ対象外 */
  if (event.request.method !== "GET") return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) {
        /* キャッシュ即返し。裏側でこっそり最新版に更新しておく
           （オフライン時の失敗は無視してよい） */
        fetch(event.request)
          .then((response) => {
            if (response && response.ok) {
              caches.open(CACHE_NAME)
                .then((cache) => cache.put(event.request, response));
            }
          })
          .catch(() => {});
        return cached;
      }

      /* キャッシュに無いものはネットワークから取得して保存する */
      return fetch(event.request).then((response) => {
        if (response && (response.ok || response.type === "opaque")) {
          const copy = response.clone();
          caches.open(CACHE_NAME)
            .then((cache) => cache.put(event.request, copy));
        }
        return response;
      });
    })
  );
});
