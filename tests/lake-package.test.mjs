import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import {
  bboxFromGeometry,
  tilesForBbox,
  fetchOsmBoundary,
  buildLakePackage,
  restampShell
} from "../tools/lake-package.mjs";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+XqG6WQAAAABJRU5ErkJggg==",
  "base64"
);

const boundary = {
  type:"Polygon",
  coordinates:[[[-1,-1],[1,-1],[1,1],[-1,1],[-1,-1]]]
};

test("bboxFromGeometry вычисляет bbox GeoJSON в порядке lon lat", () => {
  assert.deepEqual(bboxFromGeometry(boundary), [-1,-1,1,1]);
});

test("tilesForBbox возвращает покрытие XYZ без пропусков", () => {
  assert.deepEqual(tilesForBbox([-10,-10,10,10], 1), [
    { z:1, x:0, y:0 },
    { z:1, x:0, y:1 },
    { z:1, x:1, y:0 },
    { z:1, x:1, y:1 }
  ]);
});

test("fetchOsmBoundary получает Polygon по OSM relation id", async t => {
  let observed = null;
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    observed = {
      path:url.pathname,
      osmIds:url.searchParams.get("osm_ids"),
      format:url.searchParams.get("format"),
      polygon:url.searchParams.get("polygon_geojson")
    };
    response.writeHead(200, { "content-type":"application/json" });
    response.end(JSON.stringify([{ osm_id:123, geojson:boundary }]));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;

  const geometry = await fetchOsmBoundary("R123", {
    endpoint:`http://127.0.0.1:${port}/lookup`
  });

  assert.deepEqual(geometry, boundary);
  assert.deepEqual(observed, {
    path:"/lookup",
    osmIds:"R123",
    format:"jsonv2",
    polygon:"1"
  });
});

test("buildLakePackage скачивает PNG с авторизацией и создаёт воспроизводимый пакет", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lake-package-"));
  t.after(() => rm(root, { recursive:true, force:true }));
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({ url:request.url, authorization:request.headers.authorization, origin:request.headers.origin });
    response.writeHead(200, { "content-type":"image/png" });
    response.end(PNG_1X1);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;

  const serviceWorkerPath = path.join(root, "sw.js");
  await writeFile(serviceWorkerPath, '"use strict";\nconst SW_VERSION = "base";\n');
  const options = {
    slug:"demo-lake",
    name:"Демо-озеро",
    type:"lake",
    boundary,
    zoom:0,
    config:"dev-config",
    token:"dev-token",
    outputRoot:path.join(root, "lakes"),
    endpoint:`http://127.0.0.1:${port}/tile/{z}/{x}/{y}`,
    generatedAt:"2026-08-06T00:00:00.000Z",
    serviceWorkerPath,
  };
  const firstRelease = "2026-08-06T00-00-00-000Z";
  const firstPackage = path.join(root, "lakes/demo-lake", firstRelease);
  const result = await buildLakePackage(options);

  assert.equal(result.tileCount, 1);
  assert.deepEqual(requests, [{
    url:"/tile/0/0/0?config=dev-config&transparent=true&du=1&layer=1",
    authorization:"Bearer dev-token",
    origin:"https://by.fishermap.org"
  }]);
  assert.deepEqual(await readFile(path.join(firstPackage, "tiles/0/0/0.png")), PNG_1X1);
  const manifestText = await readFile(path.join(firstPackage, "lake.json"), "utf8");
  const manifest = JSON.parse(manifestText);
  assert.equal(manifest.release, firstRelease);
  assert.deepEqual(manifest.bbox, [-1,-1,1,1]);
  assert.deepEqual(manifest.center, [0,0]);
  assert.equal(manifest.minZoom, 0);
  assert.equal(manifest.maxZoom, 0);
  const registryPath = path.join(root, "lakes/index.json");
  const registryText = await readFile(registryPath, "utf8");
  const registrySnapshotPath = path.join(root, "lakes/registry", `${firstRelease}.json`);
  assert.equal(await readFile(registrySnapshotPath, "utf8"), registryText);
  const registry = JSON.parse(registryText);
  assert.deepEqual(registry.waterbodies.map(item => ({ slug:item.slug, release:item.release })), [
    { slug:"demo-lake", release:firstRelease }
  ]);
  const precachePath = path.join(root, "lakes/precache", `${firstRelease}.json`);
  const precacheText = await readFile(precachePath, "utf8");
  const precache = JSON.parse(precacheText);
  assert.deepEqual(precache.files, [
    `lakes/demo-lake/${firstRelease}/lake.json`,
    `lakes/demo-lake/${firstRelease}/tiles/0/0/0.png`,
    `lakes/precache/${firstRelease}.json`,
    `lakes/registry/${firstRelease}.json`
  ]);
  assert.match(await readFile(serviceWorkerPath, "utf8"), /const SW_VERSION = "2026-08-06T00:00:00.000Z";/);

  const repeated = await buildLakePackage(options);
  assert.equal(repeated.downloaded, 0);
  assert.equal(requests.length, 1);
  assert.equal(await readFile(path.join(firstPackage, "lake.json"), "utf8"), manifestText);
  assert.equal(await readFile(registryPath, "utf8"), registryText);
  assert.equal(await readFile(precachePath, "utf8"), precacheText);
  const normalizedTimestamp = await buildLakePackage({ ...options, generatedAt:"2026-08-06T00:00:00Z" });
  assert.equal(normalizedTimestamp.manifest.generatedAt, "2026-08-06T00:00:00.000Z");
  assert.equal(normalizedTimestamp.downloaded, 0);
  assert.equal(requests.length, 1);

  const staleTile = path.join(firstPackage, "tiles/15/1/1.png");
  await mkdir(path.dirname(staleTile), { recursive:true });
  await writeFile(staleTile, PNG_1X1);
  const updatedOptions = { ...options, generatedAt:"2026-08-06T00:01:00.000Z" };
  const updated = await buildLakePackage(updatedOptions);
  const secondRelease = "2026-08-06T00-01-00-000Z";
  assert.equal(updated.downloaded, 0);
  assert.equal(requests.length, 1);
  assert.deepEqual(
    await readFile(path.join(root, "lakes/demo-lake", secondRelease, "tiles/0/0/0.png")),
    PNG_1X1
  );
  assert.deepEqual(await readFile(staleTile), PNG_1X1);
  await assert.rejects(
    readFile(path.join(root, "lakes/demo-lake", secondRelease, "tiles/15/1/1.png")),
    error => error.code === "ENOENT"
  );
  const updatedRegistryText = await readFile(registryPath, "utf8");
  const updatedRegistry = JSON.parse(updatedRegistryText);
  assert.equal(updatedRegistry.waterbodies[0].release, secondRelease);
  assert.equal(
    await readFile(path.join(root, "lakes/registry", `${secondRelease}.json`), "utf8"),
    updatedRegistryText
  );
  const updatedPrecachePath = path.join(root, "lakes/precache", `${secondRelease}.json`);
  const updatedPrecache = JSON.parse(await readFile(updatedPrecachePath, "utf8"));
  assert.deepEqual(updatedPrecache.files, [
    `lakes/demo-lake/${secondRelease}/lake.json`,
    `lakes/demo-lake/${secondRelease}/tiles/0/0/0.png`,
    `lakes/precache/${secondRelease}.json`,
    `lakes/registry/${secondRelease}.json`
  ]);
  assert.match(await readFile(serviceWorkerPath, "utf8"), /const SW_VERSION = "2026-08-06T00:01:00.000Z";/);

  await assert.rejects(() => buildLakePackage({ ...updatedOptions, concurrency:0 }), /Concurrency must be an integer/);
  await writeFile(registryPath, "{");
  await assert.rejects(() => buildLakePackage(updatedOptions), SyntaxError);
  assert.equal(await readFile(registryPath, "utf8"), "{");
});

