const fs = require('node:fs/promises');
const path = require('node:path');
const { distanceMeters } = require('../apps/server/src/modules/location/location');

const bounds = { south: 34.975, north: 35.04, west: 135.72, east: 135.795 };
const zoom = 14;
const cacheDirectory = path.join(__dirname, '../data/elevation-source');
const outputPath = path.join(__dirname, '../apps/server/assets/kyoto-elevation.json');

function tilePixel(latitude, longitude) {
  const scale = 2 ** zoom * 256;
  const radians = latitude * Math.PI / 180;
  const x = Math.floor((longitude + 180) / 360 * scale);
  const y = Math.floor((1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2 * scale);
  return { x: Math.floor(x / 256), y: Math.floor(y / 256), pixel: (y % 256) * 256 + x % 256 };
}

function parseTile(text) {
  const values = text.trim().split(/[,\s]+/);
  if (values.length !== 256 * 256) throw new Error('Invalid GSI tile dimensions');
  return values.map((value) => value === 'e' ? null : Number(value));
}

function bicycleDirections(tags) {
  if (['no', 'private'].includes(tags.bicycle)) return [];
  if (['no', 'private'].includes(tags.access) && !['yes', 'designated'].includes(tags.bicycle)) return [];
  const roads = ['primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street', 'service', 'cycleway', 'road'];
  if (!roads.includes(tags.highway)
    && !(['path', 'footway', 'pedestrian'].includes(tags.highway) && ['yes', 'designated'].includes(tags.bicycle))) return [];
  if (tags.motorroad === 'yes' || tags.area === 'yes') return [];
  const direction = tags['oneway:bicycle'] ?? tags.oneway ?? (tags.junction === 'roundabout' ? 'yes' : 'no');
  if (direction === '-1') return [-1];
  if (['yes', '1', 'true'].includes(direction)) return [1];
  return [1, -1];
}

async function cachedFetch(name, url, options = {}) {
  const file = path.join(cacheDirectory, name);
  try { return await fs.readFile(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(180_000), headers: {
    'User-Agent': 'DeliveryFlow-elevation-data-builder/1.0', ...options.headers,
  } });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Public data request failed: ${response.status}`);
  const text = await response.text();
  await fs.writeFile(file, text);
  // Keep public data service requests sequential and modest.
  await new Promise((resolve) => setTimeout(resolve, 1000));
  return text;
}

async function build() {
  await fs.mkdir(cacheDirectory, { recursive: true });
  const query = `[out:json][timeout:120];way[highway](${bounds.south},${bounds.west},${bounds.north},${bounds.east});out body;>;out skel qt;`;
  const osm = JSON.parse(await cachedFetch('kyoto-roads.json', 'https://overpass-api.de/api/interpreter', {
    method: 'POST', body: new URLSearchParams({ data: query }),
  }));
  if (osm.remark) throw new Error(`Incomplete OSM response: ${osm.remark}`);
  const tiles = new Map();
  async function heightAt(latitude, longitude) {
    const tile = tilePixel(latitude, longitude);
    for (const source of ['dem5a', 'dem']) {
      const key = `${source}-${tile.x}-${tile.y}`;
      if (!tiles.has(key)) {
        const text = await cachedFetch(`${key}.txt`, `https://cyberjapandata.gsi.go.jp/xyz/${source}/${zoom}/${tile.x}/${tile.y}.txt`);
        tiles.set(key, text === null ? null : parseTile(text));
        console.log(`Loaded ${key}`);
      }
      const height = tiles.get(key)?.[tile.pixel];
      if (Number.isFinite(height)) return height;
    }
    return null;
  }
  const rawNodes = new Map(osm.elements.filter((item) => item.type === 'node').map((node) => [node.id, node]));
  const nodes = [];
  const nodeIndices = new Map();
  const edges = [];
  const inside = (node) => node && node.lat >= bounds.south && node.lat <= bounds.north
    && node.lon >= bounds.west && node.lon <= bounds.east;
  async function addNode(key, latitude, longitude) {
    if (nodeIndices.has(key)) return nodeIndices.get(key);
    const index = nodes.length;
    nodes.push([Number(latitude.toFixed(6)), Number(longitude.toFixed(6)), await heightAt(latitude, longitude)]);
    nodeIndices.set(key, index);
    return index;
  }
  for (const way of osm.elements.filter((item) => item.type === 'way')) {
    const directions = bicycleDirections(way.tags || {});
    if (!directions.length) continue;
    for (let i = 1; i < way.nodes.length; i += 1) {
      const from = rawNodes.get(way.nodes[i - 1]);
      const to = rawNodes.get(way.nodes[i]);
      if (!inside(from) || !inside(to)) continue;
      const distance = distanceMeters({ latitude: from.lat, longitude: from.lon }, { latitude: to.lat, longitude: to.lon });
      const steps = Math.max(1, Math.ceil(distance / 25));
      let previous = await addNode(`osm-${from.id}`, from.lat, from.lon);
      for (let step = 1; step <= steps; step += 1) {
        const ratio = step / steps;
        const index = await addNode(step === steps ? `osm-${to.id}` : `${way.id}-${i}-${step}`,
          from.lat + (to.lat - from.lat) * ratio, from.lon + (to.lon - from.lon) * ratio);
        if (directions.includes(1)) edges.push([previous, index]);
        if (directions.includes(-1)) edges.push([index, previous]);
        previous = index;
      }
    }
  }
  const result = {
    version: 1, bounds, routingOrigin: [35.011, 135.768], generatedAt: new Date().toISOString(),
    osmTimestamp: osm.osm3s.timestamp_osm_base,
    sources: { roads: 'OpenStreetMap contributors / ODbL 1.0', elevation: 'GSI DEM5A with DEM10B fallback (processed)' },
    nodes, edges,
  };
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(result));
  console.log(`Generated ${nodes.length} nodes and ${edges.length} directed links`);
}

if (require.main === module) build().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { tilePixel, parseTile, bicycleDirections };
