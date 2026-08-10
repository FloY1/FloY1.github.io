#!/usr/bin/env node

import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";

const PNG_MAGIC = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);
const MAX_LAT = 85.05112878;

function visitCoordinates(value, visitor){
  if (!Array.isArray(value)) throw new Error("GeoJSON coordinates must be arrays");
  if (value.length >= 2 && Number.isFinite(Number(value[0])) && Number.isFinite(Number(value[1]))){
    visitor(Number(value[0]), Number(value[1]));
    return;
  }
  value.forEach(item => visitCoordinates(item, visitor));
}

export function bboxFromGeometry(geometry){
  if (!geometry || !["Polygon", "MultiPolygon"].includes(geometry.type)) throw new Error("Boundary must be a Polygon or MultiPolygon");
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  visitCoordinates(geometry.coordinates, (lon, lat) => {
    if (lon < -180 || lon > 180 || lat < -90 || lat > 90) throw new Error("Boundary coordinate is outside WGS84");
    minLon = Math.min(minLon, lon);
    minLat = Math.min(minLat, lat);
    maxLon = Math.max(maxLon, lon);
    maxLat = Math.max(maxLat, lat);
  });
  if (!Number.isFinite(minLon) || minLon >= maxLon || minLat >= maxLat) throw new Error("Boundary bbox is empty");
  return [minLon, minLat, maxLon, maxLat];
}

function longitudeTile(lon, zoom){
  const count = 2 ** zoom;
  return Math.max(0, Math.min(count - 1, Math.floor((lon + 180) / 360 * count)));
}

function latitudeTile(lat, zoom){
  const safeLat = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
  const radians = safeLat * Math.PI / 180;
  const count = 2 ** zoom;
  const value = (1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2 * count;
  return Math.max(0, Math.min(count - 1, Math.floor(value)));
}

export function tilesForBbox(bbox, zoom){
  if (!Number.isInteger(zoom) || zoom < 0 || zoom > 22) throw new Error("Zoom must be an integer from 0 to 22");
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const minX = longitudeTile(minLon, zoom);
  const maxX = longitudeTile(maxLon, zoom);
  const minY = latitudeTile(maxLat, zoom);
  const maxY = latitudeTile(minLat, zoom);
  const tiles = [];
  for (let x = minX; x <= maxX; x++){
    for (let y = minY; y <= maxY; y++) tiles.push({ z:zoom, x, y });
  }
  return tiles;
}

export function zoomRange(value){
  const text = String(value == null ? "" : value).trim();
  const match = /^(\d+)(?:-(\d+))?$/.exec(text);
  if (!match) throw new Error("Zoom must be N or N-M");
  const min = Number(match[1]);
  const max = match[2] === undefined ? min : Number(match[2]);
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max > 22) throw new Error("Zoom must be an integer from 0 to 22");
  if (min > max) throw new Error("Zoom range must go from low to high");
  return [min, max];
}

function clipRing(ring, rect){
  const [minLon, minLat, maxLon, maxLat] = rect;
  const edges = [
    { inside:point => point[0] >= minLon, cut:(from, to) => [minLon, from[1] + (to[1] - from[1]) * (minLon - from[0]) / (to[0] - from[0])] },
    { inside:point => point[0] <= maxLon, cut:(from, to) => [maxLon, from[1] + (to[1] - from[1]) * (maxLon - from[0]) / (to[0] - from[0])] },
    { inside:point => point[1] >= minLat, cut:(from, to) => [from[0] + (to[0] - from[0]) * (minLat - from[1]) / (to[1] - from[1]), minLat] },
    { inside:point => point[1] <= maxLat, cut:(from, to) => [from[0] + (to[0] - from[0]) * (maxLat - from[1]) / (to[1] - from[1]), maxLat] }
  ];
  let output = ring.slice(0, -1);
  for (const edge of edges){
    const input = output;
    output = [];
    for (let index = 0; index < input.length; index++){
      const current = input[index];
      const previous = input[(index + input.length - 1) % input.length];
      const currentInside = edge.inside(current);
      if (currentInside && !edge.inside(previous)) output.push(edge.cut(previous, current));
      if (currentInside) output.push(current);
      if (!currentInside && edge.inside(previous)) output.push(edge.cut(previous, current));
    }
    if (output.length < 3) return null;
  }
  return output.concat([output[0]]);
}

