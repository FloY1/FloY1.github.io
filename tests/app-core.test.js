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
  assert.equal(result.waterbodies[0].places[0].lines[0].spool, null);
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
      id:"p1", name:"Пирс", lines:[{ id:"l1", name:"На яму", measures:[],
        spool:{ name:"Феникс 4000", size:"4000", core:38, width:16, ratio:5.2, lineD:0.25, lineL:150 } }]
    }]}]
  }), true);
  assert.equal(Core.validImport({
    waterbodies:[{ id:"w1", name:"Нарочь", type:"lake", places:[{
      id:"p1", name:"Пирс", lines:[{ id:"l1", name:"На яму", measures:[],
        spool:{ core:"толстая", width:16, lineD:0.25, lineL:150 } }]
    }]}]
  }), false);
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
  assert.equal(Core.validImport({ waterbodies:[{ ...baseWaterbody, type:"river", packageSlug:"pripyat-pinsk" }] }), true);
  assert.equal(Core.validImport({ waterbodies:[{ ...baseWaterbody, type:"unassigned", packageSlug:"demo-lake" }] }), false);
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

test("projectSoundings проецирует лучи с азимутом и считает каждый своей снастью", () => {
  const place = {
    id:"p1", coords:"0, 0", lines:[
      { id:"east", az:90, measures:[{ id:"m1", turns:10, count:4 }] },
      { id:"west", az:270, spool:{ name:"тяжёлая" }, measures:[{ id:"m2", turns:10, count:5 }] },
      { id:"unknown", az:null, measures:[{ id:"m3", turns:20, count:8 }] }
    ]
  };

  const seen = [];
  const projected = Core.projectSoundings(place, (turns, line) => {
    seen.push(line.id);
    return line.spool ? turns * 25 : turns * 10;
  });

  assert.deepEqual(seen, ["east", "west"]);
  assert.deepEqual(projected.map(item => item.lineId), ["east", "west"]);
  assert.equal(projected[0].points[0].distanceMeters, 100);
  assert.equal(projected[1].points[0].distanceMeters, 250);
  assert.ok(projected[0].points[0].lon > 0);
  assert.ok(projected[1].points[0].lon < 0);
});

test("groupMeasures усредняет счёт с шагом 0.5 и не трогает исходный массив", () => {
  const measures = [
    { id:"m1", turns:50, count:24 },
    { id:"m2", turns:45, count:20 },
    { id:"m3", turns:50, count:25 },
    { id:"m4", turns:50, count:26 }
  ];

  const groups = Core.groupMeasures(measures);

  assert.deepEqual(groups.map(group => group.turns), [50, 45]);
  assert.equal(groups[0].size, 3);
  assert.equal(groups[0].count, 25);
  assert.equal(groups[0].minCount, 24);
  assert.equal(groups[0].maxCount, 26);
  assert.equal(groups[1].size, 1);
  assert.equal(groups[1].count, 20);
  assert.equal(measures.length, 4);

  const half = Core.groupMeasures([{ id:"a", turns:10, count:24 }, { id:"b", turns:10, count:25 }]);
  assert.equal(half[0].count, 24.5);

  const quarter = Core.groupMeasures([
    { id:"a", turns:10, count:24 }, { id:"b", turns:10, count:24 }, { id:"c", turns:10, count:25 }
  ]);
  assert.equal(quarter[0].count, 24.5);
});

test("groupMeasures берёт дно и метку большинством, пустые не голосуют, ничью решает более новый", () => {
  const majority = Core.groupMeasures([
    { id:"m1", turns:30, count:10, bottom:"il", mark:null },
    { id:"m2", turns:30, count:10, bottom:null, mark:"snag" },
    { id:"m3", turns:30, count:10, bottom:"sand" },
    { id:"m4", turns:30, count:10, bottom:"sand" }
  ])[0];
  assert.equal(majority.bottom, "sand");
  assert.equal(majority.mark, "snag");

  const tie = Core.groupMeasures([
    { id:"m1", turns:30, count:10, bottom:"il" },
    { id:"m2", turns:30, count:10, bottom:"sand" }
  ])[0];
  assert.equal(tie.bottom, "sand");

  const empty = Core.groupMeasures([
    { id:"m1", turns:30, count:10, bottom:null },
    { id:"m2", turns:30, count:10, bottom:"" }
  ])[0];
  assert.equal(empty.bottom, null);
});

test("groupMeasures из одного замера отдаёт сам замер без округления", () => {
  const single = Core.groupMeasures([{ id:"m1", turns:30, count:24.2, bottom:"il", note:"вот тут" }])[0];

  assert.equal(single.id, "m1");
  assert.equal(single.count, 24.2);
  assert.equal(single.bottom, "il");
  assert.equal(single.note, "вот тут");
  assert.equal(single.clip, false);
});

test("mergeGroup собирает один замер: клипса по ИЛИ, заметки без дублей, новый id", () => {
  const group = Core.groupMeasures([
    { id:"m1", turns:50, count:24, bottom:"shell", mark:"spot", note:"держу тут", clip:false },
    { id:"m2", turns:50, count:25, bottom:"shell", note:"  держу тут  ", clip:true },
    { id:"m3", turns:50, count:26, bottom:"il", note:"рвал поводок" }
  ])[0];

  const merged = Core.mergeGroup(group, () => "merged-1");

  assert.deepEqual(merged, {
    id:"merged-1",
    turns:50,
    count:25,
    bottom:"shell",
    mark:"spot",
    clip:true,
    note:"держу тут; рвал поводок"
  });
});

test("projectSoundings отдаёт одну точку на повторные обороты со средним счётом", () => {
  const place = {
    id:"p1", coords:"0, 0", lines:[
      { id:"east", az:90, measures:[
        { id:"m1", turns:10, count:4 },
        { id:"m2", turns:10, count:5 },
        { id:"m3", turns:20, count:9 }
      ] }
    ]
  };

  const points = Core.projectSoundings(place, turns => turns * 10)[0].points;

  assert.equal(points.length, 2);
  assert.deepEqual(points.map(point => point.turns), [10, 20]);
  assert.deepEqual(points.map(point => point.count), [4.5, 9]);
  assert.deepEqual(points.map(point => point.size), [2, 1]);
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
