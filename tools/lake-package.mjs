#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";

const MAX_LAT = 85.05112878;

const DEEPER_ENDPOINT = "https://c-triton.fishdeeper.com/web/v1/tile/global/{x}/{y}/{z}.vector";
const DEEPER_CID = "00000000-0000-0000-0000-000000000000";
const GEOMETRY_ZOOM = 18;
const LABEL_MIN_ZOOM = 12;
const LABEL_MAX_ZOOM = 18;
const DEPTH_STEP_CM = 33;
const TILE_ZOOMS = [12, 13, 14, 15, 16, 17, 18];

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

// Largest zoom at which the bbox still fits into a viewport x viewport CSS-px map,
// minus one (an overview with margin). Clamped to 3..15: the app has no base layer below.
export function computeMinZoom(bbox, options = {}){
  const viewport = options.viewport ?? 512;
  const tileSize = options.tileSize ?? 256;
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const worldX = lon => (lon + 180) / 360;
  const worldY = lat => {
    const safeLat = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
    return (1 - Math.asinh(Math.tan(safeLat * Math.PI / 180)) / Math.PI) / 2;
  };
  const spanX = Math.abs(worldX(maxLon) - worldX(minLon));
  const spanY = Math.abs(worldY(minLat) - worldY(maxLat));
  let fits = 0;
  for (let zoom = 0; zoom <= 22; zoom++){
    const scale = tileSize * 2 ** zoom;
    if (spanX * scale <= viewport && spanY * scale <= viewport) fits = zoom;
  }
  return Math.max(3, Math.min(15, fits - 1));
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

function releaseFromTimestamp(generatedAt){
  return new Date(generatedAt).toISOString().replace(/[:.]/g, "-");
}

// --- Deeper vector tile parser (Mapbox Vector Tile v2, no dependencies) ---

function readVarint(buffer, cursor){
  let shift = 0;
  let result = 0;
  let byte;
  do {
    if (cursor.offset >= buffer.length) throw new Error("Vector tile varint runs past the end of the buffer");
    byte = buffer[cursor.offset++];
    result += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  } while (byte & 0x80);
  return result;
}

function zigzag(value){
  return (value >>> 1) ^ -(value & 1);
}

function readMessageFields(buffer, start, end){
  const fields = [];
  const cursor = { offset:start };
  while (cursor.offset < end){
    const key = readVarint(buffer, cursor);
    const field = key >>> 3;
    const wire = key & 7;
    if (wire === 0){
      fields.push({ field, value:readVarint(buffer, cursor) });
    } else if (wire === 2){
      const length = readVarint(buffer, cursor);
      const chunkStart = cursor.offset;
      cursor.offset += length;
      fields.push({ field, start:chunkStart, end:chunkStart + length });
    } else if (wire === 5){
      fields.push({ field, value:buffer.readFloatLE(cursor.offset) });
      cursor.offset += 4;
    } else if (wire === 1){
      fields.push({ field, value:buffer.readDoubleLE(cursor.offset) });
      cursor.offset += 8;
    } else {
      throw new Error(`Unsupported protobuf wire type ${wire}`);
    }
  }
  return fields;
}

function readPackedVarints(buffer, start, end){
  const values = [];
  const cursor = { offset:start };
  while (cursor.offset < end) values.push(readVarint(buffer, cursor));
  return values;
}

function decodeValue(buffer, start, end){
  for (const field of readMessageFields(buffer, start, end)){
    if (field.field === 1) return buffer.toString("utf8", field.start, field.end);
    if (field.field === 2 || field.field === 3) return field.value;
    if (field.field === 4 || field.field === 5) return field.value;
    if (field.field === 6) return zigzag(field.value);
    if (field.field === 7) return Boolean(field.value);
  }
  return null;
}

function decodeGeometry(commands){
  const rings = [];
  let current = null;
  let x = 0;
  let y = 0;
  let index = 0;
  while (index < commands.length){
    const command = commands[index] & 7;
    const count = commands[index] >> 3;
    index++;
    if (command === 1){
      for (let step = 0; step < count; step++){
        x += zigzag(commands[index++]);
        y += zigzag(commands[index++]);
        current = [[x, y]];
        rings.push(current);
      }
    } else if (command === 2){
      for (let step = 0; step < count; step++){
        x += zigzag(commands[index++]);
        y += zigzag(commands[index++]);
        current.push([x, y]);
      }
    } else if (command === 7){
      if (current && current.length) current.push(current[0].slice());
    }
  }
  return rings;
}

// Decodes a Deeper MVT tile buffer into layers with fully decoded features.
// Geometry stays in tile pixel coordinates (extent grid); properties are keyed by name.
export function parseVectorTile(buffer){
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const layers = [];
  for (const field of readMessageFields(bytes, 0, bytes.length)){
    if (field.field !== 3 || field.start === undefined) continue;
    const layer = { name:"", extent:4096, features:[] };
    const keys = [];
    const values = [];
    const featureRanges = [];
    for (const entry of readMessageFields(bytes, field.start, field.end)){
      if (entry.field === 1) layer.name = bytes.toString("utf8", entry.start, entry.end);
      else if (entry.field === 5) layer.extent = entry.value;
      else if (entry.field === 3) keys.push(bytes.toString("utf8", entry.start, entry.end));
      else if (entry.field === 4) values.push(decodeValue(bytes, entry.start, entry.end));
      else if (entry.field === 2) featureRanges.push(entry);
    }
    for (const range of featureRanges){
      const feature = { id:null, type:0, properties:{}, geometry:[] };
      let tags = [];
      let geometry = [];
      for (const entry of readMessageFields(bytes, range.start, range.end)){
        if (entry.field === 1) feature.id = entry.value;
        else if (entry.field === 3) feature.type = entry.value;
        else if (entry.field === 2) tags = readPackedVarints(bytes, entry.start, entry.end);
        else if (entry.field === 4) geometry = readPackedVarints(bytes, entry.start, entry.end);
      }
      for (let i = 0; i + 1 < tags.length; i += 2) feature.properties[keys[tags[i]]] = values[tags[i + 1]];
      feature.geometry = decodeGeometry(geometry);
      layer.features.push(feature);
    }
    layers.push(layer);
  }
  return layers;
}

// Converts a tile pixel coordinate into WGS84 [lon, lat].
export function tilePixelToLonLat(tile, px, py, extent = 4096){
  const scale = 2 ** tile.z;
  const lon = (tile.x + px / extent) / scale * 360 - 180;
  const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (tile.y + py / extent) / scale))) * 180 / Math.PI;
  return [lon, lat];
}