export function clipGeometryToBbox(geometry, rect){
  if (!Array.isArray(rect) || rect.length !== 4 || !rect.every(value => Number.isFinite(value))) throw new Error("Clip must be minLon,minLat,maxLon,maxLat");
  if (rect[0] >= rect[2] || rect[1] >= rect[3]) throw new Error("Clip rectangle is empty");
  bboxFromGeometry(geometry);
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  const clipped = [];
  for (const rings of polygons){
    const outer = clipRing(rings[0], rect);
    if (!outer) continue;
    clipped.push([outer, ...rings.slice(1).map(ring => clipRing(ring, rect)).filter(Boolean)]);
  }
  if (!clipped.length) throw new Error("Clip rectangle does not intersect the boundary");
  return clipped.length === 1
    ? { type:"Polygon", coordinates:clipped[0] }
    : { type:"MultiPolygon", coordinates:clipped };
}

function assembleRings(segments){
  const same = (left, right) => left[0] === right[0] && left[1] === right[1];
  const pending = segments.map(segment => segment.geometry.map(point => [point.lon, point.lat]));
  const rings = [];
  while (pending.length){
    let ring = pending.shift();
    while (!same(ring[0], ring[ring.length - 1])){
      const tail = ring[ring.length - 1];
      const index = pending.findIndex(segment => same(segment[0], tail) || same(segment[segment.length - 1], tail));
      if (index < 0) throw new Error("Overpass ways do not form a closed ring");
      const segment = pending.splice(index, 1)[0];
      ring = ring.concat((same(segment[0], tail) ? segment : segment.slice().reverse()).slice(1));
    }
    rings.push(ring);
  }
  return rings;
}

function ringContains(ring, point){
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++){
    const [x1, y1] = ring[index];
    const [x2, y2] = ring[previous];
    if ((y1 > point[1]) !== (y2 > point[1]) && point[0] < (x2 - x1) * (point[1] - y1) / (y2 - y1) + x1) inside = !inside;
  }
  return inside;
}

export function polygonFromOverpass(document){
  const elements = Array.isArray(document && document.elements) ? document.elements : null;
  if (!elements) throw new Error("Overpass export must contain elements");
  const outer = [];
  const inner = [];
  for (const element of elements){
    if (element.type === "relation" && Array.isArray(element.members)){
      const members = element.members.filter(member => Array.isArray(member.geometry) && member.geometry.length > 1);
      outer.push(...assembleRings(members.filter(member => member.role !== "inner")));
      inner.push(...assembleRings(members.filter(member => member.role === "inner")));
    } else if (element.type === "way" && Array.isArray(element.geometry)){
      outer.push(...assembleRings([element]));
    }
  }
  if (!outer.length) throw new Error("Overpass export has no closed water ring");
  const polygons = outer.map(ring => [ring]);
  for (const hole of inner){
    const host = polygons.find(polygon => ringContains(polygon[0], hole[0]));
    if (host) host.push(hole);
  }
  return polygons.length === 1
    ? { type:"Polygon", coordinates:polygons[0] }
    : { type:"MultiPolygon", coordinates:polygons };
}

export async function fetchOsmBoundary(osmId, options = {}){
  if (!/^[RWN]\d+$/.test(osmId || "")) throw new Error("OSM id must look like R123, W123 or N123");
  const endpoint = options.endpoint || "https://nominatim.openstreetmap.org/lookup";
  const url = new URL(endpoint);
  url.searchParams.set("osm_ids", osmId);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("polygon_geojson", "1");
  const response = await (options.fetchImpl || fetch)(url, {
    headers:{
      accept:"application/json",
      "user-agent":"karta-dna-site lake package builder"
    }
  });
  if (!response.ok) throw new Error(`OSM lookup returned HTTP ${response.status}`);
  const results = await response.json();
  const geometry = Array.isArray(results) && results[0] ? results[0].geojson : null;
  bboxFromGeometry(geometry);
  return geometry;
}

