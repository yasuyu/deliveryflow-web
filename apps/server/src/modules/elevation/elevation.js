const createGraph = require('ngraph.graph');
const { aStar } = require('ngraph.path');
const dataset = require('../../../assets/kyoto-elevation.json');
const { locationStatus } = require('../location/location');

function distance(from, to) {
  const radians = Math.PI / 180;
  const a = Math.sin((to[0] - from[0]) * radians / 2) ** 2
    + Math.cos(from[0] * radians) * Math.cos(to[0] * radians)
    * Math.sin((to[1] - from[1]) * radians / 2) ** 2;
  return 12_742_000 * Math.asin(Math.sqrt(Math.min(1, a)));
}

function sampleProfile(points, mandatoryIndices, maximum = 200) {
  if (points.length <= maximum) return points;
  const selected = new Set([0, points.length - 1, ...mandatoryIndices]);
  const buckets = Math.floor((maximum - selected.size) / 2);
  for (let bucket = 0; bucket < buckets; bucket += 1) {
    const start = Math.floor(bucket * points.length / buckets);
    const end = Math.floor((bucket + 1) * points.length / buckets);
    let low = start;
    let high = start;
    for (let i = start + 1; i < end; i += 1) {
      if (points[i].elevationMeters < points[low].elevationMeters) low = i;
      if (points[i].elevationMeters > points[high].elevationMeters) high = i;
    }
    selected.add(low);
    selected.add(high);
  }
  return [...selected].sort((a, b) => a - b).map((index) => points[index]);
}

function createElevationService(data) {
  const graph = createGraph();
  data.nodes.forEach((node, id) => graph.addNode(id, node));
  data.edges.forEach(([from, to]) => graph.addLink(from, to, distance(data.nodes[from], data.nodes[to])));
  const finder = aStar(graph, {
    oriented: true,
    distance: (_from, _to, link) => link.data,
    heuristic: (from, to) => distance(from.data, to.data),
  });
  let routingNodes = null;
  if (data.routingOrigin) {
    let anchor = null;
    let closest = Infinity;
    graph.forEachNode((node) => {
      if (node.links?.size < 3) return;
      const meters = distance(node.data, data.routingOrigin);
      if (meters < closest) { anchor = node.id; closest = meters; }
    });
    function reachable(reverse) {
      const found = new Set([anchor]);
      const queue = [anchor];
      for (let i = 0; i < queue.length; i += 1) {
        graph.forEachLinkedNode(queue[i], (node, link) => {
          if ((reverse ? link.toId : link.fromId) !== queue[i] || found.has(node.id)) return;
          found.add(node.id);
          queue.push(node.id);
        });
      }
      return found;
    }
    // Exclude isolated service roads when snapping to the central bicycle network.
    const forward = reachable(false);
    const backward = reachable(true);
    routingNodes = new Set([...forward].filter((id) => backward.has(id)));
  }
  // Spatial buckets avoid scanning the complete road network for every dashboard.
  const cells = new Map();
  const key = (latitude, longitude) => `${Math.floor(latitude * 1000)}:${Math.floor(longitude * 1000)}`;
  data.nodes.forEach((node, id) => {
    if (routingNodes && !routingNodes.has(id)) return;
    const cell = key(node[0], node[1]);
    if (!cells.has(cell)) cells.set(cell, []);
    cells.get(cell).push(id);
  });
  const cache = new Map();
  function snap(point) {
    if (!point || !Number.isFinite(point.latitude) || !Number.isFinite(point.longitude)) return null;
    const { south, north, west, east } = data.bounds;
    if (point.latitude < south || point.latitude > north || point.longitude < west || point.longitude > east) return null;
    let nearest = null;
    let best = 300;
    const lat = Math.floor(point.latitude * 1000);
    const lon = Math.floor(point.longitude * 1000);
    for (let y = -4; y <= 4; y += 1) {
      for (let x = -4; x <= 4; x += 1) {
        for (const id of cells.get(`${lat + y}:${lon + x}`) || []) {
          const meters = distance([point.latitude, point.longitude], data.nodes[id]);
          if (meters < best) { nearest = id; best = meters; }
        }
      }
    }
    return nearest;
  }
  function segment(from, to) {
    const cacheKey = `${from}:${to}`;
    if (cache.has(cacheKey)) return cache.get(cacheKey);
    const route = finder.find(from, to).reverse().map((node) => node.id);
    if (cache.size >= 256) cache.delete(cache.keys().next().value);
    cache.set(cacheKey, route);
    return route;
  }
  function profile(order, driver, pickedUp = false) {
    const stage = pickedUp ? 'TO_DROPOFF' : 'VIA_PICKUP';
    const unavailable = (reason) => ({ status: 'UNAVAILABLE', stage, reason });
    if (!pickedUp && locationStatus(driver) !== 'AVAILABLE') return unavailable('LOCATION_MISSING');
    const stops = [
      ...(!pickedUp ? [driver] : []),
      { latitude: order.store.latitude, longitude: order.store.longitude },
      { latitude: order.dropoffLatitude, longitude: order.dropoffLongitude },
    ];
    const ids = stops.map(snap);
    if (ids.includes(null)) return unavailable('OUTSIDE_COVERAGE');
    let route = [];
    let pickupIndex = 0;
    for (let i = 1; i < ids.length; i += 1) {
      const part = segment(ids[i - 1], ids[i]);
      if (!part.length) return unavailable('ROUTE_NOT_FOUND');
      route = route.concat(i === 1 ? part : part.slice(1));
      if (i === 1 && !pickedUp) pickupIndex = route.length - 1;
    }
    if (route.some((id) => !Number.isFinite(data.nodes[id][2]))) return unavailable('ELEVATION_MISSING');
    let cumulative = 0;
    const points = route.map((id, index) => {
      if (index) cumulative += distance(data.nodes[route[index - 1]], data.nodes[id]);
      return { distanceMeters: Number(cumulative.toFixed(2)), elevationMeters: data.nodes[id][2] };
    });
    const elevations = points.map((point) => point.elevationMeters);
    const minimumMeters = elevations.reduce((min, value) => Math.min(min, value), Infinity);
    const maximumMeters = elevations.reduce((max, value) => Math.max(max, value), -Infinity);
    const mandatory = [pickupIndex, elevations.indexOf(minimumMeters), elevations.indexOf(maximumMeters)];
    return {
      status: 'AVAILABLE', stage,
      totalDistanceMeters: points.at(-1).distanceMeters,
      pickupDistanceMeters: points[pickupIndex].distanceMeters,
      minimumMeters, maximumMeters,
      points: sampleProfile(points, mandatory),
    };
  }
  return { profile };
}

const service = createElevationService(dataset);
module.exports = { createElevationService, sampleProfile, elevationProfile: service.profile };