test("restampShell выпускает новую версию оболочки, не трогая пакеты", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lake-restamp-"));
  t.after(() => rm(root, { recursive:true, force:true }));
  const outputRoot = path.join(root, "lakes");
  const serviceWorkerPath = path.join(root, "sw.js");
  const packageRelease = "2026-08-06T00-00-00-000Z";
  const packageDir = path.join(outputRoot, "demo-lake", packageRelease);
  await mkdir(path.join(packageDir, "tiles/0/0"), { recursive:true });
  await writeFile(path.join(packageDir, "tiles/0/0/0.png"), PNG_1X1);
  await writeFile(path.join(packageDir, "lake.json"), JSON.stringify({ slug:"demo-lake", release:packageRelease }));
  await writeFile(path.join(outputRoot, "index.json"), JSON.stringify({
    generatedAt:"2026-08-06T00:00:00.000Z",
    waterbodies:[{ slug:"demo-lake", release:packageRelease, name:"Демо-озеро", type:"lake", center:[0,0], bbox:[-1,-1,1,1] }]
  }, null, 2) + "\n");
  await writeFile(serviceWorkerPath, '"use strict";\nconst SW_VERSION = "2026-08-06T00:00:00.000Z";\n');

  const result = await restampShell({
    outputRoot,
    generatedAt:"2026-08-07T10:00:00.000Z",
    serviceWorkerPath
  });

  const shellRelease = "2026-08-07T10-00-00-000Z";
  assert.equal(result.release, shellRelease);
  const registryText = await readFile(path.join(outputRoot, "index.json"), "utf8");
  const registry = JSON.parse(registryText);
  assert.equal(registry.generatedAt, "2026-08-07T10:00:00.000Z");
  assert.deepEqual(registry.waterbodies.map(item => item.release), [packageRelease]);
  assert.equal(await readFile(path.join(outputRoot, "registry", `${shellRelease}.json`), "utf8"), registryText);
  const precache = JSON.parse(await readFile(path.join(outputRoot, "precache", `${shellRelease}.json`), "utf8"));
  assert.deepEqual(precache.files, [
    `lakes/demo-lake/${packageRelease}/lake.json`,
    `lakes/demo-lake/${packageRelease}/tiles/0/0/0.png`,
    `lakes/precache/${shellRelease}.json`,
    `lakes/registry/${shellRelease}.json`
  ]);
  assert.match(await readFile(serviceWorkerPath, "utf8"), /const SW_VERSION = "2026-08-07T10:00:00.000Z";/);
  assert.deepEqual(await readFile(path.join(packageDir, "tiles/0/0/0.png")), PNG_1X1);

  await rm(path.join(outputRoot, "demo-lake"), { recursive:true, force:true });
  await assert.rejects(
    () => restampShell({ outputRoot, generatedAt:"2026-08-07T11:00:00.000Z", serviceWorkerPath }),
    /Active package demo-lake/
  );
  assert.match(await readFile(serviceWorkerPath, "utf8"), /const SW_VERSION = "2026-08-07T10:00:00.000Z";/);
  await writeFile(path.join(outputRoot, "index.json"), JSON.stringify({ generatedAt:"2026-08-06T00:00:00.000Z", waterbodies:[] }) + "\n");
  await assert.rejects(
    () => restampShell({ outputRoot, generatedAt:"2026-08-07T11:00:00.000Z", serviceWorkerPath }),
    /no published waterbodies/
  );
});