function isPng(buffer){
  return buffer.length >= PNG_MAGIC.length && buffer.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC);
}
function releaseFromTimestamp(generatedAt){
  return new Date(generatedAt).toISOString().replace(/[:.]/g, "-");
}

export function decodeRgbaPng(buffer){
  if (!isPng(buffer)) throw new Error("Tile is not a PNG");
  let offset = 8;
  let width = 0, height = 0, header = null;
  const idat = [];
  while (offset + 8 <= buffer.length){
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("latin1", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR"){
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      header = { bitDepth:data[8], colorType:data[9], interlace:data[12] };
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    offset += 12 + length;
  }
  if (!header || header.bitDepth !== 8 || header.colorType !== 6 || header.interlace !== 0){
    throw new Error("Only 8-bit non-interlaced RGBA PNG tiles are supported");
  }
  const stride = width * 4;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  if (raw.length !== (stride + 1) * height) throw new Error("PNG payload size mismatch");
  const pixels = Buffer.allocUnsafe(stride * height);
  for (let y = 0; y < height; y++){
    const filter = raw[y * (stride + 1)];
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    const prev = y ? pixels.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++){
      const left = x >= 4 ? out[x - 4] : 0;
      const up = prev ? prev[x] : 0;
      const upLeft = prev && x >= 4 ? prev[x - 4] : 0;
      let value = row[x];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4){
        const initial = left + up - upLeft;
        const viaLeft = Math.abs(initial - left);
        const viaUp = Math.abs(initial - up);
        const viaUpLeft = Math.abs(initial - upLeft);
        value += viaLeft <= viaUp && viaLeft <= viaUpLeft ? left : viaUp <= viaUpLeft ? up : upLeft;
      } else if (filter !== 0) throw new Error(`Unsupported PNG filter ${filter}`);
      out[x] = value & 0xff;
    }
  }
  return { width, height, pixels };
}

