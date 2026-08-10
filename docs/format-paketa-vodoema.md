# Формат пакета водоёма и пайплайн подготовки

Документ описывает воспроизводимый формат данных водоёма, который использует приложение, и шаги подготовки этих данных на этапе разработки. Приложение в рантайме в сеть не ходит: оно только читает готовые пакеты.

## Расположение файлов

```
/
├── index.html
├── lakes/
│   ├── index.json                  <- реестр активных release
│   ├── precache/
│   │   └── <release>.json          <- immutable список файлов для версии PWA
│   ├── registry/
│   │   └── <release>.json          <- immutable снимок реестра для версии PWA
│   └── <slug>/
│       └── <release>/
│           ├── lake.json           <- манифест водоёма
│           └── tiles/
│               └── <z>/<x>/<y>.png <- тайлы батиметрии (Web Mercator XYZ)
```

`<slug>` - латиницей, kebab-case (например `naroch`, `vileyskoe`). `<release>` - безопасная для пути версия из `generatedAt`, например `2026-08-06T12-00-00-000Z`.

## lakes/index.json

Реестр, по которому приложение строит список готовых пакетов. Водоём пользователя явно ссылается на пакет полем `packageSlug`.

```json
{
  "generatedAt": "2026-08-06T00:00:00.000Z",
  "waterbodies": [
    {
      "slug": "naroch",
      "release": "2026-08-06T00-00-00-000Z",
      "name": "Нарочь",
      "type": "lake",
      "center": [54.8600, 26.7000],
      "bbox": [26.60, 54.82, 26.80, 54.90]
    }
  ]
}
```

- `type`: `lake` | `reservoir` | `river`. Река собирается по району работ ([ADR-0008](adr/0008-paket-reki-po-rajonu.md)).
- `center`: `[lat, lon]` (порядок Leaflet).
- `bbox`: `[minLon, minLat, maxLon, maxLat]` (WGS84, порядок GeoJSON).

## lakes/<slug>/<release>/lake.json

```json
{
  "slug": "naroch",
  "release": "2026-08-06T00-00-00-000Z",
  "name": "Нарочь",
  "type": "lake",
  "crs": "EPSG:3857",
  "tileSize": 256,
  "minZoom": 16,
  "maxZoom": 16,
  "du": 1,
  "bbox": [26.60, 54.82, 26.80, 54.90],
  "center": [54.8600, 26.7000],
  "boundary": { "type": "Polygon", "coordinates": [[[26.61, 54.83], [26.79, 54.83]]] },
  "source": "Navionics SonarChart (layer=1, du=1)",
  "attribution": "© Navionics/Garmin, © OpenStreetMap",
  "generatedAt": "2026-08-06T00:00:00.000Z"
}
```

- `boundary`: GeoJSON `Polygon`/`MultiPolygon` в WGS84 (`[lon, lat]`) - береговая линия из OSM.
- `minZoom`/`maxZoom` - границы пирамиды тайлов. Приложение не даёт уменьшить масштаб ниже `minZoom`: за пределами пирамиды Leaflet начал бы уменьшать тайлы `maxZoom` и держать в памяти весь пакет сразу ([ADR-0009](adr/0009-piramida-zumov-v-pakete.md)).
- `du`: единицы глубины Navionics (`1` = метры).

## Тайлы

- Web Mercator XYZ (EPSG:3857), 256x256, исходный PNG с альфой из Navionics (`transparent=true`). PNG сохраняется без перекодирования, чтобы не терять тонкие изобаты и не вводить зависимость от конвертера.
- Именование - родное `z/x/y` Navionics, чтобы Leaflet брал их шаблоном `lakes/<slug>/<release>/tiles/{z}/{x}/{y}.png` без пересчёта координат.
- Хранятся только тайлы, пересекающие `bbox` границы.

## Пайплайн подготовки (воспроизводимо)

Все шаги - на этапе разработки, скриптом. Нужен временный доступ к Navionics через активную сессию by.fishermap.org.

