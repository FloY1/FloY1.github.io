"use strict";

(function(root, factory){
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.AppCore = api;
})(typeof globalThis === "object" ? globalThis : this, function(){
  const WATERBODY_TYPES = new Set(["lake", "reservoir", "river", "unassigned"]);
  const ID_PATTERN = /^[A-Za-z0-9_-]+$/;
  const PACKAGE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  const DATA_IMAGE_PATTERN = /^data:image\/(?:jpeg|png|webp);base64,[a-z0-9+/]+=*$/i;
  const DEFAULT_REEL = { size:"3000", core:36, width:15, ratio:5.2, lineD:0.25, lineL:150 };

  function randomId(){
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function normalizePlace(place, makeId){
    if (!Array.isArray(place.lines)){
      place.lines = Array.isArray(place.measures) || place.cast != null
        ? [{ id:makeId(), name:"Луч 1", az:null, cast:place.cast || null, measures:Array.isArray(place.measures) ? place.measures : [] }]
        : [];
      delete place.measures;
      delete place.cast;
    }
    place.lines.forEach(line => {
      if (!Array.isArray(line.measures)) line.measures = [];
      if (line.az === undefined) line.az = null;
      if (line.spool === undefined) line.spool = null;
    });
    return place;
  }

  function normalizeWaterbody(waterbody, makeId){
    if (!waterbody.id) waterbody.id = makeId();
    if (!WATERBODY_TYPES.has(waterbody.type)) waterbody.type = "lake";
    if (typeof waterbody.packageSlug !== "string" || !PACKAGE_SLUG_PATTERN.test(waterbody.packageSlug)) waterbody.packageSlug = null;
    if (waterbody.type === "unassigned") waterbody.packageSlug = null;
    if (!Array.isArray(waterbody.places)) waterbody.places = [];
    waterbody.places.forEach(place => normalizePlace(place, makeId));
    return waterbody;
  }

  function normalizeDatabase(input, idFactory){
    const db = input && typeof input === "object" ? input : {};
    const makeId = typeof idFactory === "function" ? idFactory : randomId;
    const legacyPlaces = Array.isArray(db.places) ? db.places : [];
    if (!Array.isArray(db.waterbodies)) db.waterbodies = [];

    if (legacyPlaces.length){
      let unassigned = db.waterbodies.find(item => item && item.id === "unassigned");
      if (!unassigned){
        unassigned = { id:"unassigned", name:"Без привязки", type:"unassigned", packageSlug:null, places:[] };
        db.waterbodies.unshift(unassigned);
      }
      if (!Array.isArray(unassigned.places)) unassigned.places = [];
      unassigned.places.push(...legacyPlaces);
    }
    delete db.places;

    db.waterbodies = db.waterbodies
      .filter(item => item && typeof item === "object")
      .map(item => normalizeWaterbody(item, makeId));
    if (!db.reel || typeof db.reel !== "object") db.reel = { ...DEFAULT_REEL };
    if (!(Number(db.reel.ratio) > 0)) db.reel.ratio = 5.2;
    if (!Array.isArray(db.presets)) db.presets = [];
    if (typeof db.chartMeters !== "boolean") db.chartMeters = false;
    return db;
  }

  function roundHalfStep(value){
    return Math.round(Number(value) * 2) / 2;
  }

  // Majority among filled values; empty ones do not vote. Ties go to the newer
  // measure, i.e. the last one in line order, hence the >= comparison.
  function majorityValue(measures, key){
    const tally = new Map();
    let best = null;
    measures.forEach(measure => {
      const value = measure[key];
      if (value == null || value === "") return;
      const hits = (tally.get(value) || 0) + 1;
      tally.set(value, hits);
      if (!best || hits >= best.hits) best = { value, hits };
    });
    return best ? best.value : null;
  }

  function joinNotes(measures){
    const notes = [];
    measures.forEach(measure => {
      const note = typeof measure.note === "string" ? measure.note.trim() : "";
      if (note && !notes.includes(note)) notes.push(note);
    });
    return notes.join("; ");
  }

  function numeric(value){
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  // Groups measures of one line by exact turns match. Pure projection: the input
  // array is never mutated and group order follows first appearance.
  function groupMeasures(measures){
    const buckets = new Map();
    const order = [];
    (Array.isArray(measures) ? measures : []).forEach(measure => {
      if (!measure || typeof measure !== "object") return;
      const turns = Number(measure.turns);
      if (!Number.isFinite(turns)) return;
      let bucket = buckets.get(turns);
      if (!bucket){ bucket = []; buckets.set(turns, bucket); order.push(turns); }
      bucket.push(measure);
    });
    return order.map(turns => {
      const items = buckets.get(turns);
      const counts = items.map(item => numeric(item.count));
      const single = items.length === 1;
      const newest = items[items.length - 1];
      return {
        id:items[0].id,
        turns,
        size:items.length,
        measures:items,
        count:single ? counts[0] : roundHalfStep(counts.reduce((sum, value) => sum + value, 0) / counts.length),
        minCount:Math.min(...counts),
        maxCount:Math.max(...counts),
        bottom:single ? (newest.bottom || null) : majorityValue(items, "bottom"),
        mark:single ? (newest.mark || null) : majorityValue(items, "mark"),
        clip:items.some(item => !!item.clip),
        note:single ? (newest.note || "") : joinNotes(items)
      };
    });
  }

  // One raw measure replacing the whole group. Caller removes the originals.
  function mergeGroup(group, idFactory){
    const makeId = typeof idFactory === "function" ? idFactory : randomId;
    return {
      id:makeId(),
      turns:group.turns,
      count:group.count,
      bottom:group.bottom || null,
      mark:group.mark || null,
      clip:!!group.clip,
      note:group.note || ""
    };
  }

  function finite(value){
    return value !== "" && value !== null && value !== undefined && Number.isFinite(Number(value));
  }

  function validImport(data){
    const id = value => typeof value === "string" && ID_PATTERN.test(value);
    const reel = spool => spool && typeof spool === "object" &&
      ["core", "width", "lineD", "lineL"].every(key => finite(spool[key])) &&
      (spool.ratio == null || finite(spool.ratio));
    const measure = item => item && typeof item === "object" && id(item.id) &&
      finite(item.turns) && finite(item.count) &&
      (item.note == null || typeof item.note === "string");
    const spool = value => value == null || (reel(value) &&
      (value.name == null || typeof value.name === "string") &&
      (value.size == null || typeof value.size === "string"));
    const line = item => item && typeof item === "object" && id(item.id) &&
      typeof item.name === "string" && Array.isArray(item.measures) && item.measures.every(measure) &&
      (item.az == null || finite(item.az)) && (item.cast == null || finite(item.cast)) &&
      spool(item.spool);
    const place = item => item && typeof item === "object" && id(item.id) &&
      typeof item.name === "string" && (item.coords == null || typeof item.coords === "string") &&
      (item.comment == null || typeof item.comment === "string") &&
      (item.photo == null || typeof item.photo === "string" && DATA_IMAGE_PATTERN.test(item.photo)) &&
      (item.cast == null || finite(item.cast)) &&
      (Array.isArray(item.lines) ? item.lines.every(line) : Array.isArray(item.measures) && item.measures.every(measure));
    const waterbody = item => item && typeof item === "object" && id(item.id) &&
      typeof item.name === "string" && WATERBODY_TYPES.has(item.type) &&
      (item.packageSlug == null || typeof item.packageSlug === "string" && PACKAGE_SLUG_PATTERN.test(item.packageSlug)) &&
      (item.type !== "unassigned" || item.packageSlug == null) &&
      Array.isArray(item.places) && item.places.every(place);
    const preset = item => item && typeof item === "object" && id(item.id) &&
      typeof item.name === "string" && reel(item.data);

    if (!data || typeof data !== "object") return false;
    const hasLegacy = "places" in data;
    const hasCurrent = "waterbodies" in data;
    if (!hasLegacy && !hasCurrent) return false;
    if (hasLegacy && (!Array.isArray(data.places) || !data.places.every(place))) return false;
    if (hasCurrent && (!Array.isArray(data.waterbodies) || !data.waterbodies.every(waterbody))) return false;
    return (!("reel" in data) || reel(data.reel)) &&
      (!("presets" in data) || Array.isArray(data.presets) && data.presets.every(preset));
  }

  function parseCoords(value){
    if (typeof value !== "string") return null;
    const parts = value.trim().split(/\s*[,;]\s*|\s+/).filter(Boolean);
    if (parts.length !== 2) return null;
    const lat = Number(parts[0]);
    const lon = Number(parts[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
    return { lat, lon };
  }

  function destinationPoint(origin, bearingDegrees, distanceMeters){
    const radius = 6371008.8;
    const bearing = Number(bearingDegrees) * Math.PI / 180;
    const angularDistance = Number(distanceMeters) / radius;
    const lat1 = Number(origin.lat) * Math.PI / 180;
    const lon1 = Number(origin.lon) * Math.PI / 180;
    const lat2 = Math.asin(
      Math.sin(lat1) * Math.cos(angularDistance) +
      Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(bearing)
    );
    const lon2 = lon1 + Math.atan2(
      Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(lat1),
      Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(lat2)
    );
    return {
      lat:lat2 * 180 / Math.PI,
      lon:((lon2 * 180 / Math.PI + 540) % 360) - 180
    };
  }

  function projectSoundings(place, distanceForTurns){
    const origin = parseCoords(place && place.coords);
    if (!origin || typeof distanceForTurns !== "function" || !Array.isArray(place.lines)) return [];
    const result = [];
    place.lines.forEach(line => {
      if (!Number.isFinite(Number(line.az)) || line.az == null || !Array.isArray(line.measures)) return;
      const points = [];
      groupMeasures(line.measures).forEach(group => {
        const distanceMeters = Number(distanceForTurns(group.turns, line));
        if (!(distanceMeters > 0) || !Number.isFinite(distanceMeters)) return;
        const point = destinationPoint(origin, Number(line.az), distanceMeters);
        points.push({
          measureId:group.id,
          count:group.count,
          turns:group.turns,
          size:group.size,
          distanceMeters,
          lat:point.lat,
          lon:point.lon
        });
      });
      if (points.length) result.push({ lineId:line.id, name:line.name || "", origin, points });
    });
    return result;
  }

  function validLakeManifest(manifest){
    if (!manifest || typeof manifest !== "object") return false;
    if (typeof manifest.slug !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(manifest.slug)) return false;
    if (typeof manifest.release !== "string" || !/^[A-Za-z0-9-]+$/.test(manifest.release)) return false;
    if (typeof manifest.name !== "string" || !["lake", "reservoir", "river"].includes(manifest.type)) return false;
    if (manifest.crs !== "EPSG:3857" || manifest.tileSize !== 256) return false;
    if (!Number.isInteger(manifest.minZoom) || !Number.isInteger(manifest.maxZoom) || manifest.minZoom > manifest.maxZoom) return false;
    if (!Array.isArray(manifest.bbox) || manifest.bbox.length !== 4 || !manifest.bbox.every(finite)) return false;
    const [minLon, minLat, maxLon, maxLat] = manifest.bbox.map(Number);
    if (minLon >= maxLon || minLat >= maxLat || minLon < -180 || maxLon > 180 || minLat < -90 || maxLat > 90) return false;
    if (!Array.isArray(manifest.center) || manifest.center.length !== 2 || !manifest.center.every(finite)) return false;
    const boundary = manifest.boundary;
    return !!boundary && ["Polygon", "MultiPolygon"].includes(boundary.type) && Array.isArray(boundary.coordinates) && boundary.coordinates.length > 0;
  }

  return {
    DEFAULT_REEL,
    normalizeDatabase,
    validImport,
    parseCoords,
    destinationPoint,
    groupMeasures,
    mergeGroup,
    projectSoundings,
    validLakeManifest
  };
});