function pngChunk(type, data){
  const chunk = Buffer.allocUnsafe(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, "latin1");
  data.copy(chunk, 8);
  chunk.writeUInt32BE(zlib.crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
  return chunk;
}

export function encodeRgbaPng(width, height, pixels){
  const stride = width * 4;
  if (pixels.length !== stride * height) throw new Error("Pixel buffer size mismatch");
  const raw = Buffer.allocUnsafe((stride + 1) * height);
  for (let y = 0; y < height; y++){
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    PNG_MAGIC,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw, { level:9 })),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

function downscaleIntoQuadrant(child, parent, size, offsetX, offsetY){
  const half = size / 2;
  for (let y = 0; y < half; y++){
    for (let x = 0; x < half; x++){
      let red = 0, green = 0, blue = 0, alpha = 0;
      for (let dy = 0; dy < 2; dy++){
        for (let dx = 0; dx < 2; dx++){
          const index = ((y * 2 + dy) * size + x * 2 + dx) * 4;
          const weight = child[index + 3];
          red += child[index] * weight;
          green += child[index + 1] * weight;
          blue += child[index + 2] * weight;
          alpha += weight;
        }
      }
      const out = ((offsetY + y) * size + offsetX + x) * 4;
      parent[out] = alpha ? Math.round(red / alpha) : 0;
      parent[out + 1] = alpha ? Math.round(green / alpha) : 0;
      parent[out + 2] = alpha ? Math.round(blue / alpha) : 0;
      parent[out + 3] = Math.round(alpha / 4);
    }
  }
}


async function readJson(file, fallback){
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch(error){
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}
async function writeFileAtomic(destination, content){
  await mkdir(path.dirname(destination), { recursive:true });
  const temporary = `${destination}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, content);
    await rename(temporary, destination);
  } catch(error){
    await rm(temporary, { force:true });
    throw error;
  }
}
async function writeFileImmutable(destination, content){
  if (await pathExists(destination)){
    const current = await readFile(destination);
    if (!current.equals(Buffer.from(content))){
      throw new Error(`Immutable file ${path.basename(destination)} already exists with different content`);
    }
    return;
  }
  await writeFileAtomic(destination, content);
}

async function pathExists(target){
  try {
    await stat(target);
    return true;
  } catch(error){
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function directoriesEqual(left, right){
  const leftFiles = await collectFiles(left);
  const rightFiles = await collectFiles(right);
  if (leftFiles.length !== rightFiles.length || leftFiles.some((file, index) => file !== rightFiles[index])) return false;
  for (const file of leftFiles){
    const [leftContent, rightContent] = await Promise.all([
      readFile(path.join(left, file)),
      readFile(path.join(right, file))
    ]);
    if (!leftContent.equals(rightContent)) return false;
  }
  return true;
}

async function publishRelease(staging, destination){
  if (!await pathExists(destination)){
    await rename(staging, destination);
    return;
  }
  if (!await directoriesEqual(staging, destination)){
    throw new Error(`Release ${path.basename(destination)} already exists with different content`);
  }
  await rm(staging, { recursive:true, force:true });
}

async function prepareServiceWorker(serviceWorkerPath, generatedAt){
  if (!serviceWorkerPath) return null;
  const source = await readFile(serviceWorkerPath, "utf8");
  const versionPattern = /const SW_VERSION = "[^"]*";/;
  if (!versionPattern.test(source)) throw new Error("Service worker version marker is missing");
  return {
    path:serviceWorkerPath,
    content:source.replace(versionPattern, `const SW_VERSION = "${generatedAt}";`)
  };
}

async function readRegistry(outputRoot, generatedAt){
  const registry = await readJson(path.join(outputRoot, "index.json"), { generatedAt, waterbodies:[] });
  if (!Array.isArray(registry.waterbodies)) throw new Error("Lake registry must contain waterbodies array");
  const seenSlugs = new Set();
  registry.waterbodies.forEach(item => {
    if (!item || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.slug || "") ||
        !/^[A-Za-z0-9-]+$/.test(item.release || "") || seenSlugs.has(item.slug)){
      throw new Error("Lake registry contains an invalid or duplicate release");
    }
    seenSlugs.add(item.slug);
  });
  return registry;
}

async function publishRegistry(outputRoot, registry, generatedAt, serviceWorker){
  const release = releaseFromTimestamp(generatedAt);
  registry.waterbodies.sort((left, right) => left.name.localeCompare(right.name, "ru"));
  registry.generatedAt = generatedAt;
  const prefix = path.basename(outputRoot);
  const files = [];
  for (const item of registry.waterbodies){
    const relativeRoot = `${item.slug}/${item.release}`;
    const activePackage = path.join(outputRoot, relativeRoot);
    if (!await pathExists(activePackage)) throw new Error(`Active package ${relativeRoot} is missing`);
    const packageFiles = await collectFiles(activePackage);
    packageFiles.forEach(file => files.push(`${prefix}/${relativeRoot}/${file}`));
  }
  files.push(`${prefix}/precache/${release}.json`, `${prefix}/registry/${release}.json`);
  files.sort();
  const registryText = JSON.stringify(registry, null, 2) + "\n";
  await writeFileImmutable(path.join(outputRoot, "registry", `${release}.json`), registryText);
  await writeFileImmutable(
    path.join(outputRoot, "precache", `${release}.json`),
    JSON.stringify({ generatedAt, files }, null, 2) + "\n"
  );
  await writeFileAtomic(path.join(outputRoot, "index.json"), registryText);
  if (serviceWorker) await writeFileAtomic(serviceWorker.path, serviceWorker.content);
  return { release, files };
}

export async function restampShell(options){
  const {
    outputRoot,
    generatedAt:generatedAtInput = new Date().toISOString(),
    serviceWorkerPath
  } = options;
  if (typeof generatedAtInput !== "string" || Number.isNaN(Date.parse(generatedAtInput))){
    throw new Error("Generated timestamp must be ISO-8601");
  }
  const generatedAt = new Date(generatedAtInput).toISOString();
  const registry = await readRegistry(outputRoot, generatedAt);
  if (!registry.waterbodies.length) throw new Error("Lake registry has no published waterbodies");
  const serviceWorker = await prepareServiceWorker(serviceWorkerPath, generatedAt);
  const { release, files } = await publishRegistry(outputRoot, registry, generatedAt, serviceWorker);
  return { release, generatedAt, files };
}



async function collectFiles(directory, relative = ""){
  const entries = await readdir(directory, { withFileTypes:true });
  const files = [];
  for (const entry of entries.sort((left,right) => left.name.localeCompare(right.name))){
    const childRelative = relative ? path.join(relative, entry.name) : entry.name;
    const childPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(childPath, childRelative));
    else if (entry.isFile() && !entry.name.endsWith(".tmp")) files.push(childRelative.split(path.sep).join("/"));
  }
  return files;
}

async function downloadTile(tile, options){
  const relative = `${tile.z}/${tile.x}/${tile.y}.png`;
  const destination = path.join(options.packageDir, "tiles", relative);
  if (options.resumeDir){
    try {
      const cached = await readFile(path.join(options.resumeDir, "tiles", relative));
      if (isPng(cached)){
        await mkdir(path.dirname(destination), { recursive:true });
        await writeFile(destination, cached);
        return false;
      }
    } catch(error){
      if (error.code !== "ENOENT") throw error;
    }
  }

  const endpoint = options.endpoint
    .replace("{z}", String(tile.z))
    .replace("{x}", String(tile.x))
    .replace("{y}", String(tile.y));
  const url = new URL(endpoint);
  url.searchParams.set("config", options.config);
  url.searchParams.set("transparent", "true");
  url.searchParams.set("du", "1");
  url.searchParams.set("layer", "1");
  const response = await options.fetchImpl(url, {
    headers:{
      accept:"*/*",
      authorization:`Bearer ${options.token}`,
      origin:"https://by.fishermap.org",
      referer:"https://by.fishermap.org/"
    }
  });
  if (!response.ok) throw new Error(`Tile ${tile.z}/${tile.x}/${tile.y} returned HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!isPng(buffer)) throw new Error(`Tile ${tile.z}/${tile.x}/${tile.y} is not a PNG`);
  await writeFileAtomic(destination, buffer);
  return true;
}

async function runWorkers(items, concurrency, worker){
  let cursor = 0;
  async function run(){
    while (cursor < items.length){
      const item = items[cursor++];
      await worker(item);
    }
  }
  await Promise.all(Array.from({ length:Math.min(concurrency, items.length) }, run));
}

export async function buildLakePackage(options){
  const {
    slug,
    name,
    type,
    boundary,
    clip,
    zoom,
    config,
    token,
    outputRoot,
    endpoint = "https://tile1.navionics.com/viewer/api/v1/tile/{z}/{x}/{y}",
    generatedAt:generatedAtInput = new Date().toISOString(),
    fetchImpl = fetch,
    concurrency = 6,
    serviceWorkerPath
  } = options;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug || "")) throw new Error("Slug must be kebab-case ASCII");
  if (typeof name !== "string" || !name.trim()) throw new Error("Name is required");
  if (!["lake", "reservoir", "river"].includes(type)) throw new Error("Type must be lake, reservoir or river");
  if (typeof config !== "string" || !config || typeof token !== "string" || !token) throw new Error("Navionics config and token are required");
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new Error("Concurrency must be an integer from 1 to 32");
  if (typeof generatedAtInput !== "string" || Number.isNaN(Date.parse(generatedAtInput))) throw new Error("Generated timestamp must be ISO-8601");

  const generatedAt = new Date(generatedAtInput).toISOString();
  const release = releaseFromTimestamp(generatedAt);
  const geometry = clip ? clipGeometryToBbox(boundary, clip) : boundary;
  const bbox = bboxFromGeometry(geometry);
  const [minZoom, maxZoom] = zoomRange(zoom);
  const tiles = [];
  for (let level = minZoom; level <= maxZoom; level++) tiles.push(...tilesForBbox(bbox, level));
  const manifest = {
    slug,
    release,
    name:name.trim(),
    type,
    crs:"EPSG:3857",
    tileSize:256,
    minZoom,
    maxZoom,
    du:1,
    bbox,
    center:[(bbox[1] + bbox[3]) / 2, (bbox[0] + bbox[2]) / 2],
    boundary:geometry,
    source:"Navionics SonarChart (layer=1, du=1)",
    attribution:"© Navionics/Garmin, © OpenStreetMap",
    generatedAt
  };

  const registry = await readRegistry(outputRoot, generatedAt);
  const serviceWorker = await prepareServiceWorker(serviceWorkerPath, generatedAt);
  const existingIndex = registry.waterbodies.findIndex(item => item.slug === slug);
  const existing = existingIndex >= 0 ? registry.waterbodies[existingIndex] : null;

  const packageRoot = path.join(outputRoot, slug);
  const packageDir = path.join(packageRoot, release);
  const stagingDir = `${packageDir}.staging`;
  const resumeDir = existing
    ? path.join(packageRoot, existing.release)
    : await pathExists(packageDir) ? packageDir : null;
  await rm(stagingDir, { recursive:true, force:true });
  await mkdir(stagingDir, { recursive:true });

  let downloaded = 0;
  try {
    await runWorkers(tiles, concurrency, async tile => {
      if (await downloadTile(tile, {
        packageDir:stagingDir,
        resumeDir,
        endpoint,
        config,
        token,
        fetchImpl
      })) downloaded++;
    });
    await writeFileAtomic(path.join(stagingDir, "lake.json"), JSON.stringify(manifest, null, 2) + "\n");
    await publishRelease(stagingDir, packageDir);
  } catch(error){
    await rm(stagingDir, { recursive:true, force:true });
    throw error;
  }

  const summary = { slug, release, name:manifest.name, type, center:manifest.center, bbox };
  if (existingIndex >= 0) registry.waterbodies[existingIndex] = summary;
  else registry.waterbodies.push(summary);
  await publishRegistry(outputRoot, registry, generatedAt, serviceWorker);
  return { manifest, tileCount:tiles.length, downloaded };
}

