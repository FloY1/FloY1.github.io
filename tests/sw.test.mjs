import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const SW_VERSION = "2026-08-06T12:04:00.000Z";
const RELEASE = "2026-08-06T12-04-00-000Z";
const CACHE_NAME = `echo-map-${SW_VERSION}`;
const source = await readFile(new URL("../sw.js", import.meta.url), "utf8");

function absoluteKey(input){
  return new URL(typeof input === "string" ? input : input.url, "http://site.test/").href;
}

function createRuntime(publishedVersion){
  const listeners = new Map();
  const stores = new Map();
  const requests = [];
  const registry = generatedAt => ({ generatedAt, waterbodies:[] });
  const caches = {
    async open(name){
      if (!stores.has(name)){
        const entries = new Map();
        stores.set(name, {
          entries,
          async put(key, response){ entries.set(absoluteKey(key), response.clone()); },
          async match(key){ return entries.get(absoluteKey(key))?.clone(); }
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
  const self = {
    location:{ origin:"http://site.test" },
    addEventListener(type, listener){ listeners.set(type, listener); }
  };
  vm.runInNewContext(source, { self, caches, fetch, URL, Response, Promise, console });
  return { listeners, stores, caches, requests };
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
  const runtime = createRuntime("2026-08-06T12:05:00.000Z");

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
  assert.deepEqual(await runtime.caches.keys(), [CACHE_NAME]);
});
