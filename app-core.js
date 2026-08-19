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
  // Диаметр намотки по кромке и ширина шпули по размеру катушки (ADR-0011).
  // Кромка выведена из типовой лесоёмкости размера, а не измерена: до замера
  // штангенциркулем это лишь заготовка.
  const SPOOL_SIZES = {
    "1000":[33,13], "1500":[35,13], "2000":[38,14], "2500":[41,14], "3000":[44,15],
    "3500":[46,15], "4000":[47,16], "4500":[49,17], "5000":[52,17], "6000":[57,18],
    "8000":[65,20], "10000":[69,22]
  };
  // Медианное отношение кромки к сердечнику по таблице выше. Нужно только для
  // «своего размера», где таблица не поможет.
  const LIP_PER_CORE = 1.24;
  const DEFAULT_REEL = { size:"3000", lipD:44, width:15, ratio:5.2, lineD:0.25, lineL:150 };

  // Старые сохранения держали диаметр сердечника и мотали леску вверх от него,
  // из-за чего дальность занижалась. Переводим на диаметр намотки один раз.
  function normalizeSpool(spool){
    if (!spool || typeof spool !== "object") return spool;
    if (!Number.isFinite(Number(spool.lipD)) || Number(spool.lipD) <= 0){
      const bySize = SPOOL_SIZES[spool.size];
      const core = Number(spool.core);
      spool.lipD = bySize ? bySize[0]
        : Number.isFinite(core) && core > 0 ? Math.round(core * LIP_PER_CORE)
        : DEFAULT_REEL.lipD;
    }
    delete spool.core;
    return spool;
  }

  /* Перевод оборотов ручки в метры.
     Намотка разматывается ВНУТРЬ от кромки: первый сошедший виток - самый длинный,
     дальше диаметр падает на два диаметра лески за слой. Дальность задаёт диаметр
     намотки; сердечник и степень заполнения знать не нужно (ADR-0011).
     lengthFromOuter и turnsFromOuter обходят одну и ту же последовательность слоёв,
     поэтому metersToTurns и turnsToMeters строго обратны друг другу. */
  function spoolOK(s){ return !!s && s.lipD > 0 && s.width > 0 && s.lineD > 0.01; }
  function perLayer(s){ return Math.max(1, Math.floor(s.width / s.lineD)); }
  function layerDiameter(k, s){ return (s.lipD - (2*k+1)*s.lineD)/1000; }
  function ratioOf(s){ return s.ratio > 0 ? s.ratio : 1; }

  function lengthFromOuter(rotorTurns, s){   // метров лески в первых rotorTurns витках от кромки
    if (!spoolOK(s) || rotorTurns <= 0) return 0;
    const N = perLayer(s); let rem = rotorTurns, len = 0, k = 0;
    while (rem > 0 && k < 600){
      const D = layerDiameter(k, s); if (D <= 0) break;
      if (rem >= N){ len += Math.PI*D*N; rem -= N; k++; }
      else { len += Math.PI*D*rem; rem = 0; }
    }
    return len;
  }
  function turnsFromOuter(meters, s){        // витков ротора, чтобы снять meters метров от кромки
    if (!spoolOK(s) || meters <= 0) return 0;
    const N = perLayer(s); let rem = meters, turns = 0, k = 0;
    while (rem > 0 && k < 600){
      const D = layerDiameter(k, s); if (D <= 0) break;
      const layer = Math.PI * D * N;
      if (rem >= layer){ turns += N; rem -= layer; k++; }
      else { turns += rem / (Math.PI*D); rem = 0; }
    }
    return turns;
  }
  function spoolTurns(s){ return turnsFromOuter(s.lineL, s); }
  function metersToTurns(x, s){
    if (!spoolOK(s) || x <= 0) return 0;
    const L = s.lineL;
    return turnsFromOuter(x > L ? L : x, s) / ratioOf(s);
  }
  function turnsToMeters(t, s){
    if (!spoolOK(s)) return 0;
    let rt = t * ratioOf(s); if (rt <= 0) return 0;
    const cap = spoolTurns(s); if (rt > cap) rt = cap;
    return lengthFromOuter(rt, s);
  }
  function handleTurns(s){ return spoolOK(s) ? spoolTurns(s) / ratioOf(s) : 0; }

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
      if (line.spool) normalizeSpool(line.spool);
      if (!validTarget(line.target)) line.target = null;
    });
    return place;
  }

  // Цель важнее азимута: она задана геометрией карты, а не компасом (ADR-0012).
  function validTarget(target){
    return !!target && typeof target === "object" &&
      Number.isFinite(Number(target.lat)) && Number.isFinite(Number(target.lon)) &&
      Math.abs(Number(target.lat)) <= 90 && Math.abs(Number(target.lon)) <= 180;
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
    normalizeSpool(db.reel);
    if (!Array.isArray(db.presets)) db.presets = [];
    db.presets.forEach(preset => { if (preset && preset.data) normalizeSpool(preset.data); });
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
    // Принимаем оба формата: старые выгрузки несут сердечник, новые - диаметр
    // намотки. Перевод делает normalizeSpool уже после проверки.
    const reel = spool => spool && typeof spool === "object" &&
      ["width", "lineD", "lineL"].every(key => finite(spool[key])) &&
      (finite(spool.lipD) || finite(spool.core)) &&
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
      (item.target == null || validTarget(item.target)) &&
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

  // Истинный пеленг из точки в точку. Нужен, когда направление луча задано
  // целью на карте, а не компасом (ADR-0012).
  function bearingTo(origin, target){
    const lat1 = Number(origin.lat) * Math.PI / 180;
    const lat2 = Number(target.lat) * Math.PI / 180;
    const dLon = (Number(target.lon) - Number(origin.lon)) * Math.PI / 180;
    const y = Math.sin(dLon) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }

  // Цель важнее азимута: компас даёт склонение и наводку, карта - чистую геометрию.
  function lineBearing(line, origin){
    if (validTarget(line.target)) return bearingTo(origin, line.target);
    return line.az == null || !Number.isFinite(Number(line.az)) ? null : Number(line.az);
  }

  function projectSoundings(place, distanceForTurns){
    const origin = parseCoords(place && place.coords);
    if (!origin || typeof distanceForTurns !== "function" || !Array.isArray(place.lines)) return [];
    const result = [];
    place.lines.forEach(line => {
      if (!Array.isArray(line.measures)) return;
      const bearing = lineBearing(line, origin);
      if (bearing == null) return;
      const points = [];
      groupMeasures(line.measures).forEach(group => {
        const distanceMeters = Number(distanceForTurns(group.turns, line));
        if (!(distanceMeters > 0) || !Number.isFinite(distanceMeters)) return;
        const point = destinationPoint(origin, bearing, distanceMeters);
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

  function depthColor(cm, depthMax) {
    if (depthMax <= 0) return "#0b2e4f";
    const t = Math.max(0, Math.min(1, cm / depthMax));
    const r = Math.round(127 + t * (11 - 127));
    const g = Math.round(212 + t * (46 - 212));
    const b = Math.round(255 + t * (79 - 255));
    return "#" + r.toString(16).padStart(2, "0") + g.toString(16).padStart(2, "0") + b.toString(16).padStart(2, "0");
  }

  function labelZoom(zoom) {
    return Math.max(12, Math.min(18, Math.round(zoom)));
  }

  // Greedy pixel-grid decluttering: keep a label only if no kept label is
  // closer than dx/dy pixels. Points come sorted by priority (first wins).
  function declutterLabels(points, dx, dy){
    const cellW = Math.max(1, dx), cellH = Math.max(1, dy);
    const cells = new Map();
    const kept = [];
    points.forEach((point, index) => {
      const col = Math.floor(point.x / cellW), row = Math.floor(point.y / cellH);
      for (let dc = -1; dc <= 1; dc++){
        for (let dr = -1; dr <= 1; dr++){
          const bucket = cells.get((col + dc) + ":" + (row + dr));
          if (!bucket) continue;
          for (const other of bucket){
            if (Math.abs(other.x - point.x) < dx && Math.abs(other.y - point.y) < dy) return;
          }
        }
      }
      const key = col + ":" + row;
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key).push(point);
      kept.push(index);
    });
    return kept;
  }

  function validLakeManifest(manifest){
    if (!manifest || typeof manifest !== "object") return false;
    if (typeof manifest.slug !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(manifest.slug)) return false;
    if (typeof manifest.release !== "string" || !/^[A-Za-z0-9-]+$/.test(manifest.release)) return false;
    if (typeof manifest.name !== "string" || !["lake", "reservoir", "river"].includes(manifest.type)) return false;
    if (manifest.format === 2) {
      if (typeof manifest.bathymetry !== "string") return false;
    } else {
      if (manifest.crs !== "EPSG:3857" || manifest.tileSize !== 256) return false;
    }
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
    SPOOL_SIZES,
    normalizeDatabase,
    normalizeSpool,
    spoolOK,
    perLayer,
    spoolTurns,
    metersToTurns,
    turnsToMeters,
    handleTurns,
    bearingTo,
    lineBearing,
    validImport,
    parseCoords,
    destinationPoint,
    groupMeasures,
    mergeGroup,
    projectSoundings,
    validLakeManifest,
    depthColor,
    labelZoom,
    declutterLabels
  };
});