function round7(value){
  return Math.round(value * 1e7) / 1e7;
}

function ringSignedArea(ring){
  let area = 0;
  for (let index = 0; index + 1 < ring.length; index++){
    area += ring[index][0] * ring[index + 1][1] - ring[index + 1][0] * ring[index][1];
  }
  return area / 2;
}

// Groups a feature's rings into GeoJSON polygons: a positive-area ring (in tile
// coordinates) starts a new polygon, a negative-area ring is a hole of the last one.
function ringsToPolygons(rings){
  const polygons = [];
  for (const ring of rings){
    if (ring.length < 4) continue;
    if (ringSignedArea(ring) > 0) polygons.push([ring]);
    else if (polygons.length) polygons[polygons.length - 1].push(ring);
    else polygons.push([ring]);
  }
  return polygons;
}

// Geographic rectangle [minLon, minLat, maxLon, maxLat] covered by a tile's own
// extent grid (px/py 0..extent); the tiler adds a 256-unit buffer around it.
function tileGeoRect(tile, extent){
  const [lonMin, latMax] = tilePixelToLonLat(tile, 0, 0, extent);
  const [lonMax, latMin] = tilePixelToLonLat(tile, extent, extent, extent);
  return [lonMin, latMin, lonMax, latMax];
}

function intersectRect(a, b){
  const rect = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
  return rect[0] < rect[2] && rect[1] < rect[3] ? rect : null;
}

