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

- `type`: `lake` | `reservoir` | `river` (v1 строит только `lake` и `reservoir`).
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
- `minZoom`/`maxZoom` - один рабочий зум (в v1 равны).
- `du`: единицы глубины Navionics (`1` = метры).

## Тайлы

- Web Mercator XYZ (EPSG:3857), 256x256, исходный PNG с альфой из Navionics (`transparent=true`). PNG сохраняется без перекодирования, чтобы не терять тонкие изобаты и не вводить зависимость от конвертера.
- Именование - родное `z/x/y` Navionics, чтобы Leaflet брал их шаблоном `lakes/<slug>/<release>/tiles/{z}/{x}/{y}.png` без пересчёта координат.
- Хранятся только тайлы, пересекающие `bbox` границы.

## Пайплайн подготовки (воспроизводимо)

Все шаги - на этапе разработки, скриптом. Нужен временный доступ к Navionics через активную сессию by.fishermap.org.

1. Граница из OSM. Передать OSM id в формате `R123`, `W123` или `N123` через `--osm-id`; скрипт получает `Polygon`/`MultiPolygon` из Nominatim lookup. Nominatim индексирует только именованные объекты: для безымянного контура (например, водохранилища `R18103281`) lookup вернёт пустой список. Тогда геометрия берётся из Overpass и передаётся файлом через `--boundary`.
2. bbox и список тайлов. Из границы посчитать `bbox`; на выбранном зуме `Z` получить множество тайлов `z/x/y`, покрывающих `bbox`.
3. Скачать тайлы. Запрос `https://tile1.navionics.com/viewer/api/v1/tile/{z}/{x}/{y}?config=<JWT>&transparent=true&du=1&layer=1` с заголовками `authorization: Bearer <token>` и `origin`/`referer: https://by.fishermap.org`. `config` - статичный JWT продукта (`rpn`, `apr`); `Bearer` живёт 2 часа. Скрипт пропускает уже скачанные валидные PNG и ограничивает параллелизм.
4. Чистый staging. Для требуемых `z/x/y` переиспользовать валидные PNG из опубликованного пакета, остальные скачать во временный каталог. Записать туда `lake.json`; старые тайлы, которых нет в новом bbox/zoom, в staging не попадают.
5. Публикация immutable release. После полной готовности staging одним `rename` публикуется как новый каталог `lakes/<slug>/<release>`. Затем публикуются immutable снимок `lakes/registry/<release>.json` и список `lakes/precache/<release>.json`; как commit marker атомарно заменяется `lakes/index.json` с активным `release`. До смены реестра старый пакет остаётся доступен; после смены реестра приложение получает только уже опубликованный каталог. Повреждённый существующий реестр останавливает сборку и не перезаписывается.
6. Service worker. Сборщик последним встраивает `generatedAt` в `SW_VERSION` файла `sw.js`; из версии worker получает пути к своим immutable precache и registry. До начала и перед завершением установки worker сверяет опубликованный `lakes/index.json` со своей версией и прерывает install при несовпадении. Versioned registry кэшируется под ключом `lakes/index.json`, поэтому поздняя установка старой версии не смешивает старые пакеты с новым реестром. Новый worker ждёт закрытия вкладок под управлением старой версии, затем удаляет старый Cache Storage. `skipWaiting()` и `clients.claim()` не используются, поэтому открытая вкладка не меняет набор ресурсов посреди сессии. Управляемое приложение обслуживает same-origin GET только из текущего precache; сетевого runtime fallback нет. Старые release остаются на диске для безопасной установки ранее загруженного worker и удаляются только отдельной осознанной процедурой.

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
  --zoom 18 \
  --generated-at 2026-08-06T12:00:00.000Z \
  --output lakes
```

Для готовой границы замените `--osm-id R123456` на `--boundary path/to/boundary.geojson`. Повторный запуск возобновляет загрузку: нужные валидные PNG копируются из активного release в чистый staging без повторного скачивания. Новый `generatedAt` создаёт новый immutable release; прежние release и их precache manifest сохраняются для уже открытых клиентов. Передавайте одинаковый `--generated-at` для побайтово воспроизводимых JSON и `sw.js`; без параметра скрипт использует текущее время. По умолчанию обновляется `sw.js` рядом с каталогом `lakes`; другой путь задаётся через `--service-worker`.

Границу безымянного контура берите из Overpass и сохраняйте в файл; кольца `outer` и `inner` собираются в GeoJSON `Polygon`, острова остаются дырками:

```bash
curl -s https://overpass-api.de/api/interpreter \
  --data-urlencode 'data=[out:json];rel(18103281);(._;>>;);out geom;' > /tmp/gornovo.overpass.json
```

### Обновление оболочки без пересборки пакетов

Первым аргументом скрипт принимает команду: `build` (по умолчанию) собирает пакет водоёма, `restamp` только перевыпускает версию оболочки. `restamp` нужен после любого изменения `index.html`, `app-core.js`, `sw.js`, `manifest.webmanifest`, `icons/` или `vendor/`: без нового `SW_VERSION` установленный service worker продолжит отдавать старую копию из своего cache.

```bash
node tools/lake-package.mjs restamp
```

Команда читает текущий `lakes/index.json`, проверяет, что каталоги активных release на месте, и публикует новые `lakes/registry/<release>.json` и `lakes/precache/<release>.json` с прежними пакетами внутри, затем переключает `lakes/index.json` и встраивает новый `generatedAt` в `SW_VERSION`. Тайлы не скачиваются, каталоги `lakes/<slug>/<release>` не меняются. Поддерживаются те же `--generated-at`, `--output` и `--service-worker`. Пустой реестр и отсутствующий каталог активного пакета прерывают команду до записи `sw.js`.

## Ограничения и оговорки

- Токен и лицензия. Bearer принадлежит подписке by.fishermap.org, не нам. Пакеты публикуются вместе с сайтом ([ADR-0005](adr/0005-publikaciya-paketov-vodoemov.md)); это перераспространение тайлов Navionics, риск ToS и копирайта принят осознанно.
- Максимальный зум. Потолок тарифа `standard_tier` - `z18` (`z19` отвечает `403`). Строить на `z18`: это самый тонкий родной зум (~0.37 м/px на широте 52°). При смене тарифа перепроверить свежим токеном.
- Покрытие SonarChart. Данных Navionics нет на многих малых водоёмах: там весь `bbox` отдаёт одинаковый пустой прозрачный PNG (334 байта). Проверяйте центральный тайл до сборки; пустое покрытие - не ошибка сборщика. Пакет с пустой батиметрией всё равно нужен: он включает экран «Карта водоёма» с границей OSM и собственными промерами. Так собрано `gornovo`.
- Река. v1 не строит пакеты для рек (открытая геометрия, огромный bbox). Тип зарезервирован в модели.
- Атрибуция. Показывать `attribution` на карте (требование источников).
- Сравнение глубин. Приложение мерит «счёт» (эхо-отсчёт), Navionics - метры; наложение сравнивает прежде всего пространственно (где бровка/яма относительно изобат), а не численно.
