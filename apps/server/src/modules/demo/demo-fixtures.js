const demoStores = [
  { name: '三条デリバリーストア（デモ）', address: '京都市中京区 三条・河原町周辺（学習用）', latitude: 35.0093, longitude: 135.7684 },
  { name: '四条烏丸クイックマート（デモ）', address: '京都市下京区 四条烏丸周辺（学習用）', latitude: 35.0038, longitude: 135.7590 },
  { name: '御所南フレッシュ便（デモ）', address: '京都市中京区 京都御所南側（学習用）', latitude: 35.0147, longitude: 135.7635 },
  { name: '祇園デイリーストア（デモ）', address: '京都市東山区 祇園四条周辺（学習用）', latitude: 35.0036, longitude: 135.7750 },
  { name: '京都駅前スピード便（デモ）', address: '京都市下京区 京都駅北側（学習用）', latitude: 34.9887, longitude: 135.7592 },
];

const demoDropoffs = [
  { name: '東山レジデンス（デモ）', latitude: 35.0034, longitude: 135.7744, deliveryFeeYen: 500 },
  { name: '烏丸御池オフィス（デモ）', latitude: 35.0105, longitude: 135.7598, deliveryFeeYen: 450 },
  { name: '岡崎アートハウス（デモ）', latitude: 35.0163, longitude: 135.7826, deliveryFeeYen: 650 },
  { name: '二条ステーションコート（デモ）', latitude: 35.0112, longitude: 135.7452, deliveryFeeYen: 600 },
  { name: '西陣テラス（デモ）', latitude: 35.0290, longitude: 135.7522, deliveryFeeYen: 700 },
  { name: '五条リバーサイド（デモ）', latitude: 34.9957, longitude: 135.7682, deliveryFeeYen: 500 },
  { name: '七条町家ステイ（デモ）', latitude: 34.9908, longitude: 135.7671, deliveryFeeYen: 550 },
  { name: '円町学生ハウス（デモ）', latitude: 35.0182, longitude: 135.7308, deliveryFeeYen: 750 },
  { name: '出町柳リバーコート（デモ）', latitude: 35.0301, longitude: 135.7730, deliveryFeeYen: 700 },
  { name: '清水坂ゲストハウス（デモ）', latitude: 34.9978, longitude: 135.7811, deliveryFeeYen: 650 },
];

const demoCompetitors = [
  { name: '山田 つばさ（デモ）', points: [180, 180, 180, 180, 180, 180, 100, 100, 100, 100, 100] },
  { name: '佐藤 ひなた（デモ）', points: [180, 150, 150, 100, 100, 100, 100, 100] },
  { name: '河合 みなと（デモ）', points: [180, 180, 130, 130] },
  { name: '森 あかり（デモ）', points: [150, 150, 150] },
  { name: '中村 そら（デモ）', points: [100] },
];

function demoRouteKey(storeName, dropoffName) {
  return `${storeName}\u0000${dropoffName}`;
}

function chooseDemoRoute(recentRouteKeys = [], random = Math.random) {
  const recent = new Set(recentRouteKeys);
  const routes = demoStores.flatMap((store) => demoDropoffs.map((dropoff) => ({ store, dropoff })));
  const available = routes.filter(({ store, dropoff }) => !recent.has(demoRouteKey(store.name, dropoff.name)));
  const candidates = available.length ? available : routes;
  const value = Number(random());
  const safeValue = Number.isFinite(value) ? Math.min(Math.max(value, 0), 0.999999999) : 0;
  return candidates[Math.floor(safeValue * candidates.length)];
}

function scoreBreakdownForPoints(points) {
  const breakdowns = {
    100: [{ code: 'DELIVERY_COMPLETED', label: '配達完了', points: 100 }],
    130: [
      { code: 'DELIVERY_COMPLETED', label: '配達完了', points: 100 },
      { code: 'RAIN_BONUS', label: '雨天ボーナス', points: 30 },
    ],
    150: [
      { code: 'DELIVERY_COMPLETED', label: '配達完了', points: 100 },
      { code: 'LATE_NIGHT_BONUS', label: '深夜ボーナス', points: 50 },
    ],
    180: [
      { code: 'DELIVERY_COMPLETED', label: '配達完了', points: 100 },
      { code: 'RAIN_BONUS', label: '雨天ボーナス', points: 30 },
      { code: 'LATE_NIGHT_BONUS', label: '深夜ボーナス', points: 50 },
    ],
  };
  return breakdowns[points] || [];
}

async function ensureDemoStores(client) {
  const stores = [];
  for (const fixture of demoStores) {
    let store = await client.store.findFirst({ where: fixture, orderBy: { id: 'asc' } });
    if (!store) store = await client.store.create({ data: fixture });
    stores.push(store);
  }
  return stores;
}

