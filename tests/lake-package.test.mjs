import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import {
  bboxFromGeometry,
  tilesForBbox,
  computeMinZoom,
  clipGeometryToBbox,
  polygonFromOverpass,
  fetchOsmBoundary,
  parseVectorTile,
  tilePixelToLonLat,
  assembleBathymetry,
  buildLakePackage,
  buildLakePackageBatch,
  restampShell
} from "../tools/lake-package.mjs";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+XqG6WQAAAABJRU5ErkJggg==",
  "base64"
);

const FIXTURE = fileURLToPath(new URL("./fixtures/deeper-17-75082-43240.mvt", import.meta.url));
const FIXTURE_TILE = { z:17, x:75082, y:43240 };

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

test("computeMinZoom берёт наибольший влезающий зум минус 1 с clamp 3..15", () => {
  // Крошечный bbox влезает почти на любом зуме -> упирается в верхний clamp 15.
  assert.equal(computeMinZoom([26.2188,52.093,26.2189,52.0931]), 15);
  // Гигантский bbox влезает только на малых зумах.
  assert.equal(computeMinZoom([-10,-10,10,10]), 4);
  // Реальные боевые bbox.
  assert.equal(computeMinZoom([26.2115684,52.0826384,26.2248185,52.0927852]), 14);
  assert.equal(computeMinZoom([26.121524756036496,52.078917,26.146017331556376,52.096883]), 13);
});

test("clipGeometryToBbox обрезает открытую геометрию реки до района работ", () => {
  const river = {
    type:"Polygon",
    coordinates:[[[0,0],[10,0],[10,1],[0,1],[0,0]]]
  };

  const clipped = clipGeometryToBbox(river, [2,-1,4,2]);

  assert.equal(clipped.type, "Polygon");
  assert.deepEqual(bboxFromGeometry(clipped), [2,0,4,1]);
  assert.throws(() => clipGeometryToBbox(river, [20,0,21,1]), /does not intersect/);
  assert.throws(() => clipGeometryToBbox(river, [4,0,2,1]), /empty/);
});

test("clipGeometryToBbox сохраняет острова внутри района", () => {
  const withIsland = {
    type:"Polygon",
    coordinates:[
      [[0,0],[10,0],[10,10],[0,10],[0,0]],
      [[1,1],[2,1],[2,2],[1,2],[1,1]],
      [[8,8],[9,8],[9,9],[8,9],[8,8]]
    ]
  };

  const clipped = clipGeometryToBbox(withIsland, [0,0,5,5]);

  assert.equal(clipped.coordinates.length, 2);
  assert.deepEqual(bboxFromGeometry({ type:"Polygon", coordinates:[clipped.coordinates[1]] }), [1,1,2,2]);
});

