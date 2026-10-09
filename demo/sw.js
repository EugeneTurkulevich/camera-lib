// Модульний service worker стенда (реєструється з { type: "module" }):
// кешує оболонку для роботи офлайн. Фото й відео сюди не потрапляють, вони
// лежать в IndexedDB (media-store.js).
//
// Scope цього файла — demo/, але це обмежує лише ті сторінки, яких SW
// торкається. Підресурси сторінки під контролем (в т.ч. ../lib/*.js) йдуть
// через його fetch-обробник незалежно від свого шляху й кешуються так само.

import { BUILD_STAMP } from "./version.js";

const CACHE = "camera-test-" + BUILD_STAMP;

const SHELL = [
  "./",
  "index.html",
  "manifest.webmanifest",
  "version.js",
  "demo.js",
  "media-store.js",
  "../lib/index.js",
  "../lib/camera-session.js",
  "../lib/camera-prefs.js",
  "../lib/capture.js",
  "../lib/recorder.js",
  "icons/camera.svg",
];

// lib.dom не має типів service worker-а: глобал і події читаємо як any.
const sw = /** @type {any} */ (self);
const shellUrls = new Set(SHELL.map((p) => new URL(p, sw.location.href).href));

sw.addEventListener("install", (/** @type {any} */ event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll([...shellUrls].map((u) => new Request(u, { cache: "reload" }))))
      .then(() => sw.skipWaiting()),
  );
});

sw.addEventListener("activate", (/** @type {any} */ event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("camera-test-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => sw.clients.claim()),
  );
});

sw.addEventListener("fetch", (/** @type {any} */ event) => {
  const req = /** @type {Request} */ (event.request);
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  url.search = "";
  url.hash = "";
  if (!shellUrls.has(url.href)) return; // решта — мережа
  event.respondWith(
    caches.open(CACHE).then((cache) => cache.match(url.href).then((hit) => hit ?? fetch(req))),
  );
});