async function ensureDemoRankings(client, stores) {
  const now = Date.now();
  const reassignedDriverIds = new Set();
  for (let competitorIndex = 0; competitorIndex < demoCompetitors.length; competitorIndex += 1) {
    const competitor = demoCompetitors[competitorIndex];
    let driver = await client.driver.findFirst({ where: { name: competitor.name }, orderBy: { id: 'asc' } });
    if (!driver) driver = await client.driver.create({ data: { name: competitor.name } });

    for (let deliveryIndex = 0; deliveryIndex < competitor.points.length; deliveryIndex += 1) {
      const points = competitor.points[deliveryIndex];
      const marker = `ランキング実績 ${competitorIndex + 1}-${deliveryIndex + 1}（デモ）`;
      let assignment = await client.assignment.findFirst({
        where: { order: { dropoffName: marker } },
        include: { scoreEvent: true },
      });
      if (assignment && assignment.driverId !== driver.id) {
        reassignedDriverIds.add(assignment.driverId);
        assignment = await client.assignment.update({
          where: { id: assignment.id },
          data: { driverId: driver.id },
          include: { scoreEvent: true },
        });
        if (assignment.scoreEvent) {
          await client.scoreEvent.update({
            where: { id: assignment.scoreEvent.id },
            data: { driverId: driver.id },
          });
        }
      }
      if (!assignment) {
        const store = stores[(competitorIndex + deliveryIndex) % stores.length];
        const dropoff = demoDropoffs[(competitorIndex * 2 + deliveryIndex) % demoDropoffs.length];
        const occurredAt = new Date(now - (competitorIndex * 24 + deliveryIndex + 1) * 60 * 60 * 1000);
        const breakdown = scoreBreakdownForPoints(points);
        const order = await client.order.create({
          data: {
            storeId: store.id,
            pickupName: store.name,
            dropoffName: marker,
            deliveryFeeYen: dropoff.deliveryFeeYen,
            dropoffLatitude: dropoff.latitude,
            dropoffLongitude: dropoff.longitude,
            status: 'DELIVERED',
          },
        });
        assignment = await client.assignment.create({
          data: {
            orderId: order.id,
            driverId: driver.id,
            acceptedAt: occurredAt,
            pickedUpAt: occurredAt,
            deliveredAt: occurredAt,
            estimatedPoints: points,
            scoreBreakdown: JSON.stringify(breakdown),
          },
        });
      }
      if (!await client.scoreEvent.findUnique({ where: { assignmentId: assignment.id } })) {
        const breakdown = scoreBreakdownForPoints(points);
        await client.scoreEvent.create({
          data: {
            driverId: driver.id,
            assignmentId: assignment.id,
            points,
            reason: breakdown.map((item) => item.label).join(' + '),
            breakdown: JSON.stringify(breakdown),
            createdAt: assignment.deliveredAt,
          },
        });
      }
    }
    const total = await client.scoreEvent.aggregate({ where: { driverId: driver.id }, _sum: { points: true } });
    await client.driver.update({ where: { id: driver.id }, data: { score: total._sum.points || 0 } });
  }
  for (const driverId of reassignedDriverIds) {
    const total = await client.scoreEvent.aggregate({ where: { driverId }, _sum: { points: true } });
    await client.driver.update({ where: { id: driverId }, data: { score: total._sum.points || 0 } });
  }
}

async function ensureHackathonDemo(client, { includeRankings = true } = {}) {
  const stores = await ensureDemoStores(client);
  if (includeRankings) await ensureDemoRankings(client, stores);
  return { stores: stores.length, competitors: includeRankings ? demoCompetitors.length : 0 };
}

async function resetHackathonDemoRankings(client) {
  const demoDrivers = await client.driver.findMany({
    where: { name: { in: demoCompetitors.map((driver) => driver.name) } },
    select: { id: true },
  });
  const driverIds = demoDrivers.map((driver) => driver.id);
  const assignments = driverIds.length
    ? await client.assignment.findMany({
      where: { driverId: { in: driverIds }, order: { dropoffName: { startsWith: 'ランキング実績 ' } } },
      select: { id: true, orderId: true },
    })
    : [];
  const assignmentIds = assignments.map((assignment) => assignment.id);
  const orderIds = assignments.map((assignment) => assignment.orderId);
  if (assignmentIds.length) {
    await client.scoreEvent.deleteMany({ where: { assignmentId: { in: assignmentIds } } });
    await client.offer.deleteMany({ where: { orderId: { in: orderIds } } });
    await client.assignment.deleteMany({ where: { id: { in: assignmentIds } } });
    await client.order.deleteMany({ where: { id: { in: orderIds } } });
  }
  if (driverIds.length) await client.driver.updateMany({ where: { id: { in: driverIds } }, data: { score: 0 } });
  const stores = await ensureDemoStores(client);
  await ensureDemoRankings(client, stores);
  return { resetDeliveries: assignments.length, competitors: demoDrivers.length };
}

module.exports = {
  chooseDemoRoute,
  demoCompetitors,
  demoDropoffs,
  demoRouteKey,
  demoStores,
  ensureHackathonDemo,
  resetHackathonDemoRankings,
  scoreBreakdownForPoints,
};