function clipTilePolygon(polygon, tile, extent, rect){
  const output = [];
  for (let index = 0; index < polygon.length; index++){
    const ring = polygon[index].map(([px, py]) => tilePixelToLonLat(tile, px, py, extent));
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) ring.push(first.slice());
    const clipped = clipRing(ring, rect);
    if (!clipped){
      if (index === 0) return null;
      continue;
    }
    output.push(clipped.map(([lon, lat]) => [round7(lon), round7(lat)]));
  }
  return output.length ? output : null;
}

// Builds bathymetry.json from decoded Deeper tiles: depth bands from the geometry
// zoom (z18), labels from every z12..z18 level. Tiles: [{ z, x, y, buffer }].
export function assembleBathymetry(tiles, bbox, options = {}){
  const geometryZoom = options.geometryZoom ?? GEOMETRY_ZOOM;
  const bands = new Map();
  const labels = {};
  const labelSeen = new Map();
  for (const tile of tiles){
    if (!tile.buffer || !tile.buffer.length) continue;
    const layers = parseVectorTile(tile.buffer);
    if (tile.z === geometryZoom){
      const depth = layers.find(layer => layer.name === "depth");
      // Clip depth rings to the tile's OWN extent first (removes the 256-unit
      // buffer overlap that would otherwise paint a neighbour's band across a
      // seam), intersected with the package bbox as the second step.
      if (depth){
        const clipRect = intersectRect(tileGeoRect(tile, depth.extent), bbox);
        if (clipRect){
          for (const feature of depth.features){
            if (feature.type !== 3) continue;
            const depthValue = Number(feature.properties.depth) || 0;
            const depthMaxValue = Number(feature.properties.depth_max) || depthValue + DEPTH_STEP_CM;
            let band = bands.get(depthValue);
            if (!band){
              band = { depth:depthValue, depthMax:depthMaxValue, polygons:[] };
              bands.set(depthValue, band);
            } else {
              band.depthMax = Math.max(band.depthMax, depthMaxValue);
            }
            for (const polygon of ringsToPolygons(feature.geometry)){
              const clipped = clipTilePolygon(polygon, tile, depth.extent, clipRect);
              if (clipped) band.polygons.push(clipped);
            }
          }
        }
      }
    }
    if (tile.z >= LABEL_MIN_ZOOM && tile.z <= LABEL_MAX_ZOOM){
      const layer = layers.find(item => item.name === "depth_labels");
      if (layer){
        const key = String(tile.z);
        const bucket = labels[key] || (labels[key] = []);
        let seen = labelSeen.get(key);
        if (!seen){
          seen = new Set();
          labelSeen.set(key, seen);
        }
        for (const feature of layer.features){
          if (feature.type !== 1) continue;
          const point = feature.geometry[0] && feature.geometry[0][0];
          if (!point) continue;
          // Drop points that fall in the tile buffer (outside 0..extent): the
          // neighbouring tile owns them, so this avoids cross-tile duplicates.
          if (point[0] < 0 || point[0] > layer.extent || point[1] < 0 || point[1] > layer.extent) continue;
          const [lon, lat] = tilePixelToLonLat(tile, point[0], point[1], layer.extent);
          // Labels follow the same package bbox clip as depth bands.
          if (lon < bbox[0] || lon > bbox[2] || lat < bbox[1] || lat > bbox[3]) continue;
          const roundedLon = round7(lon);
          const roundedLat = round7(lat);
          const text = feature.properties.dl_m == null ? "" : String(feature.properties.dl_m);
          const id = `${roundedLon},${roundedLat},${text}`;
          if (seen.has(id)) continue;
          seen.add(id);
          bucket.push([roundedLon, roundedLat, text]);
        }
      }
    }
  }
  const bandList = [...bands.values()]
    .filter(band => band.polygons.length)
    .sort((left, right) => left.depth - right.depth);
  const depthMax = bandList.reduce((max, band) => Math.max(max, band.depthMax), 0);
  return { depthUnit:"cm", depthStep:DEPTH_STEP_CM, depthMax, bands:bandList, labels };
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

function defaultSleep(ms){
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchDeeperTile(tile, options){
  if (!options.token) throw new Error(`Tile ${tile.z}/${tile.x}/${tile.y} is missing from the cache and DEEPER_TOKEN is empty`);
  const url = new URL(options.endpoint
    .replace("{x}", String(tile.x))
    .replace("{y}", String(tile.y))
    .replace("{z}", String(tile.z)));
  url.searchParams.set("token", options.token);
  url.searchParams.set("cid", options.cid);
  let delay = options.backoff;
  for (let attempt = 1; ; attempt++){
    let response;
    try {
      response = await options.fetchImpl(url, {
        headers:{
          accept:"*/*",
          origin:"https://maps.fishdeeper.com",
          referer:"https://maps.fishdeeper.com/",
          "user-agent":"Mozilla/5.0 (karta-dna-site lake package builder)"
        }
      });
    } catch(error){
      if (attempt >= options.retries) throw error;
      await options.sleep(delay);
      delay *= 2;
      continue;
    }
    if (response.status === 200) return Buffer.from(await response.arrayBuffer());
    if (response.status === 404) return Buffer.alloc(0);
    if (response.status === 403) throw new Error("Deeper token expired (HTTP 403)");
    if (response.status === 504){
      if (attempt >= options.retries) throw new Error(`Tile ${tile.z}/${tile.x}/${tile.y} kept timing out after ${options.retries} attempts`);
      await options.sleep(delay);
      delay *= 2;
      continue;
    }
    throw new Error(`Tile ${tile.z}/${tile.x}/${tile.y} returned HTTP ${response.status}`);
  }
}

// Reads a tile from the .deeper-cache first (0-byte file = downloaded empty tile);
// on a miss fetches from the network and stores it without overwriting existing files.
async function loadTile(tile, options){
  const relative = `${tile.z}/${tile.x}/${tile.y}.mvt`;
  const cachePath = path.join(options.cacheDir, relative);
  try {
    return { buffer:await readFile(cachePath), fromCache:true };
  } catch(error){
    if (error.code !== "ENOENT") throw error;
  }
  const buffer = await fetchDeeperTile(tile, options);
  if (!await pathExists(cachePath)) await writeFileAtomic(cachePath, buffer);
  return { buffer, fromCache:false };
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

function resolveTileOptions(options){
  return {
    token:options.token ?? process.env.DEEPER_TOKEN ?? "",
    cacheDir:options.cacheDir ?? path.resolve(".deeper-cache"),
    endpoint:options.endpoint ?? DEEPER_ENDPOINT,
    cid:options.cid ?? DEEPER_CID,
    fetchImpl:options.fetchImpl ?? fetch,
    concurrency:options.concurrency ?? 3,
    retries:options.retries ?? 6,
    backoff:options.backoff ?? 2000,
    sleep:options.sleep ?? defaultSleep
  };
}

// Builds one package into an immutable release WITHOUT touching the shared
// registry/precache/index.json - the caller publishes those once for the batch.
async function stagePackage(pkg, shared){
  const { slug, name, type, boundary, clip } = pkg;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug || "")) throw new Error("Slug must be kebab-case ASCII");
  if (typeof name !== "string" || !name.trim()) throw new Error("Name is required");
  if (!["lake", "reservoir", "river"].includes(type)) throw new Error("Type must be lake, reservoir or river");

  const geometry = clip ? clipGeometryToBbox(boundary, clip) : boundary;
  const bbox = bboxFromGeometry(geometry);
  const minZoom = computeMinZoom(bbox);
  const maxZoom = 22;

  const tiles = [];
  for (const level of TILE_ZOOMS){
    for (const tile of tilesForBbox(bbox, level)) tiles.push(tile);
  }

  const packageDir = path.join(shared.outputRoot, slug, shared.release);
  const stagingDir = `${packageDir}.staging`;
  await rm(stagingDir, { recursive:true, force:true });
  await mkdir(stagingDir, { recursive:true });

  let downloaded = 0;
  try {
    const loaded = new Array(tiles.length);
    await runWorkers(tiles.map((tile, index) => ({ tile, index })), shared.tile.concurrency, async ({ tile, index }) => {
      const result = await loadTile(tile, shared.tile);
      if (!result.fromCache) downloaded++;
      loaded[index] = { z:tile.z, x:tile.x, y:tile.y, buffer:result.buffer };
    });
    const bathymetry = assembleBathymetry(loaded, bbox);
    const manifest = {
      slug,
      release:shared.release,
      name:name.trim(),
      type,
      format:2,
      bathymetry:"bathymetry.json",
      minZoom,
      maxZoom,
      bbox,
      center:[(bbox[1] + bbox[3]) / 2, (bbox[0] + bbox[2]) / 2],
      boundary:geometry,
      source:"Deeper fishdeeper.com (vector z18)",
      attribution:"© Deeper, © OpenStreetMap",
      generatedAt:shared.generatedAt
    };
    await writeFileAtomic(path.join(stagingDir, "bathymetry.json"), JSON.stringify(bathymetry, null, 2) + "\n");
    await writeFileAtomic(path.join(stagingDir, "lake.json"), JSON.stringify(manifest, null, 2) + "\n");
    await publishRelease(stagingDir, packageDir);
    return {
      summary:{ slug, release:shared.release, name:manifest.name, type, center:manifest.center, bbox },
      manifest,
      tileCount:tiles.length,
      downloaded,
      bands:bathymetry.bands.length
    };
  } catch(error){
    await rm(stagingDir, { recursive:true, force:true });
    throw error;
  }
}

export async function buildLakePackage(options){
  const generatedAtInput = options.generatedAt ?? new Date().toISOString();
  const tile = resolveTileOptions(options);
  if (!Number.isInteger(tile.concurrency) || tile.concurrency < 1 || tile.concurrency > 3) throw new Error("Concurrency must be an integer from 1 to 3");
  if (typeof generatedAtInput !== "string" || Number.isNaN(Date.parse(generatedAtInput))) throw new Error("Generated timestamp must be ISO-8601");

  const generatedAt = new Date(generatedAtInput).toISOString();
  const release = releaseFromTimestamp(generatedAt);
  const registry = await readRegistry(options.outputRoot, generatedAt);
  const serviceWorker = await prepareServiceWorker(options.serviceWorkerPath, generatedAt);

  const staged = await stagePackage(
    { slug:options.slug, name:options.name, type:options.type, boundary:options.boundary, clip:options.clip },
    { outputRoot:options.outputRoot, generatedAt, release, tile }
  );
  const existingIndex = registry.waterbodies.findIndex(item => item.slug === options.slug);
  if (existingIndex >= 0) registry.waterbodies[existingIndex] = staged.summary;
  else registry.waterbodies.push(staged.summary);
  await publishRegistry(options.outputRoot, registry, generatedAt, serviceWorker);
  return { manifest:staged.manifest, tileCount:staged.tileCount, downloaded:staged.downloaded, bands:staged.bands };
}

// Builds several packages into ONE release: stage and publish every package, then
// write registry/precache/index.json and stamp SW_VERSION once for all slugs.
export async function buildLakePackageBatch(options){
  const { packages, outputRoot, serviceWorkerPath } = options;
  if (!Array.isArray(packages) || !packages.length) throw new Error("Batch must contain at least one package");
  const generatedAtInput = options.generatedAt ?? new Date().toISOString();
  const tile = resolveTileOptions(options);
  if (!Number.isInteger(tile.concurrency) || tile.concurrency < 1 || tile.concurrency > 3) throw new Error("Concurrency must be an integer from 1 to 3");
  if (typeof generatedAtInput !== "string" || Number.isNaN(Date.parse(generatedAtInput))) throw new Error("Generated timestamp must be ISO-8601");

  const generatedAt = new Date(generatedAtInput).toISOString();
  const release = releaseFromTimestamp(generatedAt);
  const registry = await readRegistry(outputRoot, generatedAt);
  const serviceWorker = await prepareServiceWorker(serviceWorkerPath, generatedAt);
  const shared = { outputRoot, generatedAt, release, tile };

  const built = [];
  let tileCount = 0;
  let downloaded = 0;
  for (const pkg of packages){
    const staged = await stagePackage(pkg, shared);
    const existingIndex = registry.waterbodies.findIndex(item => item.slug === pkg.slug);
    if (existingIndex >= 0) registry.waterbodies[existingIndex] = staged.summary;
    else registry.waterbodies.push(staged.summary);
    built.push({ slug:pkg.slug, release, bands:staged.bands, tileCount:staged.tileCount, downloaded:staged.downloaded });
    tileCount += staged.tileCount;
    downloaded += staged.downloaded;
  }
  await publishRegistry(outputRoot, registry, generatedAt, serviceWorker);
  return { release, generatedAt, packages:built, tileCount, downloaded };
}

async function loadBoundaryFile(file){
  const source = JSON.parse(await readFile(file, "utf8"));
  return Array.isArray(source.elements)
    ? polygonFromOverpass(source)
    : source.type === "Feature" ? source.geometry : source;
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
  if (command !== "build") throw new Error(`Unknown command ${command}`);
  if (args.batch){
    const spec = JSON.parse(await readFile(args.batch, "utf8"));
    if (!Array.isArray(spec) || !spec.length) throw new Error("Batch file must contain a non-empty JSON array of packages");
    const packages = [];
    for (const entry of spec){
      if (!entry || !entry.boundary) throw new Error("Every batch entry needs a boundary geojson path");
      packages.push({
        slug:entry.slug,
        name:entry.name,
        type:entry.type,
        boundary:await loadBoundaryFile(path.resolve(entry.boundary)),
        clip:entry.clip ? String(entry.clip).split(",").map(Number) : undefined
      });
    }
    const batch = await buildLakePackageBatch({
      packages,
      token:args.token || process.env.DEEPER_TOKEN,
      cacheDir:args.cache ? path.resolve(args.cache) : undefined,
      outputRoot,
      concurrency:args.concurrency ? Number(args.concurrency) : undefined,
      generatedAt:args["generated-at"] || undefined,
      serviceWorkerPath
    });
    console.log(`Batch release ${batch.release}: ${batch.packages.length} packages, ${batch.tileCount} tiles (${batch.downloaded} downloaded)`);
    batch.packages.forEach(item => console.log(`  ${item.slug}: ${item.bands} depth bands`));
    return;
  }
  let geometry;
  if (args.boundary){
    geometry = await loadBoundaryFile(args.boundary);
  } else if (args["osm-id"]){
    geometry = await fetchOsmBoundary(args["osm-id"], {
      endpoint:args.nominatim || undefined
    });
  } else {
    throw new Error("Pass --batch <file.json>, --boundary <file.geojson> or --osm-id <R123>");
  }
  const result = await buildLakePackage({
    slug:args.slug,
    name:args.name,
    type:args.type,
    boundary:geometry,
    clip:args.clip ? args.clip.split(",").map(Number) : undefined,
    token:args.token || process.env.DEEPER_TOKEN,
    cacheDir:args.cache ? path.resolve(args.cache) : undefined,
    outputRoot,
    concurrency:args.concurrency ? Number(args.concurrency) : undefined,
    generatedAt:args["generated-at"] || undefined,
    serviceWorkerPath
  });
  console.log(`Package ${result.manifest.slug}: ${result.tileCount} tiles (${result.downloaded} downloaded), ${result.bands} depth bands`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)){
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