test("polygonFromOverpass собирает кольца отношения с островами", () => {
  const document = {
    elements:[{
      type:"relation",
      members:[
        { role:"outer", geometry:[{ lon:0, lat:0 }, { lon:4, lat:0 }, { lon:4, lat:4 }] },
        { role:"outer", geometry:[{ lon:4, lat:4 }, { lon:0, lat:4 }, { lon:0, lat:0 }] },
        { role:"inner", geometry:[{ lon:1, lat:1 }, { lon:2, lat:1 }, { lon:2, lat:2 }, { lon:1, lat:2 }, { lon:1, lat:1 }] }
      ]
    }]
  };

  const geometry = polygonFromOverpass(document);

  assert.equal(geometry.type, "Polygon");
  assert.equal(geometry.coordinates.length, 2);
  assert.deepEqual(geometry.coordinates[0][0], geometry.coordinates[0].at(-1));
  assert.deepEqual(bboxFromGeometry(geometry), [0,0,4,4]);
  assert.throws(() => polygonFromOverpass({ elements:[{
    type:"relation",
    members:[{ role:"outer", geometry:[{ lon:0, lat:0 }, { lon:1, lat:1 }] }]
  }] }), /closed ring/);
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

test("parseVectorTile разбирает реальный тайл Deeper без зависимостей", async () => {
  const layers = parseVectorTile(await readFile(FIXTURE));

  assert.deepEqual(layers.map(layer => layer.name).sort(), ["depth", "depth_labels"]);
  const depth = layers.find(layer => layer.name === "depth");
  const labels = layers.find(layer => layer.name === "depth_labels");
  assert.equal(depth.extent, 4096);
  assert.equal(depth.features.length, 10);
  assert.equal(labels.features.length, 27);
  // Слой depth: полигоны (geom type 3), полосы 0..300 см с шагом 33.
  assert.ok(depth.features.every(feature => feature.type === 3));
  assert.deepEqual(depth.features.map(feature => feature.properties.depth),
    [0, 33, 66, 100, 133, 166, 200, 233, 266, 300]);
  // Слой depth_labels: точки (geom type 1) с готовой подписью dl_m в метрах.
  assert.ok(labels.features.every(feature => feature.type === 1));
  assert.equal(typeof labels.features[0].properties.dl_m, "string");
});

test("tilePixelToLonLat переводит пиксель тайла в WGS84", () => {
  const [lon, lat] = tilePixelToLonLat(FIXTURE_TILE, 0, 0, 4096);
  assert.equal(lon, 26.2188720703125);
  assert.ok(Math.abs(lat - 52.09300763963823) < 1e-9, `lat=${lat}`);
});

test("assembleBathymetry собирает полосы и подписи из тайла Deeper", async () => {
  const buffer = await readFile(FIXTURE);
  const bbox = [26.20, 52.08, 26.24, 52.10];
  // Фикстура - z17; геометрию собираем с неё, задав geometryZoom.
  const bathymetry = assembleBathymetry([{ ...FIXTURE_TILE, buffer }], bbox, { geometryZoom:17 });

  assert.equal(bathymetry.depthUnit, "cm");
  assert.equal(bathymetry.depthStep, 33);
  assert.equal(bathymetry.depthMax, 333);
  assert.deepEqual(bathymetry.bands.map(band => band.depth),
    [0, 33, 66, 100, 133, 166, 200, 233, 266, 300]);
  assert.deepEqual(bathymetry.bands[0].depthMax, 33);
  // Полосы - MultiPolygon: массив полигонов, полигон = массив колец, кольцо = [lon,lat].
  const ring = bathymetry.bands[0].polygons[0][0];
  assert.ok(Array.isArray(ring) && ring.length >= 4);
  assert.deepEqual(ring[0], ring.at(-1), "кольцо замкнуто");
  ring.forEach(([lon, lat]) => {
    assert.equal(lon, Math.round(lon * 1e7) / 1e7, "lon округлён до 7 знаков");
    assert.equal(lat, Math.round(lat * 1e7) / 1e7, "lat округлён до 7 знаков");
    assert.ok(lon >= bbox[0] - 1e-9 && lon <= bbox[2] + 1e-9, "клип по bbox: lon");
    assert.ok(lat >= bbox[1] - 1e-9 && lat <= bbox[3] + 1e-9, "клип по bbox: lat");
  });
  // Полосы не выходят за геопрямоугольник СОБСТВЕННОГО экстента тайла: буферная
  // зона (px/py вне 0..4096) обрезана до перевода в WGS84.
  const [rLonMin, rLatMax] = tilePixelToLonLat(FIXTURE_TILE, 0, 0, 4096);
  const [rLonMax, rLatMin] = tilePixelToLonLat(FIXTURE_TILE, 4096, 4096, 4096);
  for (const band of bathymetry.bands){
    for (const polygon of band.polygons){
      for (const ringOfPoly of polygon){
        for (const [lon, lat] of ringOfPoly){
          assert.ok(lon >= rLonMin - 1e-6 && lon <= rLonMax + 1e-6, `lon ${lon} вне экстента тайла`);
          assert.ok(lat >= rLatMin - 1e-6 && lat <= rLatMax + 1e-6, `lat ${lat} вне экстента тайла`);
        }
      }
    }
  }
  // Подписи ключуются зумом источника; точки в буфере (напр. dl_m "2.3" при px=-36)
  // отброшены как принадлежащие соседнему тайлу; остаётся 21 уникальная в экстенте.
  assert.deepEqual(Object.keys(bathymetry.labels), ["17"]);
  assert.equal(bathymetry.labels["17"].length, 21);
  bathymetry.labels["17"].forEach(([lon, lat, text]) => {
    assert.equal(typeof lon, "number");
    assert.equal(typeof lat, "number");
    assert.equal(typeof text, "string");
    assert.ok(lon >= rLonMin - 1e-6 && lon <= rLonMax + 1e-6, `подпись lon ${lon} в буфере`);
    assert.ok(lat >= rLatMin - 1e-6 && lat <= rLatMax + 1e-6, `подпись lat ${lat} в буфере`);
  });
});

test("assembleBathymetry клипует полосы по узкому bbox", async () => {
  const buffer = await readFile(FIXTURE);
  const wide = assembleBathymetry([{ ...FIXTURE_TILE, buffer }], [26.20, 52.08, 26.24, 52.10], { geometryZoom:17 });
  // Узкий прямоугольник в центре тайла отрезает часть полос.
  const narrow = assembleBathymetry([{ ...FIXTURE_TILE, buffer }], [26.219, 52.091, 26.221, 52.093], { geometryZoom:17 });
  const wideRings = wide.bands.reduce((sum, band) => sum + band.polygons.length, 0);
  const narrowRings = narrow.bands.reduce((sum, band) => sum + band.polygons.length, 0);
  assert.ok(narrowRings < wideRings, `narrow=${narrowRings} wide=${wideRings}`);
  for (const band of narrow.bands){
    for (const polygon of band.polygons){
      for (const [lon, lat] of polygon[0]){
        assert.ok(lon >= 26.219 - 1e-9 && lon <= 26.221 + 1e-9);
        assert.ok(lat >= 52.091 - 1e-9 && lat <= 52.093 + 1e-9);
      }
    }
  }
});

test("buildLakePackage собирает векторный пакет из кэша и не ходит в сеть", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lake-vector-"));
  t.after(() => rm(root, { recursive:true, force:true }));
  const cacheDir = path.join(root, ".deeper-cache");
  const fixture = await readFile(FIXTURE);

  // Узкий bbox вокруг тайла фикстуры -> по одному тайлу на уровень z12..z18.
  const packBoundary = {
    type:"Polygon",
    coordinates:[[[26.2188,52.0929],[26.2190,52.0929],[26.2190,52.0931],[26.2188,52.0931],[26.2188,52.0929]]]
  };
  const bbox = bboxFromGeometry(packBoundary);
  const tiles = [];
  for (let z = 12; z <= 18; z++) tiles.push(...tilesForBbox(bbox, z));
  // Полный тёплый кэш: z18 - настоящий тайл, остальные уровни - пустые (0 байт).
  for (const tile of tiles){
    const file = path.join(cacheDir, String(tile.z), String(tile.x), `${tile.y}.mvt`);
    await mkdir(path.dirname(file), { recursive:true });
    await writeFile(file, tile.z === 18 ? fixture : Buffer.alloc(0));
  }

  const serviceWorkerPath = path.join(root, "sw.js");
  await writeFile(serviceWorkerPath, '"use strict";\nconst SW_VERSION = "base";\n');

  let networkCalls = 0;
  const fetchImpl = () => { networkCalls++; throw new Error("network must not be touched with a full cache"); };

  const options = {
    slug:"test",
    name:"Тест",
    type:"lake",
    boundary:packBoundary,
    outputRoot:path.join(root, "lakes"),
    cacheDir,
    token:"",
    fetchImpl,
    generatedAt:"2026-08-11T00:00:00.000Z",
    serviceWorkerPath
  };
  const result = await buildLakePackage(options);
  const release = "2026-08-11T00-00-00-000Z";

  assert.equal(networkCalls, 0, "с полным кэшем и пустым токеном сеть не трогается");
  assert.equal(result.downloaded, 0);
  assert.equal(result.tileCount, tiles.length);

  const packageDir = path.join(root, "lakes/test", release);
  const manifest = JSON.parse(await readFile(path.join(packageDir, "lake.json"), "utf8"));
  assert.equal(manifest.format, 2);
  assert.equal(manifest.bathymetry, "bathymetry.json");
  assert.equal(manifest.maxZoom, 22);
  assert.equal(manifest.minZoom, computeMinZoom(bbox));
  assert.equal(manifest.source, "Deeper fishdeeper.com (vector z18)");
  assert.deepEqual(manifest.bbox, bbox);

  const bathymetry = JSON.parse(await readFile(path.join(packageDir, "bathymetry.json"), "utf8"));
  assert.equal(bathymetry.depthStep, 33);
  assert.ok(bathymetry.bands.length > 0, "z18 фикстура дала полосы");
  assert.ok(Object.keys(bathymetry.labels).length > 0, "подписи есть хотя бы на одном уровне");

  // Precache версии обязан включать bathymetry.json.
  const precache = JSON.parse(await readFile(path.join(root, "lakes/precache", `${release}.json`), "utf8"));
  assert.ok(precache.files.includes(`lakes/test/${release}/bathymetry.json`));
  assert.ok(precache.files.includes(`lakes/test/${release}/lake.json`));
  assert.match(await readFile(serviceWorkerPath, "utf8"), /const SW_VERSION = "2026-08-11T00:00:00.000Z";/);

  // Повторная сборка тем же generatedAt воспроизводима и снова без сети.
  const repeated = await buildLakePackage(options);
  assert.equal(networkCalls, 0);
  assert.equal(repeated.downloaded, 0);

  await assert.rejects(() => buildLakePackage({ ...options, concurrency:4 }), /Concurrency must be an integer/);
});

test("buildLakePackage требует токен при промахе кэша", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lake-miss-"));
  t.after(() => rm(root, { recursive:true, force:true }));
  const serviceWorkerPath = path.join(root, "sw.js");
  await writeFile(serviceWorkerPath, '"use strict";\nconst SW_VERSION = "base";\n');

  await assert.rejects(() => buildLakePackage({
    slug:"test",
    name:"Тест",
    type:"lake",
    boundary:{ type:"Polygon", coordinates:[[[26.2188,52.0929],[26.2190,52.0929],[26.2190,52.0931],[26.2188,52.0931],[26.2188,52.0929]]] },
    outputRoot:path.join(root, "lakes"),
    cacheDir:path.join(root, ".empty-cache"),
    token:"",
    fetchImpl:() => { throw new Error("should not fetch without token"); },
    generatedAt:"2026-08-11T00:00:00.000Z",
    serviceWorkerPath
  }), /missing from the cache and DEEPER_TOKEN is empty/);
});

