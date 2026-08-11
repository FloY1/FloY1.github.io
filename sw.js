"use strict";

const SW_VERSION = "2026-08-11T09:00:00.000Z";
const CACHE_PREFIX = "echo-map-";
const CACHE_NAME = `${CACHE_PREFIX}${SW_VERSION}`;
const PRECACHE_RELEASE = SW_VERSION.replace(/[:.]/g, "-");
const CORE_FILES = [
  "./",
  "./index.html",
  "./app-core.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./vendor/leaflet/leaflet.css",
  "./vendor/leaflet/leaflet.js",
  "./vendor/leaflet/images/layers.png",
  "./vendor/leaflet/images/layers-2x.png",
  "./vendor/leaflet/images/marker-icon.png",
  "./vendor/leaflet/images/marker-icon-2x.png",
  "./vendor/leaflet/images/marker-shadow.png"
];
async function precacheFiles(cache, files){
  for (let offset = 0; offset < files.length; offset += 12){
    await Promise.all(files.slice(offset, offset + 12).map(async file => {
      const response = await fetch(file, { cache:"reload" });
      if (!response.ok) throw new Error(`Precache asset ${file} HTTP ${response.status}`);
      await cache.put(file, response);
    }));
  }
}
async function requirePublishedVersion(){
  const response = await fetch("./lakes/index.json", { cache:"reload" });
  if (!response.ok) throw new Error(`Lake registry HTTP ${response.status}`);
  const registry = await response.json();
  if (registry.generatedAt !== SW_VERSION) throw new Error("Published registry version mismatch");
}



self.addEventListener("install", event => {
  event.waitUntil((async () => {
    await requirePublishedVersion();
    const cache = await caches.open(CACHE_NAME);
    await precacheFiles(cache, CORE_FILES);
    const response = await fetch(`./lakes/precache/${PRECACHE_RELEASE}.json`, { cache:"reload" });
    if (!response.ok) throw new Error(`Precache manifest HTTP ${response.status}`);
    const manifest = await response.json();
    if (!Array.isArray(manifest.files)) throw new Error("Invalid precache manifest");
    await precacheFiles(cache, manifest.files.map(file => `./${file}`));
    const registryUrl = `./lakes/registry/${PRECACHE_RELEASE}.json`;
    const registryResponse = await cache.match(registryUrl);
    if (!registryResponse) throw new Error("Versioned lake registry is missing");
    const registry = await registryResponse.clone().json();
    if (registry.generatedAt !== SW_VERSION) throw new Error("Lake registry version mismatch");
    await cache.put("./lakes/index.json", registryResponse);
    await requirePublishedVersion();
  })());
});

self.addEventListener("message", event => {
  if (event.data && event.data.type === "skip-waiting") self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
      .map(name => caches.delete(name)));
  })());
});

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(event.request);
    if (cached) return cached;
    if (event.request.mode === "navigate") return cache.match("./index.html");
    return new Response("Asset is not precached", {
      status:504,
      headers:{ "content-type":"text/plain; charset=utf-8" }
    });
  })());
});
