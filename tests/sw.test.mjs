import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../sw.js", import.meta.url), "utf8");
const SW_VERSION = source.match(/const SW_VERSION = "([^"]+)";/)[1];
const RELEASE = SW_VERSION.replace(/[:.]/g, "-");
const CACHE_NAME = `echo-map-${SW_VERSION}`;

function absoluteKey(input){
  return new URL(typeof input === "string" ? input : input.url, "http://site.test/").href;
}

function createRuntime(publishedVersion, waterbodies = []){
  const listeners = new Map();
  const stores = new Map();
  const requests = [];
  const registry = generatedAt => ({ generatedAt, waterbodies });
  const caches = {
    async open(name){
      if (!stores.has(name)){
        const entries = new Map();
        stores.set(name, {
          entries,
          async put(key, response){ entries.set(absoluteKey(key), response.clone()); },
          async match(key){ return entries.get(absoluteKey(key))?.clone(); },
          async keys(){ return [...entries.keys()].map(url => ({ url })); },
          async delete(key){ return entries.delete(absoluteKey(key)); }
        });
      }
      return stores.get(name);
    },
    async keys(){ return [...stores.keys()]; },
    async delete(name){ return stores.delete(name); }
  };
  const fetch = async input => {
    const url = absoluteKey(input);
    requests.push(url);
    const pathname = new URL(url).pathname;
    if (pathname === "/lakes/index.json"){
      return Response.json(registry(publishedVersion));
    }
    if (pathname === `/lakes/precache/${RELEASE}.json`){
      return Response.json({
        generatedAt:SW_VERSION,
        files:[`lakes/registry/${RELEASE}.json`]
      });
    }
    if (pathname === `/lakes/registry/${RELEASE}.json`){
      return Response.json(registry(SW_VERSION));
    }
    return new Response("asset");
  };
  let skipped = 0;
  const self = {
    location:{ origin:"http://site.test" },
    addEventListener(type, listener){ listeners.set(type, listener); },
    skipWaiting(){ skipped++; }
  };
  vm.runInNewContext(source, { self, caches, fetch, URL, Response, Promise, console });
  return { listeners, stores, caches, requests, skips:() => skipped };
}

function runWaitUntil(listener){
  let result;
  listener({ waitUntil(promise){ result = promise; } });
  return result;
}

function runFetch(listener, request){
  let result;
  listener({ request, respondWith(promise){ result = promise; } });
  return result;
}

test("service worker отклоняет install с несовпавшей опубликованной версией", async () => {
  const runtime = createRuntime(new Date(Date.parse(SW_VERSION) + 60000).toISOString());

  await assert.rejects(
    runWaitUntil(runtime.listeners.get("install")),
    /Published registry version mismatch/
  );
  assert.deepEqual([...runtime.stores.keys()], []);
});

test("service worker связывает cache только со своим immutable registry", async () => {
  const runtime = createRuntime(SW_VERSION);
  await runWaitUntil(runtime.listeners.get("install"));

  const cache = runtime.stores.get(CACHE_NAME);
  assert.ok(cache);
  const stableRegistry = await cache.match("./lakes/index.json");
  assert.deepEqual(await stableRegistry.json(), { generatedAt:SW_VERSION, waterbodies:[] });

  const foreign = await runtime.caches.open("echo-map-foreign");
  await foreign.put("http://site.test/runtime-only", new Response("foreign"));
  const miss = await runFetch(runtime.listeners.get("fetch"), {
    method:"GET",
    url:"http://site.test/runtime-only",
    mode:"cors"
  });
  assert.equal(miss.status, 504);

  const navigation = await runFetch(runtime.listeners.get("fetch"), {
    method:"GET",
    url:"http://site.test/unknown",
    mode:"navigate"
  });
  assert.equal(await navigation.text(), "asset");

  await runWaitUntil(runtime.listeners.get("activate"));
  assert.deepEqual(await runtime.caches.keys(), [CACHE_NAME, "echo-lake-packages"]);
});

test("service worker выходит из ожидания только по явному сообщению", () => {
  const runtime = createRuntime(SW_VERSION);
  const listener = runtime.listeners.get("message");

  listener({ data:null });
  listener({ data:{ type:"ping" } });
  assert.equal(runtime.skips(), 0);

  listener({ data:{ type:"skip-waiting" } });
  assert.equal(runtime.skips(), 1);
});

test("service worker пропускает явную загрузку карты глубин в сеть", async () => {
  const runtime = createRuntime(SW_VERSION);
  await runWaitUntil(runtime.listeners.get("install"));

  const passed = runFetch(runtime.listeners.get("fetch"), {
    method:"GET",
    url:`http://site.test/lakes/test/R1/bathymetry.json?dl=1`,
    mode:"cors"
  });
  assert.equal(passed, undefined, "запрос с ?dl=1 worker не перехватывает");
});

test("service worker отдаёт скачанную карту глубин и чистит мёртвые релизы", async () => {
  const runtime = createRuntime(SW_VERSION, [{ slug:"test", release:"R1" }]);
  await runWaitUntil(runtime.listeners.get("install"));

  const packages = await runtime.caches.open("echo-lake-packages");
  await packages.put("http://site.test/lakes/test/R1/bathymetry.json", new Response("bands"));
  await packages.put("http://site.test/lakes/test/R0/bathymetry.json", new Response("stale"));

  const hit = await runFetch(runtime.listeners.get("fetch"), {
    method:"GET",
    url:"http://site.test/lakes/test/R1/bathymetry.json",
    mode:"cors"
  });
  assert.equal(await hit.text(), "bands");

  await runWaitUntil(runtime.listeners.get("activate"));
  assert.deepEqual(
    (await packages.keys()).map(request => request.url),
    ["http://site.test/lakes/test/R1/bathymetry.json"]
  );
  assert.ok((await runtime.caches.keys()).includes("echo-lake-packages"),
    "cache карт глубин не версионный и живёт между обновлениями оболочки");
});