test("loadTile качает сеть при промахе, кладёт в кэш и ретраит 504", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lake-net-"));
  t.after(() => rm(root, { recursive:true, force:true }));
  const cacheDir = path.join(root, ".deeper-cache");
  const fixture = await readFile(FIXTURE);

  // Один тайл (z12) отсутствует в кэше и должен быть скачан; сервер отвечает 504, потом 200.
  const packBoundary = {
    type:"Polygon",
    coordinates:[[[26.2188,52.0929],[26.2190,52.0929],[26.2190,52.0931],[26.2188,52.0931],[26.2188,52.0929]]]
  };
  const bbox = bboxFromGeometry(packBoundary);
  const tiles = [];
  for (let z = 12; z <= 18; z++) tiles.push(...tilesForBbox(bbox, z));
  const miss = tiles.find(tile => tile.z === 12);
  for (const tile of tiles){
    if (tile.z === 12) continue;
    const file = path.join(cacheDir, String(tile.z), String(tile.x), `${tile.y}.mvt`);
    await mkdir(path.dirname(file), { recursive:true });
    await writeFile(file, tile.z === 18 ? fixture : Buffer.alloc(0));
  }

  const seen = [];
  let attempts = 0;
  const fetchImpl = async url => {
    seen.push(url.toString());
    attempts++;
    if (attempts === 1) return { status:504, arrayBuffer:async () => new ArrayBuffer(0) };
    return { status:200, arrayBuffer:async () => Buffer.alloc(0).buffer };
  };
  const delays = [];

  const serviceWorkerPath = path.join(root, "sw.js");
  await writeFile(serviceWorkerPath, '"use strict";\nconst SW_VERSION = "base";\n');
  const result = await buildLakePackage({
    slug:"test",
    name:"Тест",
    type:"lake",
    boundary:packBoundary,
    outputRoot:path.join(root, "lakes"),
    cacheDir,
    token:"live-token",
    fetchImpl,
    sleep:ms => { delays.push(ms); return Promise.resolve(); },
    backoff:2000,
    generatedAt:"2026-08-11T00:00:00.000Z",
    serviceWorkerPath
  });

  assert.equal(result.downloaded, 1, "скачан ровно один промахнувшийся тайл");
  assert.equal(attempts, 2, "504 вызвал ретрай, затем успех");
  assert.deepEqual(delays, [2000], "экспоненциальный бэкофф от 2с");
  assert.match(seen[0], /token=live-token/);
  assert.match(seen[0], /cid=00000000-0000-0000-0000-000000000000/);
  // Скачанный (пустой) тайл записан в кэш.
  const cached = await readFile(path.join(cacheDir, String(miss.z), String(miss.x), `${miss.y}.mvt`));
  assert.equal(cached.length, 0);
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

test("buildLakePackageBatch выпускает несколько пакетов одним release", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lake-batch-"));
  t.after(() => rm(root, { recursive:true, force:true }));
  const cacheDir = path.join(root, ".deeper-cache");
  const fixture = await readFile(FIXTURE);

  const packBoundary = {
    type:"Polygon",
    coordinates:[[[26.2188,52.0929],[26.2190,52.0929],[26.2190,52.0931],[26.2188,52.0931],[26.2188,52.0929]]]
  };
  const bbox = bboxFromGeometry(packBoundary);
  const tiles = [];
  for (let z = 12; z <= 18; z++) tiles.push(...tilesForBbox(bbox, z));
  for (const tile of tiles){
    const file = path.join(cacheDir, String(tile.z), String(tile.x), `${tile.y}.mvt`);
    await mkdir(path.dirname(file), { recursive:true });
    await writeFile(file, tile.z === 18 ? fixture : Buffer.alloc(0));
  }

  const serviceWorkerPath = path.join(root, "sw.js");
  await writeFile(serviceWorkerPath, '"use strict";\nconst SW_VERSION = "base";\n');

  let networkCalls = 0;
  const options = {
    packages:[
      { slug:"alpha", name:"Альфа", type:"lake", boundary:packBoundary },
      { slug:"beta", name:"Бета", type:"reservoir", boundary:packBoundary }
    ],
    outputRoot:path.join(root, "lakes"),
    cacheDir,
    token:"",
    fetchImpl:() => { networkCalls++; throw new Error("network must not be touched with a full cache"); },
    generatedAt:"2026-08-11T00:00:00.000Z",
    serviceWorkerPath
  };
  const batch = await buildLakePackageBatch(options);
  const release = "2026-08-11T00-00-00-000Z";

  assert.equal(networkCalls, 0);
  assert.equal(batch.release, release);
  assert.equal(batch.packages.length, 2);

  // Оба slug в реестре под ОДНИМ штампом release.
  const registry = JSON.parse(await readFile(path.join(root, "lakes/index.json"), "utf8"));
  assert.deepEqual(
    registry.waterbodies.map(item => ({ slug:item.slug, release:item.release })).sort((a, b) => a.slug.localeCompare(b.slug)),
    [{ slug:"alpha", release }, { slug:"beta", release }]
  );
  // Ровно один снимок registry/precache этого штампа, один SW_VERSION.
  const registryText = await readFile(path.join(root, "lakes/index.json"), "utf8");
  assert.equal(await readFile(path.join(root, "lakes/registry", `${release}.json`), "utf8"), registryText);
  const precache = JSON.parse(await readFile(path.join(root, "lakes/precache", `${release}.json`), "utf8"));
  assert.ok(precache.files.includes(`lakes/alpha/${release}/bathymetry.json`));
  assert.ok(precache.files.includes(`lakes/beta/${release}/bathymetry.json`));
  assert.ok(precache.files.includes(`lakes/alpha/${release}/lake.json`));
  assert.ok(precache.files.includes(`lakes/beta/${release}/lake.json`));
  assert.match(await readFile(serviceWorkerPath, "utf8"), /const SW_VERSION = "2026-08-11T00:00:00.000Z";/);
  for (const slug of ["alpha", "beta"]){
    const manifest = JSON.parse(await readFile(path.join(root, "lakes", slug, release, "lake.json"), "utf8"));
    assert.equal(manifest.format, 2);
    assert.equal(manifest.release, release);
  }

  // Идемпотентность: повторный запуск с тем же штампом и контентом не падает.
  const repeated = await buildLakePackageBatch(options);
  assert.equal(networkCalls, 0);
  assert.equal(repeated.release, release);
  assert.equal(await readFile(path.join(root, "lakes/index.json"), "utf8"), registryText);

  await assert.rejects(() => buildLakePackageBatch({ ...options, packages:[] }), /at least one package/);
});