export async function extendLakePyramid(options){
  const {
    slugs,
    minZoom,
    outputRoot,
    generatedAt:generatedAtInput = new Date().toISOString(),
    serviceWorkerPath
  } = options;
  if (!Array.isArray(slugs) || !slugs.length) throw new Error("Pass at least one package slug");
  if (!Number.isInteger(minZoom) || minZoom < 0 || minZoom > 22) throw new Error("Min zoom must be an integer from 0 to 22");
  if (typeof generatedAtInput !== "string" || Number.isNaN(Date.parse(generatedAtInput))) throw new Error("Generated timestamp must be ISO-8601");

  const generatedAt = new Date(generatedAtInput).toISOString();
  const release = releaseFromTimestamp(generatedAt);
  const registry = await readRegistry(outputRoot, generatedAt);
  const serviceWorker = await prepareServiceWorker(serviceWorkerPath, generatedAt);
  const packages = [];
  for (const slug of slugs){
    const existingIndex = registry.waterbodies.findIndex(item => item.slug === slug);
    if (existingIndex < 0) throw new Error(`Package ${slug} is not published`);
    const existing = registry.waterbodies[existingIndex];
    const currentDir = path.join(outputRoot, slug, existing.release);
    const manifest = await readJson(path.join(currentDir, "lake.json"), null);
    if (!manifest) throw new Error(`Manifest for ${slug} is missing`);
    if (minZoom >= manifest.minZoom) throw new Error(`Package ${slug} already starts at z${manifest.minZoom}`);
    const size = manifest.tileSize;
    if (!Number.isInteger(size) || size < 2 || size % 2) throw new Error(`Package ${slug} has an invalid tile size`);

    const packageDir = path.join(outputRoot, slug, release);
    const stagingDir = `${packageDir}.staging`;
    await rm(stagingDir, { recursive:true, force:true });
    await mkdir(stagingDir, { recursive:true });
    let synthesized = 0;
    try {
      for (const file of await collectFiles(currentDir)){
        if (!file.startsWith("tiles/")) continue;
        const destination = path.join(stagingDir, file);
        await mkdir(path.dirname(destination), { recursive:true });
        await writeFile(destination, await readFile(path.join(currentDir, file)));
      }
      for (let level = manifest.minZoom - 1; level >= minZoom; level--){
        for (const tile of tilesForBbox(manifest.bbox, level)){
          const parent = Buffer.alloc(size * size * 4);
          for (const [dx, dy] of [[0,0],[1,0],[0,1],[1,1]]){
            const childFile = path.join(stagingDir, "tiles", String(level + 1), String(tile.x * 2 + dx), `${tile.y * 2 + dy}.png`);
            let content;
            try {
              content = await readFile(childFile);
            } catch(error){
              if (error.code !== "ENOENT") throw error;
              continue;
            }
            const child = decodeRgbaPng(content);
            if (child.width !== size || child.height !== size){
              throw new Error(`Tile ${level + 1}/${tile.x * 2 + dx}/${tile.y * 2 + dy} of ${slug} is not ${size}x${size}`);
            }
            downscaleIntoQuadrant(child.pixels, parent, size, dx * size / 2, dy * size / 2);
          }
          const destination = path.join(stagingDir, "tiles", String(level), String(tile.x), `${tile.y}.png`);
          await mkdir(path.dirname(destination), { recursive:true });
          await writeFile(destination, encodeRgbaPng(size, size, parent));
          synthesized++;
        }
      }
      const updated = { ...manifest, release, minZoom, generatedAt };
      await writeFileAtomic(path.join(stagingDir, "lake.json"), JSON.stringify(updated, null, 2) + "\n");
      await publishRelease(stagingDir, packageDir);
    } catch(error){
      await rm(stagingDir, { recursive:true, force:true });
      throw error;
    }
    registry.waterbodies[existingIndex] = { ...existing, release };
    packages.push({ slug, release, synthesized });
  }
  await publishRegistry(outputRoot, registry, generatedAt, serviceWorker);
  return { release, generatedAt, packages };
}