1. Граница из OSM. Передать OSM id в формате `R123`, `W123` или `N123` через `--osm-id`; скрипт получает `Polygon`/`MultiPolygon` из Nominatim lookup. Nominatim индексирует только именованные объекты: для безымянного контура (например, водохранилища `R18103281`) lookup вернёт пустой список. Тогда геометрия берётся из Overpass и передаётся файлом через `--boundary`: файл принимается и как GeoJSON (`Feature`, `Polygon`, `MultiPolygon`), и как ответ Overpass `out geom` - кольца `outer` и `inner` собираются из отдельных ways, острова остаются дырками.
2. Район работ. Прямоугольник `--clip minLon,minLat,maxLon,maxLat` обрезает границу до нужного участка. Для замкнутого водоёма он не нужен, для реки обязателен: без него `bbox` растянется на всё русло из OSM ([ADR-0008](adr/0008-paket-reki-po-rajonu.md)).
3. bbox и список тайлов. Из обрезанной границы посчитать `bbox`; на выбранном зуме `Z` получить множество тайлов `z/x/y`, покрывающих `bbox`.
4. Скачать тайлы. Запрос `https://tile1.navionics.com/viewer/api/v1/tile/{z}/{x}/{y}?config=<JWT>&transparent=true&du=1&layer=1` с заголовками `authorization: Bearer <token>` и `origin`/`referer: https://by.fishermap.org`. `config` - статичный JWT продукта (`rpn`, `apr`); `Bearer` живёт 2 часа. Скрипт пропускает уже скачанные валидные PNG и ограничивает параллелизм.
5. Чистый staging. Для требуемых `z/x/y` переиспользовать валидные PNG из опубликованного пакета, остальные скачать во временный каталог. Записать туда `lake.json`; старые тайлы, которых нет в новом bbox/zoom, в staging не попадают.
6. Публикация immutable release. После полной готовности staging одним `rename` публикуется как новый каталог `lakes/<slug>/<release>`. Затем публикуются immutable снимок `lakes/registry/<release>.json` и список `lakes/precache/<release>.json`; как commit marker атомарно заменяется `lakes/index.json` с активным `release`. До смены реестра старый пакет остаётся доступен; после смены реестра приложение получает только уже опубликованный каталог. Повреждённый существующий реестр останавливает сборку и не перезаписывается.
7. Service worker. Сборщик последним встраивает `generatedAt` в `SW_VERSION` файла `sw.js`; из версии worker получает пути к своим immutable precache и registry. До начала и перед завершением установки worker сверяет опубликованный `lakes/index.json` со своей версией и прерывает install при несовпадении. Versioned registry кэшируется под ключом `lakes/index.json`, поэтому поздняя установка старой версии не смешивает старые пакеты с новым реестром. Новый worker остаётся в ожидании: `skipWaiting()` при установке не вызывается, `clients.claim()` не используется. Приложение показывает кнопку «Обновить приложение», по ней worker получает `{ type:"skip-waiting" }`, активируется, удаляет старый Cache Storage, и каждая управляемая страница перезагружается по `controllerchange` ([ADR-0007](adr/0007-obnovlenie-po-knopke.md)). Управляемое приложение обслуживает same-origin GET только из текущего precache; сетевого runtime fallback нет. Старые release остаются на диске для безопасной установки ранее загруженного worker и удаляются только отдельной осознанной процедурой.

### Запуск сборщика

Свежий `Bearer` выдаёт сама by.fishermap.org: авторизованная сессия отвечает на `POST /api/navionics-auth` полем `tokens["access-token"]`. Значения `auth_token`, `XSRF-TOKEN`, `fishermaporg_session` и `cf_clearance` берутся из devtools вкладки с картой глубин:

```bash
curl -s -X POST 'https://by.fishermap.org/api/navionics-auth' \
  -H "authorization: Bearer $FISHERMAP_TOKEN" \
  -H "x-xsrf-token: $FISHERMAP_XSRF" \
  -H 'x-requested-with: XMLHttpRequest' \
  -H 'origin: https://by.fishermap.org' \
  -H 'referer: https://by.fishermap.org/depth-map/' \
  -b "auth_token=$FISHERMAP_TOKEN; XSRF-TOKEN=$FISHERMAP_XSRF; fishermaporg_session=$FISHERMAP_SESSION; cf_clearance=$FISHERMAP_CLEARANCE" \
  | jq -r '.tokens["access-token"]'
```

Токены передавайте через окружение, чтобы они не попали в историю команд и репозиторий:

```bash
export NAVIONICS_CONFIG='<config JWT>'
export NAVIONICS_TOKEN='<Bearer без слова Bearer>'

node tools/lake-package.mjs \
  --slug naroch \
  --name Нарочь \
  --type lake \
  --osm-id R123456 \
  --zoom 14-18 \
  --generated-at 2026-08-06T12:00:00.000Z \
  --output lakes
```

Для готовой границы замените `--osm-id R123456` на `--boundary path/to/boundary.geojson`. Повторный запуск возобновляет загрузку: нужные валидные PNG копируются из активного release в чистый staging без повторного скачивания. Новый `generatedAt` создаёт новый immutable release; прежние release и их precache manifest сохраняются для уже открытых клиентов. Передавайте одинаковый `--generated-at` для побайтово воспроизводимых JSON и `sw.js`; без параметра скрипт использует текущее время. По умолчанию обновляется `sw.js` рядом с каталогом `lakes`; другой путь задаётся через `--service-worker`.

Границу безымянного контура берите из Overpass и сохраняйте в файл; ответ `out geom` передаётся в `--boundary` как есть:

```bash
curl -s https://overpass-api.de/api/interpreter \
  --data-urlencode 'data=[out:json];rel(18103281);(._;>>;);out geom;' > /tmp/gornovo.overpass.json
```

#### Река

У реки берётся отношение водной поверхности (`natural=water`), а участок задаётся `--clip`. Найти отношение по точке на берегу:

```bash
curl -s https://overpass-api.de/api/interpreter \
  --data-urlencode 'data=[out:json];rel(around:1500,52.0879,26.133923)[natural=water];out tags;'

curl -s https://overpass-api.de/api/interpreter \
  --data-urlencode 'data=[out:json];rel(7791508);out geom;' > /tmp/pripyat.overpass.json
```

```bash
node tools/lake-package.mjs \
  --slug pripyat-pinsk \
  --name 'Припять у Пинска' \
  --type river \
  --boundary /tmp/pripyat.overpass.json \
  --clip 26.111993,52.074425,26.155853,52.101375 \
  --zoom 14-18 \
  --output lakes
```

Прямоугольник задавайте в порядке `bbox`: `minLon,minLat,maxLon,maxLat`. Радиус около 1 км от точки лова - 396 тайлов на `z18` и 569 на всю пирамиду `z14-z18`; всё русло из OSM без обрезки дало бы порядка 9500 только на `z18`. `--zoom` без диапазона собирает один уровень: масштаб на карте будет зафиксирован ([ADR-0009](adr/0009-piramida-zumov-v-pakete.md)).

### Обновление оболочки без пересборки пакетов

Первым аргументом скрипт принимает команду: `build` (по умолчанию) собирает пакет водоёма, `restamp` только перевыпускает версию оболочки. `restamp` нужен после любого изменения `index.html`, `app-core.js`, `sw.js`, `manifest.webmanifest`, `icons/` или `vendor/`: без нового `SW_VERSION` установленный service worker продолжит отдавать старую копию из своего cache.

```bash
node tools/lake-package.mjs restamp
```

Команда читает текущий `lakes/index.json`, проверяет, что каталоги активных release на месте, и публикует новые `lakes/registry/<release>.json` и `lakes/precache/<release>.json` с прежними пакетами внутри, затем переключает `lakes/index.json` и встраивает новый `generatedAt` в `SW_VERSION`. Тайлы не скачиваются, каталоги `lakes/<slug>/<release>` не меняются. Поддерживаются те же `--generated-at`, `--output` и `--service-worker`. Пустой реестр и отсутствующий каталог активного пакета прерывают команду до записи `sw.js`.

### Достройка пирамиды без токена

Команда `pyramid` достраивает нижние уровни зума уже опубликованному пакету даунсемплом собственных тайлов: каждый тайл уровня `z-1` собирается усреднением 2x2 пикселей четырёх дочерних тайлов уровня `z`. Сеть и токен Navionics не нужны. Это способ починить пакет, собранный одним уровнем (`--zoom 18` без диапазона): без нижних уровней слой тайлов скрыт на обзорном масштабе ([ADR-0009](adr/0009-piramida-zumov-v-pakete.md)).

```bash
node tools/lake-package.mjs pyramid --slug gornovo,gorodishchenskoe,pripyat-pinsk --min-zoom 14
```

`--slug` принимает список через запятую: все пакеты перевыпускаются одним release с общим `generatedAt`, поэтому реестр, precache и `SW_VERSION` обновляются один раз. Верхние уровни копируются в новый release без изменений, `minZoom` манифеста опускается до `--min-zoom`. Подписи глубин при уменьшении становятся нечитаемыми - это ожидаемо, на обзоре важна заливка по глубине; при следующей полной пересборке с токеном нижние уровни лучше скачать родные (`--zoom 14-18`).

## Ограничения и оговорки

- Токен и лицензия. Bearer принадлежит подписке by.fishermap.org, не нам. Пакеты публикуются вместе с сайтом ([ADR-0005](adr/0005-publikaciya-paketov-vodoemov.md)); это перераспространение тайлов Navionics, риск ToS и копирайта принят осознанно.
- Максимальный зум. Потолок тарифа `standard_tier` - `z18` (`z19` отвечает `403`). Строить на `z18`: это самый тонкий родной зум (~0.37 м/px на широте 52°). При смене тарифа перепроверить свежим токеном.
- Покрытие SonarChart. Данных Navionics нет на многих малых водоёмах: там весь `bbox` отдаёт одинаковый пустой прозрачный PNG (334 байта). Проверяйте центральный тайл до сборки; пустое покрытие - не ошибка сборщика. Пакет с пустой батиметрией всё равно нужен: он включает экран «Карта водоёма» с границей OSM и собственными промерами. Так собрано `gornovo`.
- Река. Пакет собирается только по району работ через `--clip`; весь bbox тайлов скачивается прямоугольником, поэтому у сильно изогнутого участка часть тайлов уходит на сушу ([ADR-0008](adr/0008-paket-reki-po-rajonu.md)).
- Атрибуция. Показывать `attribution` на карте (требование источников).
- Сравнение глубин. Приложение мерит «счёт» (эхо-отсчёт), Navionics - метры; наложение сравнивает прежде всего пространственно (где бровка/яма относительно изобат), а не численно.
