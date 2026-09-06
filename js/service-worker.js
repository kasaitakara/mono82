const CACHE_NAME = "sprooto-cache-v5";

const APP_SHELL = [
  "./",
  "./index.html",

  "./css/style.css",

  "./fonts/IBMPlexMono-Regular.ttf",
  "./fonts/IBMPlexMono-Regular.woff2",
  "./fonts/Saira-VariableFont_wdth,wght.ttf",

  "./js/main.js",
  "./js/audio.js",
  "./js/export.js",
  "./js/keyboard-navigation.js",
  "./js/sequencer.js",
  "./js/sound-defaults.js",
  "./js/sound-preset-manager.js",
  "./js/sound-presets.js",
  "./js/storage.js",
  "./js/ui.js"
];


/**
 * install
 * sprooto本体に必要なファイルをすべてcacheへ保存する。
 */
self.addEventListener("install", event => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
  );

  self.skipWaiting();
});


/**
 * activate
 * 古いsprooto cacheを削除する。
 */
self.addEventListener("activate", event => {
  event.waitUntil(
    caches
      .keys()
      .then(cacheNames =>
        Promise.all(
          cacheNames
            .filter(
              name =>
                name.startsWith("sprooto-cache-") &&
                name !== CACHE_NAME
            )
            .map(name => caches.delete(name))
        )
      )
      .then(() => self.clients.claim())
  );
});


/**
 * fetch
 *
 * online:
 * networkから最新版を取得し、cacheも更新。
 *
 * offline:
 * 保存済みcacheから返す。
 */
self.addEventListener("fetch", event => {
  const request = event.request;

  if (request.method !== "GET") {
    return;
  }

  const url = new URL(request.url);

  if (url.origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    fetch(request)
      .then(response => {
        if (
          !response ||
          response.status !== 200
        ) {
          return response;
        }

        const copy = response.clone();

        caches
          .open(CACHE_NAME)
          .then(cache => {
            cache.put(request, copy);
          });

        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request);

        if (cached) {
          return cached;
        }

        if (request.mode === "navigate") {
          return caches.match("./index.html");
        }

        throw new Error("offline resource unavailable");
      })
  );
});