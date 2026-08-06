"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Core = require("../app-core.js");

const reel = { size:"3000", core:36, width:15, ratio:5.2, lineD:0.25, lineL:150 };

function legacyPlace(){
  return {
    id:"p1",
    name:"Старая точка",
    coords:"52.17000, 26.26000",
    measures:[{ id:"m1", turns:10, count:4 }],
    cast:80
  };
}

test("normalizeDatabase переносит legacy places в водоём Без привязки без потери замеров", () => {
  const result = Core.normalizeDatabase({ places:[legacyPlace()], reel, presets:[] }, () => "line-1");

  assert.equal(result.places, undefined);
  assert.equal(result.waterbodies.length, 1);
  assert.deepEqual(
    { id:result.waterbodies[0].id, name:result.waterbodies[0].name, type:result.waterbodies[0].type },
    { id:"unassigned", name:"Без привязки", type:"unassigned" }
  );
  assert.equal(result.waterbodies[0].places[0].id, "p1");
  assert.equal(result.waterbodies[0].places[0].lines[0].id, "line-1");
  assert.equal(result.waterbodies[0].places[0].lines[0].measures[0].id, "m1");
});

test("normalizeDatabase сохраняет существующую иерархию водоёмов", () => {
  const source = {
    waterbodies:[{
      id:"w1", name:"Нарочь", type:"lake", packageSlug:"naroch",
      places:[{ id:"p1", name:"Пирс", coords:"54.86, 26.70", lines:[] }]
    }],
    reel,
    presets:[]
  };

  const result = Core.normalizeDatabase(source);

  assert.equal(result.waterbodies[0].packageSlug, "naroch");
  assert.equal(result.waterbodies[0].places[0].name, "Пирс");
});

test("validImport проверяет каждую присутствующую схему и вложенные замеры", () => {
  assert.equal(Core.validImport({ places:[legacyPlace()], reel }), true);
  assert.equal(Core.validImport({
    waterbodies:[{ id:"w1", name:"Нарочь", type:"lake", places:[{
      id:"p1", name:"Пирс", lines:[{ id:"l1", name:"На яму", measures:[{ id:"m1", turns:20, count:6 }] }]
    }]}],
    reel
  }), true);
  assert.equal(Core.validImport({
    waterbodies:[{ id:"w1", name:"Нарочь", type:"lake", places:[{
      id:"p1", name:"Пирс", lines:[{ id:"l1", name:"На яму", measures:[{ id:"m1", turns:"нет", count:6 }] }]
    }]}]
  }), false);
  assert.equal(Core.validImport({
    places:[],
    waterbodies:[{ id:"w1", name:"Повреждённый", type:"lake", places:"нет" }]
  }), false);
  const baseWaterbody = { id:"w1", name:"Озеро", type:"lake", packageSlug:null, places:[] };
  assert.equal(Core.validImport({ waterbodies:[{ ...baseWaterbody, id:'x" onfocus="alert(1)' }] }), false);
  assert.equal(Core.validImport({ waterbodies:[{ ...baseWaterbody, type:"river", packageSlug:"demo-lake" }] }), false);
  assert.equal(Core.validImport({ waterbodies:[{
    ...baseWaterbody,
    places:[{ id:"p1", name:"Берег", photo:'x" onerror="alert(1)', lines:[] }]
  }] }), false);
});

test("parseCoords принимает lat lon и отвергает выход за диапазон", () => {
  assert.deepEqual(Core.parseCoords("52.17000, 26.26000"), { lat:52.17, lon:26.26 });
  assert.deepEqual(Core.parseCoords("52.17 26.26"), { lat:52.17, lon:26.26 });
  assert.equal(Core.parseCoords("91, 26"), null);
  assert.equal(Core.parseCoords("не координаты"), null);
});

test("destinationPoint переносит точку на восток по азимуту 90 градусов", () => {
  const point = Core.destinationPoint({ lat:0, lon:0 }, 90, 1000);

  assert.ok(Math.abs(point.lat) < 1e-6);
  assert.ok(Math.abs(point.lon - 0.0089932) < 1e-5);
});

test("projectSoundings проецирует только лучи с азимутом", () => {
  const place = {
    id:"p1", coords:"0, 0", lines:[
      { id:"east", az:90, measures:[{ id:"m1", turns:10, count:4 }] },
      { id:"unknown", az:null, measures:[{ id:"m2", turns:20, count:8 }] }
    ]
  };

  const projected = Core.projectSoundings(place, turns => turns * 10);

  assert.equal(projected.length, 1);
  assert.equal(projected[0].lineId, "east");
  assert.equal(projected[0].points[0].distanceMeters, 100);
  assert.ok(projected[0].points[0].lon > 0);
});

test("validLakeManifest проверяет локальный XYZ пакет и GeoJSON границу", () => {
  const valid = {
    slug:"demo-lake",
    release:"2026-08-06T12-04-00-000Z",
    name:"Демо-озеро",
    type:"lake",
    crs:"EPSG:3857",
    tileSize:256,
    minZoom:16,
    maxZoom:16,
    bbox:[24.02,49.83,24.05,49.86],
    center:[49.845,24.035],
    boundary:{ type:"Polygon", coordinates:[[[24.02,49.83],[24.05,49.83],[24.05,49.86],[24.02,49.83]]] }
  };

  assert.equal(Core.validLakeManifest(valid), true);
  assert.equal(Core.validLakeManifest({ ...valid, release:"../escape" }), false);
  assert.equal(Core.validLakeManifest({ ...valid, bbox:[24.05,49.83,24.02,49.86] }), false);
  assert.equal(Core.validLakeManifest({ ...valid, boundary:{ type:"Point", coordinates:[24.03,49.84] } }), false);
});
