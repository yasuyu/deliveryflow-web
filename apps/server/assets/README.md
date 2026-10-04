# Kyoto elevation dataset

`kyoto-elevation.json` is a local, processed database for a reference elevation
profile, not a navigation or safety service. No user coordinates are included.

- Coverage: 34.975–35.040 N, 135.720–135.795 E (central Kyoto).
- Roads: © OpenStreetMap contributors, [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/).
  The derived road database is offered under ODbL 1.0, separately from application
  code. Source: [OpenStreetMap](https://www.openstreetmap.org/copyright), via
  [Overpass](https://overpass-api.de/). The complete processed database and
  reconstruction script are included in this repository.
- Elevation: [GSI elevation tiles](https://maps.gsi.go.jp/development/ichiran.html),
  DEM5A followed by DEM10B at zoom 14, sampled and processed by DeliveryFlow.
  [GSI content terms](https://www.gsi.go.jp/kikakuchousei/kikakuchousei40182.html)
  apply to the underlying elevation data. Heights describe ground, not bridge
  decks or tunnel road surfaces.

Nodes contain `[latitude, longitude, elevationMeters]`; edges contain directed
node index pairs. Ways are restricted to common bicycle-compatible road classes,
with simple bicycle access and one-way tags. Turn restrictions, conditional
access, barriers, live closures, and road surface conditions are not modeled.
Road segments are sampled at intervals of at most approximately 25 m.
Snapping uses the connected central network around Kyoto City Hall, excluding
isolated service roads. Each endpoint must be within 300 m of that network.

To explicitly rebuild from public services, run `npm run data:elevation`.
This contacts Overpass and GSI only for the fixed coverage area, not user
locations. Source files are cached under Git-ignored `data/elevation-source/`.
Delete only this cache if a fresh public-data snapshot is needed. Build timestamps
and the source OSM timestamp are stored in the generated database.
Normal application startup and tests use the committed database without fetching
external route or elevation data.