function parseArgs(argv){
  const values = {};
  for (let index = 0; index < argv.length; index += 2){
    const key = argv[index];
    const value = argv[index + 1];
    if (!key || !key.startsWith("--") || value === undefined) throw new Error(`Invalid argument near ${key || "end"}`);
    values[key.slice(2)] = value;
  }
  return values;
}

async function main(){
  const argv = process.argv.slice(2);
  const command = argv[0] && !argv[0].startsWith("--") ? argv.shift() : "build";
  const args = parseArgs(argv);
  const outputRoot = path.resolve(args.output || "lakes");
  const serviceWorkerPath = args["service-worker"]
    ? path.resolve(args["service-worker"])
    : path.resolve(outputRoot, "..", "sw.js");
  if (command === "restamp"){
    const restamped = await restampShell({
      outputRoot,
      generatedAt:args["generated-at"] || undefined,
      serviceWorkerPath
    });
    console.log(`Shell release ${restamped.release}: ${restamped.files.length} precached files`);
    return;
  }
  if (command === "pyramid"){
    const result = await extendLakePyramid({
      slugs:(args.slug || "").split(",").map(item => item.trim()).filter(Boolean),
      minZoom:Number(args["min-zoom"]),
      outputRoot,
      generatedAt:args["generated-at"] || undefined,
      serviceWorkerPath
    });
    result.packages.forEach(item => console.log(`Package ${item.slug} ${item.release}: +${item.synthesized} downscaled tiles`));
    return;
  }
  if (command !== "build") throw new Error(`Unknown command ${command}`);
  let geometry;
  if (args.boundary){
    const source = JSON.parse(await readFile(args.boundary, "utf8"));
    geometry = Array.isArray(source.elements)
      ? polygonFromOverpass(source)
      : source.type === "Feature" ? source.geometry : source;
  } else if (args["osm-id"]){
    geometry = await fetchOsmBoundary(args["osm-id"], {
      endpoint:args.nominatim || undefined
    });
  } else {
    throw new Error("Pass --boundary <file.geojson> or --osm-id <R123>");
  }
  const result = await buildLakePackage({
    slug:args.slug,
    name:args.name,
    type:args.type,
    boundary:geometry,
    clip:args.clip ? args.clip.split(",").map(Number) : undefined,
    zoom:args.zoom,
    config:args.config || process.env.NAVIONICS_CONFIG,
    token:args.token || process.env.NAVIONICS_TOKEN,
    outputRoot,
    concurrency:args.concurrency ? Number(args.concurrency) : 6,
    generatedAt:args["generated-at"] || undefined,
    serviceWorkerPath,
  });
  console.log(`Package ${result.manifest.slug}: ${result.tileCount} tiles, ${result.downloaded} downloaded`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)){
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
