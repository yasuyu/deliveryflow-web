const http = require('http');
const fs = require('fs');
const path = require('path');
const { createHash, randomBytes, randomUUID, scrypt: scryptCallback, timingSafeEqual } = require('crypto');
const { promisify } = require('util');
const {
  buildScoreSnapshot,
  parseBreakdown,
  scoreRuleCodes,
} = require('./modules/score/score-bonuses');
const {
  demoLocation,
  distanceMeters,
  locationHasExpired,
  locationRetentionMilliseconds,
  locationSources,
  locationStatus,
  normalizedLocation,
} = require('./modules/location/location');
const { nearestDrivers } = require('./modules/matching/matching');
const { createRealtimeHub } = require('./modules/realtime/realtime');
const {
  chooseDemoRoute,
  demoDropoffs,
  demoRouteKey,
  demoStores,
  ensureHackathonDemo,
} = require('./modules/demo/demo-fixtures');

const maximumJsonBodyBytes = 1_000_000;
const scrypt = promisify(scryptCallback);
const loginAttemptWindowMilliseconds = 15 * 60 * 1000;
const maximumLoginFailures = 5;
const scoreWindowDays = 14;
const rankingLimit = 10;
const recentDemoRouteLimit = 6;
const japanUtcOffsetMilliseconds = 9 * 60 * 60 * 1000;
const monthlyRankingTitles = new Map([
  [1, '月間チャンピオン'],
  [2, '月間準優勝'],
  [3, '月間トップ3'],
]);
const driverTitles = [
  { code: 'ROOKIE', name: 'ルーキー', minimumScore: 0 },
  { code: 'BRONZE', name: 'ブロンズ', minimumScore: 500 },
  { code: 'SILVER', name: 'シルバー', minimumScore: 1500 },
  { code: 'GOLD', name: 'ゴールド', minimumScore: 3000 },
];
const loginFailures = new Map();
let simulatedWeatherCondition = 'CLEAR';
const startedAt = Date.now();
const metrics = {
  requestCount: 0,
  serverErrorCount: 0,
  totalResponseMilliseconds: 0,
};

const databaseProvider = process.env.DATABASE_PROVIDER || 'sqlite';
if (!['sqlite', 'postgresql'].includes(databaseProvider)) {
  throw new Error('DATABASE_PROVIDER must be sqlite or postgresql');
}
const prismaClientPath = databaseProvider === 'postgresql'
  ? '../../../generated/client-postgresql'
  : '../../../generated/client-v2';
const { PrismaClient } = require(prismaClientPath);

function positiveIntegerFromEnv(name, defaultValue) {
  const rawValue = process.env[name];
  if (rawValue === undefined || rawValue === '') return defaultValue;

  const value = Number(rawValue);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL must be set. Copy .env.example to .env first.');
}

const prisma = new PrismaClient();
let realtimeHub;
const port = positiveIntegerFromEnv('PORT', 3000);
const offerTtlMilliseconds = positiveIntegerFromEnv('OFFER_TTL_SECONDS', 30) * 1000;
const offerCandidateLimit = positiveIntegerFromEnv('OFFER_CANDIDATE_LIMIT', 3);
const simulatedScoreDate = process.env.SCORE_BONUS_SIMULATED_NOW
  ? new Date(process.env.SCORE_BONUS_SIMULATED_NOW)
  : null;
if (simulatedScoreDate && Number.isNaN(simulatedScoreDate.getTime())) {
  throw new Error('SCORE_BONUS_SIMULATED_NOW must be an ISO 8601 date-time');
}

function scoreEvaluationTime() {
  return simulatedScoreDate ? new Date(simulatedScoreDate) : new Date();
}

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function json(response, status, body) {
  response.writeHead(status, {
    ...securityHeaders(),
    'Content-Type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(body));
}

function logRequest(request, response, requestId, startedRequestAt) {
  const durationMilliseconds = Date.now() - startedRequestAt;
  metrics.requestCount += 1;
  metrics.totalResponseMilliseconds += durationMilliseconds;
  if (response.statusCode >= 500) metrics.serverErrorCount += 1;

  // Do not log the query string or headers: they can contain credentials or personal data.
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: response.statusCode >= 500 ? 'error' : 'info',
    event: 'http_request',
    requestId,
    method: request.method,
    path: new URL(request.url, `http://${request.headers.host}`).pathname,
    statusCode: response.statusCode,
    durationMilliseconds,
  }));
}

function metricsBody() {
  const averageResponseMilliseconds = metrics.requestCount
    ? Number((metrics.totalResponseMilliseconds / metrics.requestCount).toFixed(2))
    : 0;
  return {
    status: 'ok',
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    requests: metrics.requestCount,
    serverErrors: metrics.serverErrorCount,
    averageResponseMilliseconds,
  };
}

function securityHeaders() {
  return {
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data: https://tile.openstreetmap.org; connect-src 'self' ws://localhost:* ws://127.0.0.1:*; style-src 'self'; font-src 'self'; script-src 'self'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  };
}

function publicDriver(driver) {
  const {
    accessTokenHash,
    pinHash,
    latitude,
    longitude,
    locationAccuracyMeters,
    locationUpdatedAt,
    locationSource,
    ...safeDriver
  } = driver;
  return safeDriver;
}

function publicLocation(driver) {
  const status = locationStatus(driver);
  const source = status === 'AVAILABLE'
    ? driver.locationSource || locationSources.device
    : null;
  return {
    status,
    source,
    label: source === locationSources.demo ? demoLocation.label : null,
    coordinates: source === locationSources.demo
      ? { latitude: driver.latitude, longitude: driver.longitude }
      : null,
    updatedAt: status === 'AVAILABLE' ? driver.locationUpdatedAt : null,
    accuracyMeters: status === 'AVAILABLE' ? driver.locationAccuracyMeters : null,
  };
}

const clearedLocation = {
  latitude: null,
  longitude: null,
  locationAccuracyMeters: null,
  locationUpdatedAt: null,
  locationSource: null,
};

async function clearExpiredLocations() {
  return prisma.driver.updateMany({
    where: { locationUpdatedAt: { lte: new Date(Date.now() - locationRetentionMilliseconds) } },
    data: clearedLocation,
  });
}

async function clearExpiredDriverLocation(driver) {
  if (!locationHasExpired(driver)) return driver;
  return prisma.driver.update({ where: { id: driver.id }, data: clearedLocation });
}

function routeDistance(order, driver) {
  const locationIsAvailable = locationStatus(driver) === 'AVAILABLE';
  return {
    toPickupMeters: locationIsAvailable
      ? distanceMeters(
        { latitude: driver.latitude, longitude: driver.longitude },
        { latitude: order.store.latitude, longitude: order.store.longitude },
      )
      : null,
    pickupToDropoffMeters: distanceMeters(
      { latitude: order.store.latitude, longitude: order.store.longitude },
      { latitude: order.dropoffLatitude, longitude: order.dropoffLongitude },
    ),
  };
}

function validatePin(pin) {
  if (!/^\d{6}$/.test(pin || '')) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'PINは6桁の数字で入力してください');
  }
}

async function hashPin(pin) {
  const salt = randomBytes(16);
  const derivedKey = await scrypt(pin, salt, 64);
  return `${salt.toString('hex')}:${derivedKey.toString('hex')}`;
}

async function verifyPin(pin, storedHash) {
  if (!storedHash) return false;
  const [saltHex, keyHex] = storedHash.split(':');
  if (!saltHex || !keyHex) return false;
  const expectedKey = Buffer.from(keyHex, 'hex');
  const actualKey = await scrypt(pin, Buffer.from(saltHex, 'hex'), expectedKey.length);
  return actualKey.length === expectedKey.length && timingSafeEqual(actualKey, expectedKey);
}

function issueAccessToken() {
  const accessToken = randomBytes(32).toString('base64url');
  return {
    accessToken,
    accessTokenHash: createHash('sha256').update(accessToken).digest('hex'),
  };
}

function loginFailureKey(request, driverId) {
  return `${request.socket.remoteAddress || 'unknown'}:${driverId}`;
}

function activeLoginFailures(key) {
  const cutoff = Date.now() - loginAttemptWindowMilliseconds;
  const failures = (loginFailures.get(key) || []).filter((timestamp) => timestamp > cutoff);
  if (failures.length) loginFailures.set(key, failures);
  else loginFailures.delete(key);
  return failures;
}

function ensureLoginAttemptAllowed(key) {
  if (activeLoginFailures(key).length >= maximumLoginFailures) {
    throw new ApiError(429, 'TOO_MANY_LOGIN_ATTEMPTS', 'ログイン失敗が続いたため、15分後にもう一度お試しください');
  }
}

function recordLoginFailure(key) {
  loginFailures.set(key, [...activeLoginFailures(key), Date.now()]);
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const contentLength = Number(request.headers['content-length'] || 0);
    if (contentLength > maximumJsonBodyBytes) {
      reject(new ApiError(413, 'PAYLOAD_TOO_LARGE', 'JSON本文は1MB以下にしてください'));
      request.resume();
      return;
    }
    let body = '';
    let receivedBytes = 0;
    let tooLarge = false;
    request.on('data', (chunk) => {
      receivedBytes += chunk.length;
      if (receivedBytes > maximumJsonBodyBytes) {
        tooLarge = true;
        return;
      }
      body += chunk;
    });
    request.on('end', () => {
      if (tooLarge) {
        reject(new ApiError(413, 'PAYLOAD_TOO_LARGE', 'JSON本文は1MB以下にしてください'));
        return;
      }
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new ApiError(400, 'INVALID_JSON', 'JSONの形式が正しくありません'));
      }
    });
  });
}

const webPublicDirectory = path.resolve(__dirname, '../../web/public');
const documentationDirectory = path.resolve(__dirname, '../../../docs');

function serveFile(response, filePath, contentType) {
  fs.readFile(filePath, (error, content) => {
    if (error) {
      json(response, 404, { code: 'NOT_FOUND', message: 'ファイルが見つかりません' });
      return;
    }
    response.writeHead(200, { ...securityHeaders(), 'Content-Type': contentType });
    response.end(content);
  });
}

async function currentDriver(client = prisma) {
  return client.driver.findFirst({ orderBy: { id: 'asc' } });
}

async function authenticateDriver(request) {
  const authorization = request.headers.authorization || '';
  const match = authorization.match(/^Bearer ([A-Za-z0-9_-]{43})$/);
  if (!match) {
    throw new ApiError(401, 'UNAUTHORIZED', 'AuthorizationヘッダーにBearerトークンが必要です');
  }
  return authenticateAccessToken(match[1]);
}

async function authenticateAccessToken(accessToken) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(accessToken || '')) {
    throw new ApiError(401, 'UNAUTHORIZED', 'アクセストークンが正しくありません');
  }
  const accessTokenHash = createHash('sha256').update(accessToken).digest('hex');
  const driver = await prisma.driver.findUnique({ where: { accessTokenHash } });
  if (!driver) throw new ApiError(401, 'UNAUTHORIZED', '配達員が見つかりません');
  return clearExpiredDriverLocation(driver);
}

async function runIdempotently(request, driver, operation) {
  const key = request.headers['idempotency-key'];
  if (!key || !key.trim()) {
    throw new ApiError(400, 'IDEMPOTENCY_KEY_REQUIRED', '状態を変更するAPIにはIdempotency-Keyが必要です');
  }

  const endpoint = new URL(request.url, `http://${request.headers.host}`).pathname;
  const identity = {
    key_endpoint_driverId: { key: key.trim(), endpoint, driverId: driver.id },
  };
  const previous = await prisma.idempotencyKey.findUnique({ where: identity });
  if (previous?.response !== null && previous?.response !== undefined) {
    return { status: previous.statusCode, body: JSON.parse(previous.response) };
  }
  if (previous) {
    throw new ApiError(409, 'IDEMPOTENCY_REQUEST_IN_PROGRESS', '同じリクエストを処理中です');
  }

  try {
    await prisma.idempotencyKey.create({
      data: { key: key.trim(), endpoint, driverId: driver.id },
    });
  } catch (error) {
    if (error.code === 'P2002') {
      throw new ApiError(409, 'IDEMPOTENCY_REQUEST_IN_PROGRESS', '同じリクエストを処理中です');
    }
    throw error;
  }

  try {
    const body = await operation();
    await prisma.idempotencyKey.update({
      where: identity,
      data: { statusCode: 200, response: JSON.stringify(body) },
    });
    return { status: 200, body };
  } catch (error) {
    await prisma.idempotencyKey.deleteMany({
      where: { key: key.trim(), endpoint, driverId: driver.id },
    });
    throw error;
  }
}

async function createNextOffer(driver, client = prisma) {
  const existing = await client.offer.count({
    where: { driverId: driver.id, status: 'PENDING' },
  });
  if (existing) return;

  if (locationStatus(driver) !== 'AVAILABLE') return;

  const recentOrders = await client.order.findMany({
    where: {
      pickupName: { in: demoStores.map((store) => store.name) },
      dropoffName: { in: demoDropoffs.map((dropoff) => dropoff.name) },
    },
    select: { pickupName: true, dropoffName: true },
    orderBy: { id: 'desc' },
    take: recentDemoRouteLimit,
  });
  const route = chooseDemoRoute(
    recentOrders.map((order) => demoRouteKey(order.pickupName, order.dropoffName)),
  );
  const store = await client.store.findFirst({ where: route.store, orderBy: { id: 'asc' } });
  if (!store) return;
  const eligibleDrivers = await client.driver.findMany({
    where: {
      status: 'IDLE',
      shiftStartedAt: { not: null },
      latitude: { not: null },
      longitude: { not: null },
      offers: { none: { status: 'PENDING' } },
    },
  });
  const candidates = nearestDrivers(eligibleDrivers, store, offerCandidateLimit);
  if (!candidates.some((candidate) => candidate.id === driver.id)) return;

  const rules = await client.scoreRule.findMany();
  const pickupToDropoffMeters = distanceMeters(
    { latitude: store.latitude, longitude: store.longitude },
    { latitude: route.dropoff.latitude, longitude: route.dropoff.longitude },
  );
  const scoreSnapshot = buildScoreSnapshot(rules, {
    weatherCondition: simulatedWeatherCondition,
    at: scoreEvaluationTime(),
    pickupToDropoffMeters,
  });
  const order = await client.order.create({
    data: {
      storeId: store.id,
      pickupName: store.name,
      dropoffName: route.dropoff.name,
      deliveryFeeYen: route.dropoff.deliveryFeeYen,
      dropoffLatitude: route.dropoff.latitude,
      dropoffLongitude: route.dropoff.longitude,
      status: 'OFFERING',
    },
  });
  await client.offer.createMany({
    data: candidates.map((candidate) => ({
      driverId: candidate.id,
      orderId: order.id,
      expiresAt: new Date(Date.now() + offerTtlMilliseconds),
      estimatedPoints: scoreSnapshot.estimatedPoints,
      scoreBreakdown: JSON.stringify(scoreSnapshot.breakdown),
      distanceToPickupMeters: candidate.distanceToPickupMeters,
    })),
  });
}

async function restoreOrderWhenCandidatesAreGone(orderId, client = prisma) {
  const pending = await client.offer.count({ where: { orderId, status: 'PENDING' } });
  if (!pending) {
    await client.order.updateMany({
      where: { id: orderId, status: 'OFFERING' },
      data: { status: 'CREATED' },
    });
  }
}

async function expireOffers() {
  const expired = await prisma.offer.findMany({
    where: { status: 'PENDING', expiresAt: { lte: new Date() } },
    select: { id: true, orderId: true, driverId: true },
  });

  for (const offer of expired) {
    const result = await prisma.offer.updateMany({
      where: { id: offer.id, status: 'PENDING' },
      data: { status: 'EXPIRED' },
    });
    if (!result.count) continue;

    await prisma.driver.updateMany({
      where: { id: offer.driverId, status: 'OFFERED' },
      data: { status: 'IDLE' },
    });
    await restoreOrderWhenCandidatesAreGone(offer.orderId);
  }
  if (expired.length) realtimeHub?.publish('offer.expired');
}

async function ensureSeed() {
  const defaultRules = [
    { code: scoreRuleCodes.completed, label: '配達完了', points: 100 },
    { code: scoreRuleCodes.rain, label: '雨天ボーナス', points: 30 },
    { code: scoreRuleCodes.lateNight, label: '深夜ボーナス', points: 50 },
  ];
  for (const rule of defaultRules) {
    await prisma.scoreRule.upsert({
      where: { code: rule.code },
      update: {},
      create: rule,
    });
  }

  await ensureHackathonDemo(prisma, {
    includeRankings: process.env.DEMO_RANKING_SEED !== 'false',
  });
  await clearExpiredLocations();
  const driver = await currentDriver();

  await prisma.offer.updateMany({
    where: { status: 'PENDING', expiresAt: null },
    data: { expiresAt: new Date(Date.now() + offerTtlMilliseconds) },
  });

  if (!driver) return;
  const active = await prisma.assignment.count({
    where: { driverId: driver.id, deliveredAt: null },
  });
  if (!active) await createNextOffer(driver);
}

async function dashboard(driverId) {
  await expireOffers();
  const driver = await prisma.driver.findUnique({ where: { id: driverId } });
  const active = await prisma.assignment.count({
    where: { driverId: driver.id, deliveredAt: null },
  });
  if (driver.status === 'IDLE' && !active) await createNextOffer(driver);

  const offer = await prisma.offer.findFirst({
    where: { driverId: driver.id, status: 'PENDING' },
    include: { order: { include: { store: true } } },
  });
  const assignment = await prisma.assignment.findFirst({
    where: { driverId: driver.id, deliveredAt: null },
    include: { order: { include: { store: true } } },
  });
  return {
    driver: publicDriver(driver),
    location: publicLocation(driver),
    offer: offer ? {
      ...offer,
      acceptanceSeconds: offerTtlMilliseconds / 1000,
      scoreBreakdown: parseBreakdown(offer.scoreBreakdown),
      routeDistance: routeDistance(offer.order, driver),
    } : null,
    assignment: assignment
      ? {
        ...assignment,
        scoreBreakdown: parseBreakdown(assignment.scoreBreakdown),
        routeDistance: routeDistance(assignment.order, driver),
      }
      : null,
    simulator: { weatherCondition: simulatedWeatherCondition },
  };
}

function buildDriverTitle(lifetimeScore) {
  const currentIndex = Math.max(
    0,
    driverTitles.findLastIndex((title) => lifetimeScore >= title.minimumScore),
  );
  const current = driverTitles[currentIndex];
  const nextTitle = driverTitles[currentIndex + 1] || null;
  if (!nextTitle) return { current, next: null, progressPercent: 100 };

  const scoreWithinLevel = lifetimeScore - current.minimumScore;
  const levelRange = nextTitle.minimumScore - current.minimumScore;
  return {
    current,
    next: { ...nextTitle, pointsNeeded: nextTitle.minimumScore - lifetimeScore },
    progressPercent: Math.max(0, Math.floor((scoreWithinLevel / levelRange) * 100)),
  };
}

async function driverScore(driverId) {
  const windowStartedAt = new Date(Date.now() - scoreWindowDays * 24 * 60 * 60 * 1000);
  const [driver, currentScore, recentEvents] = await prisma.$transaction([
    prisma.driver.findUnique({ where: { id: driverId }, select: { score: true } }),
    prisma.scoreEvent.aggregate({
      where: { driverId, createdAt: { gte: windowStartedAt } },
      _sum: { points: true },
    }),
    prisma.scoreEvent.findMany({
      where: { driverId },
      include: {
        assignment: { include: { order: { include: { store: true } } } },
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    }),
  ]);
  return {
    currentScore: currentScore._sum.points || 0,
    lifetimeScore: driver.score,
    windowDays: scoreWindowDays,
    title: buildDriverTitle(driver.score),
    recentEvents: recentEvents.map((event) => ({
      ...event,
      breakdown: parseBreakdown(event.breakdown),
    })),
  };
}

async function updateSimulatorWeather(condition) {
  if (!['CLEAR', 'RAIN'].includes(condition)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'conditionはCLEARまたはRAINを指定してください');
  }
  simulatedWeatherCondition = condition;

  const rules = await prisma.scoreRule.findMany();
  const pendingOffers = await prisma.offer.findMany({
    where: { status: 'PENDING', driver: { status: 'IDLE' } },
    include: { order: { include: { store: true } } },
  });
  await prisma.$transaction(pendingOffers.map((offer) => {
    const scoreSnapshot = buildScoreSnapshot(rules, {
      weatherCondition: simulatedWeatherCondition,
      at: scoreEvaluationTime(),
      pickupToDropoffMeters: distanceMeters(
        { latitude: offer.order.store.latitude, longitude: offer.order.store.longitude },
        { latitude: offer.order.dropoffLatitude, longitude: offer.order.dropoffLongitude },
      ),
    });
    return prisma.offer.update({
      where: { id: offer.id },
      data: {
        estimatedPoints: scoreSnapshot.estimatedPoints,
        scoreBreakdown: JSON.stringify(scoreSnapshot.breakdown),
      },
    });
  }));
  return {
    weatherCondition: simulatedWeatherCondition,
    message: condition === 'RAIN'
      ? '雨天に切り替えました。未表示のオファーから雨天ボーナスが反映されます。'
      : '晴れに切り替えました。未表示のオファーから雨天ボーナスが外れます。',
  };
}

function buildRanking(drivers, scoresByDriverId, currentDriverId) {
  const sorted = drivers
    .map((driver) => ({
      driverId: driver.id,
      name: driver.name,
      score: scoresByDriverId.get(driver.id) || 0,
      lifetimeTitle: buildDriverTitle(driver.score).current.name,
    }))
    .sort((left, right) => right.score - left.score || left.driverId - right.driverId);

  let previousScore = null;
  let rank = 0;
  const entries = sorted.map((entry, index) => {
    if (entry.score !== previousScore) rank = index + 1;
    previousScore = entry.score;
    return { ...entry, rank, isCurrentDriver: entry.driverId === currentDriverId };
  });

  return {
    leaders: entries.slice(0, rankingLimit),
    me: entries.find((entry) => entry.driverId === currentDriverId),
  };
}

function currentJapanMonthWindow(now = new Date()) {
  const japanTime = new Date(now.getTime() + japanUtcOffsetMilliseconds);
  const year = japanTime.getUTCFullYear();
  const monthIndex = japanTime.getUTCMonth();
  return {
    label: `${year}-${String(monthIndex + 1).padStart(2, '0')}`,
    startsAt: new Date(Date.UTC(year, monthIndex, 1) - japanUtcOffsetMilliseconds),
    endsAt: new Date(Date.UTC(year, monthIndex + 1, 1) - japanUtcOffsetMilliseconds),
  };
}

function addMonthlyTitles(period) {
  const withTitle = (entry) => ({
    ...entry,
    monthlyTitle: monthlyRankingTitles.get(entry.rank) || null,
  });
  return {
    leaders: period.leaders.map(withTitle),
    me: period.me ? withTitle(period.me) : null,
  };
}

async function driverRanking(driverId) {
  const windowStartedAt = new Date(Date.now() - scoreWindowDays * 24 * 60 * 60 * 1000);
  const month = currentJapanMonthWindow();
  const [drivers, currentScores, monthlyScores] = await prisma.$transaction([
    prisma.driver.findMany({ select: { id: true, name: true, score: true } }),
    prisma.scoreEvent.groupBy({
      by: ['driverId'],
      where: { createdAt: { gte: windowStartedAt } },
      _sum: { points: true },
    }),
    prisma.scoreEvent.groupBy({
      by: ['driverId'],
      where: { createdAt: { gte: month.startsAt, lt: month.endsAt } },
      _sum: { points: true },
    }),
  ]);
  const currentScoresByDriverId = new Map(
    currentScores.map((entry) => [entry.driverId, entry._sum.points || 0]),
  );
  const lifetimeScoresByDriverId = new Map(drivers.map((driver) => [driver.id, driver.score]));
  const monthlyScoresByDriverId = new Map(
    monthlyScores.map((entry) => [entry.driverId, entry._sum.points || 0]),
  );

  return {
    windowDays: scoreWindowDays,
    limit: rankingLimit,
    tiePolicy: 'competition',
    month,
    monthly: addMonthlyTitles(buildRanking(drivers, monthlyScoresByDriverId, driverId)),
    current: buildRanking(drivers, currentScoresByDriverId, driverId),
    lifetime: buildRanking(drivers, lifetimeScoresByDriverId, driverId),
  };
}

function parseHistoryDate(value, fieldName) {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ApiError(400, 'VALIDATION_ERROR', `${fieldName}はYYYY-MM-DD形式で指定してください`);
  }
  const utcDate = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(utcDate.getTime()) || utcDate.toISOString().slice(0, 10) !== value) {
    throw new ApiError(400, 'VALIDATION_ERROR', `${fieldName}に正しい日付を指定してください`);
  }
  return new Date(`${value}T00:00:00+09:00`);
}

function historyFilters(searchParams) {
  const status = (searchParams.get('status') || 'DELIVERED').toUpperCase();
  if (!['ALL', 'ASSIGNED', 'PICKED_UP', 'DELIVERED'].includes(status)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'statusが正しくありません');
  }
  const query = (searchParams.get('query') || '').trim();
  if (query.length > 100) {
    throw new ApiError(400, 'VALIDATION_ERROR', '検索文字は100文字以内で指定してください');
  }
  const fromValue = searchParams.get('from') || '';
  const toValue = searchParams.get('to') || '';
  const from = parseHistoryDate(fromValue, 'from');
  const to = parseHistoryDate(toValue, 'to');
  if (from && to && from > to) {
    throw new ApiError(400, 'VALIDATION_ERROR', '開始日は終了日以前にしてください');
  }
  if (to) to.setUTCDate(to.getUTCDate() + 1);
  return { status, query, fromValue, toValue, from, to };
}

async function deliveryHistory(driverId, searchParams) {
  const filters = historyFilters(searchParams);
  const where = { driverId };
  if (filters.status === 'DELIVERED') where.deliveredAt = { not: null };
  if (filters.status === 'PICKED_UP') {
    where.pickedUpAt = { not: null };
    where.deliveredAt = null;
  }
  if (filters.status === 'ASSIGNED') {
    where.pickedUpAt = null;
    where.deliveredAt = null;
  }
  if (filters.query) {
    where.order = {
      OR: [
        { pickupName: { contains: filters.query } },
        { dropoffName: { contains: filters.query } },
        { store: { name: { contains: filters.query } } },
      ],
    };
  }
  const dateField = filters.status === 'DELIVERED'
    ? 'deliveredAt'
    : filters.status === 'PICKED_UP' ? 'pickedUpAt' : 'acceptedAt';
  if (filters.from || filters.to) {
    where[dateField] = {
      ...(where[dateField] || {}),
      ...(filters.from ? { gte: filters.from } : {}),
      ...(filters.to ? { lt: filters.to } : {}),
    };
  }

  const [completedDeliveries, latestCompleted, filteredDeliveries, deliveries] = await prisma.$transaction([
    prisma.assignment.count({
      where: { driverId, deliveredAt: { not: null } },
    }),
    prisma.assignment.findFirst({
      where: { driverId, deliveredAt: { not: null } },
      orderBy: { deliveredAt: 'desc' },
      select: { deliveredAt: true },
    }),
    prisma.assignment.count({ where }),
    prisma.assignment.findMany({
      where,
      include: { order: { include: { store: true } }, scoreEvent: true },
      orderBy: { [dateField]: 'desc' },
      take: 20,
    }),
  ]);
  return {
    summary: {
      completedDeliveries,
      lastDeliveredAt: latestCompleted?.deliveredAt || null,
      filteredDeliveries,
    },
    filters: {
      status: filters.status,
      query: filters.query,
      from: filters.fromValue,
      to: filters.toValue,
    },
    deliveries: deliveries.map((assignment) => ({
      ...assignment,
      scoreEvent: assignment.scoreEvent ? {
        ...assignment.scoreEvent,
        breakdown: parseBreakdown(assignment.scoreEvent.breakdown),
      } : null,
    })),
  };
}

async function startShift(driver) {
  if (driver.status !== 'OFFLINE') {
    throw new ApiError(409, 'INVALID_STATE_TRANSITION', '退勤中のときだけ稼働開始できます');
  }
  const updated = await prisma.driver.update({
    where: { id: driver.id },
    data: { status: 'IDLE', shiftStartedAt: new Date() },
  });
  await createNextOffer(updated);
  return publicDriver(updated);
}

async function endShift(driver) {
  if (driver.status === 'BUSY') {
    throw new ApiError(409, 'INVALID_STATE_TRANSITION', '配達中は退勤できません');
  }
  if (!['IDLE', 'OFFERED'].includes(driver.status)) {
    throw new ApiError(409, 'INVALID_STATE_TRANSITION', '待機中またはオファー確認中のみ退勤できます');
  }

  const pendingOffers = await prisma.offer.findMany({
    where: { driverId: driver.id, status: 'PENDING' },
    select: { orderId: true },
  });
  await prisma.$transaction([
    prisma.offer.updateMany({
      where: { driverId: driver.id, status: 'PENDING' },
      data: { status: 'REJECTED' },
    }),
    prisma.driver.update({
      where: { id: driver.id },
      data: {
        status: 'OFFLINE',
        shiftStartedAt: null,
        ...clearedLocation,
      },
    }),
  ]);
  for (const offer of pendingOffers) {
    await restoreOrderWhenCandidatesAreGone(offer.orderId);
  }
  return publicDriver(await prisma.driver.findUnique({ where: { id: driver.id } }));
}

async function updateDriverLocation(driver, location) {
  if (driver.status === 'OFFLINE') {
    throw new ApiError(409, 'INVALID_STATE_TRANSITION', '現在地は勤務中のみ更新できます');
  }
  const normalized = normalizedLocation(location);
  if (!normalized) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'sourceはDEMOまたはDEVICEを指定してください');
  }
  if (normalized.validationMessage) {
    throw new ApiError(400, 'VALIDATION_ERROR', normalized.validationMessage);
  }

  const updated = await prisma.driver.update({
    where: { id: driver.id },
    data: {
      latitude: normalized.latitude,
      longitude: normalized.longitude,
      locationAccuracyMeters: normalized.accuracyMeters,
      locationUpdatedAt: new Date(),
      locationSource: normalized.source,
    },
  });
  return publicLocation(updated);
}

async function showCurrentOffer(driver) {
  if (driver.status !== 'IDLE') {
    throw new ApiError(409, 'INVALID_STATE_TRANSITION', '待機中のときだけオファーを表示できます');
  }
  await expireOffers();
  await createNextOffer(driver);
  const offer = await prisma.offer.findFirst({
    where: { driverId: driver.id, status: 'PENDING' },
    orderBy: { id: 'asc' },
    include: { order: { include: { store: true } } },
  });
  if (!offer) throw new ApiError(404, 'OFFER_NOT_FOUND', '現在受け取れるオファーはありません。現在地を更新してお待ちください');

  const [shownOffer] = await prisma.$transaction([
    prisma.offer.update({
      where: { id: offer.id },
      data: { expiresAt: new Date(Date.now() + offerTtlMilliseconds) },
      include: { order: { include: { store: true } } },
    }),
    prisma.driver.update({
      where: { id: driver.id },
      data: { status: 'OFFERED' },
    }),
  ]);
  return {
    ...shownOffer,
    acceptanceSeconds: offerTtlMilliseconds / 1000,
    scoreBreakdown: parseBreakdown(shownOffer.scoreBreakdown),
  };
}

async function acceptOffer(driver, offerId) {
  if (driver.status !== 'OFFERED') {
    throw new ApiError(409, 'INVALID_STATE_TRANSITION', 'オファー確認中のみ受諾できます');
  }

  await expireOffers();
  return prisma.$transaction(async (transaction) => {
    const accepted = await transaction.offer.updateMany({
      where: {
        id: offerId,
        driverId: driver.id,
        status: 'PENDING',
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      data: { status: 'ACCEPTED' },
    });
    if (!accepted.count) {
      throw new ApiError(409, 'OFFER_ALREADY_TAKEN', '期限切れまたは処理済みのオファーです');
    }

    const offer = await transaction.offer.findUnique({ where: { id: offerId } });
    const siblingOffers = await transaction.offer.findMany({
      where: { orderId: offer.orderId, id: { not: offerId }, status: 'PENDING' },
      select: { driverId: true },
    });
    const assigned = await transaction.order.updateMany({
      where: { id: offer.orderId, status: 'OFFERING' },
      data: { status: 'ASSIGNED' },
    });
    if (!assigned.count) {
      throw new ApiError(409, 'INVALID_STATE_TRANSITION', '注文を割り当てられる状態ではありません');
    }

    await transaction.offer.updateMany({
      where: { orderId: offer.orderId, id: { not: offerId }, status: 'PENDING' },
      data: { status: 'WITHDRAWN' },
    });
    if (siblingOffers.length) {
      await transaction.driver.updateMany({
        where: {
          id: { in: siblingOffers.map((sibling) => sibling.driverId) },
          status: 'OFFERED',
        },
        data: { status: 'IDLE' },
      });
    }
    await transaction.driver.update({
      where: { id: driver.id },
      data: { status: 'BUSY' },
    });
    await transaction.assignment.create({
      data: {
        orderId: offer.orderId,
        driverId: driver.id,
        estimatedPoints: offer.estimatedPoints,
        scoreBreakdown: offer.scoreBreakdown,
      },
    });
    return offer;
  });
}

async function rejectOffer(driver, offerId) {
  if (driver.status !== 'OFFERED') {
    throw new ApiError(409, 'INVALID_STATE_TRANSITION', 'オファー確認中のみ辞退できます');
  }
  const offer = await prisma.offer.findFirst({
    where: { id: offerId, driverId: driver.id, status: 'PENDING' },
  });
  if (!offer) throw new ApiError(409, 'OFFER_ALREADY_TAKEN', '処理済みのオファーです');

  await prisma.$transaction([
    prisma.offer.updateMany({
      where: { id: offerId, driverId: driver.id, status: 'PENDING' },
      data: { status: 'REJECTED' },
    }),
    prisma.driver.update({ where: { id: driver.id }, data: { status: 'IDLE' } }),
  ]);
  await restoreOrderWhenCandidatesAreGone(offer.orderId);
  await createNextOffer(driver);
}

async function pickupAssignment(driver, assignmentId) {
  if (driver.status !== 'BUSY') {
    throw new ApiError(409, 'INVALID_STATE_TRANSITION', '配達中のみ荷物を受け取れます');
  }
  const assignment = await prisma.assignment.findFirst({
    where: { id: assignmentId, driverId: driver.id, pickedUpAt: null },
    include: { order: { include: { store: true } } },
  });
  if (!assignment || assignment.order.status !== 'ASSIGNED') {
    throw new ApiError(409, 'INVALID_STATE_TRANSITION', '受取できる配達がありません');
  }
  await prisma.$transaction([
    prisma.assignment.update({
      where: { id: assignment.id },
      data: { pickedUpAt: new Date() },
    }),
    prisma.order.update({
      where: { id: assignment.orderId },
      data: { status: 'PICKED_UP' },
    }),
  ]);
}

async function completeAssignment(driver, assignmentId) {
  if (driver.status !== 'BUSY') {
    throw new ApiError(409, 'INVALID_STATE_TRANSITION', '配達中のみ完了できます');
  }
  const assignment = await prisma.assignment.findFirst({
    where: {
      id: assignmentId,
      driverId: driver.id,
      pickedUpAt: { not: null },
      deliveredAt: null,
    },
    include: { order: { include: { store: true } } },
  });
  if (!assignment || assignment.order.status !== 'PICKED_UP') {
    throw new ApiError(409, 'INVALID_STATE_TRANSITION', '完了できる配達がありません');
  }
  const scoreAward = await prisma.$transaction(async (transaction) => {
    const completed = await transaction.assignment.updateMany({
      where: {
        id: assignment.id,
        driverId: driver.id,
        pickedUpAt: { not: null },
        deliveredAt: null,
      },
      data: { deliveredAt: new Date() },
    });
    if (!completed.count) {
      throw new ApiError(409, 'INVALID_STATE_TRANSITION', 'この配達はすでに完了しています');
    }

    const updatedOrder = await transaction.order.updateMany({
      where: { id: assignment.orderId, status: 'PICKED_UP' },
      data: { status: 'DELIVERED' },
    });
    if (!updatedOrder.count) {
      throw new ApiError(409, 'INVALID_STATE_TRANSITION', '完了できる注文状態ではありません');
    }

    let breakdown = parseBreakdown(assignment.scoreBreakdown);
    let awardedPoints = assignment.estimatedPoints;
    if (!breakdown.length) {
      try {
        const fallback = buildScoreSnapshot(await transaction.scoreRule.findMany(), {
          weatherCondition: 'CLEAR',
          at: new Date('2000-01-01T12:00:00+09:00'),
          pickupToDropoffMeters: routeDistance(assignment.order, driver).pickupToDropoffMeters,
        });
        breakdown = fallback.breakdown;
        awardedPoints = fallback.estimatedPoints;
      } catch {
        throw new ApiError(503, 'SCORE_RULE_UNAVAILABLE', '配達完了の加点ルールを利用できません');
      }
    }
    const reason = breakdown.map((item) => item.label).join(' + ');
    const event = await transaction.scoreEvent.create({
      data: {
        driverId: driver.id,
        assignmentId: assignment.id,
        points: awardedPoints,
        reason,
        breakdown: JSON.stringify(breakdown),
      },
    });
    await transaction.driver.update({
      where: { id: driver.id },
      data: { status: 'IDLE', score: { increment: awardedPoints } },
    });
    return {
      points: event.points,
      reason: event.reason,
      breakdown,
      createdAt: event.createdAt,
    };
  });
  await createNextOffer(driver);
  return scoreAward;
}

async function logoutDriver(driver) {
  if (driver.status !== 'OFFLINE') {
    throw new ApiError(409, 'INVALID_STATE_TRANSITION', '勤務中はログアウトできません。退勤してからログアウトしてください');
  }
  await prisma.driver.update({
    where: { id: driver.id },
    data: { accessTokenHash: null },
  });
}

async function handle(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);

  if (request.method === 'GET' && url.pathname === '/healthz') {
    await prisma.$queryRaw`SELECT 1`;
    return json(response, 200, { status: 'ok', database: 'connected' });
  }
  if (request.method === 'GET' && url.pathname === '/metrics') {
    return json(response, 200, metricsBody());
  }

  if (request.method === 'GET' && url.pathname === '/') return serveFile(response, path.join(webPublicDirectory, 'index.html'), 'text/html; charset=utf-8');
  if (request.method === 'GET' && url.pathname === '/docs') return serveFile(response, path.join(webPublicDirectory, 'docs.html'), 'text/html; charset=utf-8');
  if (request.method === 'GET' && url.pathname === '/openapi.yaml') return serveFile(response, path.join(documentationDirectory, 'openapi.yaml'), 'text/yaml; charset=utf-8');
  if (request.method === 'GET' && url.pathname === '/route-preview.js') return serveFile(response, path.join(webPublicDirectory, 'route-preview.js'), 'application/javascript; charset=utf-8');
  if (request.method === 'GET' && url.pathname === '/bottom-sheet.js') return serveFile(response, path.join(webPublicDirectory, 'bottom-sheet.js'), 'application/javascript; charset=utf-8');
  if (request.method === 'GET' && url.pathname === '/app.js') return serveFile(response, path.join(webPublicDirectory, 'app.js'), 'application/javascript; charset=utf-8');
  if (request.method === 'GET' && url.pathname === '/delivery-ui.js') return serveFile(response, path.join(webPublicDirectory, 'delivery-ui.js'), 'application/javascript; charset=utf-8');
  if (request.method === 'GET' && url.pathname === '/offline-actions.js') return serveFile(response, path.join(webPublicDirectory, 'offline-actions.js'), 'application/javascript; charset=utf-8');
  if (request.method === 'GET' && url.pathname === '/delivery-map.js') return serveFile(response, path.join(webPublicDirectory, 'delivery-map.js'), 'application/javascript; charset=utf-8');
  if (request.method === 'GET' && url.pathname === '/vendor/leaflet.js') return serveFile(response, require.resolve('leaflet/dist/leaflet.js'), 'application/javascript; charset=utf-8');
  if (request.method === 'GET' && url.pathname === '/vendor/leaflet.css') return serveFile(response, require.resolve('leaflet/dist/leaflet.css'), 'text/css; charset=utf-8');
  if (request.method === 'GET' && url.pathname === '/style.css') return serveFile(response, path.join(webPublicDirectory, 'style.css'), 'text/css; charset=utf-8');

  if (request.method === 'POST' && url.pathname === '/api/drivers') {
    const { name, pin } = await readJsonBody(request);
    if (!name || !name.trim()) {
      throw new ApiError(400, 'VALIDATION_ERROR', '配達員名を入力してください');
    }
    validatePin(pin);
    const { accessToken, accessTokenHash } = issueAccessToken();
    const newDriver = await prisma.driver.create({
      data: {
        name: name.trim(),
        accessTokenHash,
        pinHash: await hashPin(pin),
      },
    });
    return json(response, 201, { driver: publicDriver(newDriver), accessToken });
  }

  if (request.method === 'POST' && url.pathname === '/api/login') {
    const { driverId, pin } = await readJsonBody(request);
    const numericDriverId = Number(driverId);
    if (!Number.isInteger(numericDriverId) || numericDriverId <= 0 || !/^\d{6}$/.test(pin || '')) {
      throw new ApiError(401, 'INVALID_CREDENTIALS', '配達員IDまたはPINが正しくありません');
    }
    const failureKey = loginFailureKey(request, numericDriverId);
    ensureLoginAttemptAllowed(failureKey);
    const loginDriver = await prisma.driver.findUnique({ where: { id: numericDriverId } });
    if (!loginDriver || !(await verifyPin(pin, loginDriver.pinHash))) {
      recordLoginFailure(failureKey);
      throw new ApiError(401, 'INVALID_CREDENTIALS', '配達員IDまたはPINが正しくありません');
    }
    loginFailures.delete(failureKey);
    const { accessToken, accessTokenHash } = issueAccessToken();
    const updatedDriver = await prisma.driver.update({
      where: { id: loginDriver.id },
      data: { accessTokenHash },
    });
    realtimeHub?.disconnectDriver(loginDriver.id);
    return json(response, 200, { driver: publicDriver(updatedDriver), accessToken });
  }

  const driver = await authenticateDriver(request);
  if (request.method === 'GET' && url.pathname === '/api/dashboard') {
    return json(response, 200, await dashboard(driver.id));
  }
  if (request.method === 'GET' && url.pathname === '/api/deliveries/history') {
    return json(response, 200, await deliveryHistory(driver.id, url.searchParams));
  }
  if (request.method === 'GET' && url.pathname === '/api/drivers/me/score') {
    return json(response, 200, await driverScore(driver.id));
  }
  if (request.method === 'GET' && url.pathname === '/api/drivers/ranking') {
    return json(response, 200, await driverRanking(driver.id));
  }
  if (request.method === 'PUT' && url.pathname === '/api/drivers/me/location') {
    const updatedLocation = await updateDriverLocation(driver, await readJsonBody(request));
    json(response, 200, updatedLocation);
    realtimeHub.publish('location.updated');
    return;
  }

  const idempotentResponse = async (operation, reason) => {
    const result = await runIdempotently(request, driver, operation);
    json(response, result.status, result.body);
    realtimeHub.publish(reason);
  };

  if (request.method === 'POST' && url.pathname === '/api/shifts/start') {
    return idempotentResponse(() => startShift(driver), 'shift.started');
  }
  if (request.method === 'POST' && url.pathname === '/api/shifts/end') {
    return idempotentResponse(() => endShift(driver), 'shift.ended');
  }
  if (request.method === 'POST' && url.pathname === '/api/offers/current') {
    return idempotentResponse(() => showCurrentOffer(driver), 'offer.shown');
  }
  if (request.method === 'POST' && url.pathname === '/api/logout') {
    await idempotentResponse(async () => {
      await logoutDriver(driver);
      return { message: 'ログアウトしました' };
    }, 'session.ended');
    realtimeHub.disconnectDriver(driver.id);
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/simulator/weather') {
    return idempotentResponse(async () => {
      const { condition } = await readJsonBody(request);
      return updateSimulatorWeather(condition);
    }, 'simulator.updated');
  }

  const accept = url.pathname.match(/^\/api\/offers\/(\d+)\/accept$/);
  if (request.method === 'POST' && accept) {
    return idempotentResponse(async () => {
      await acceptOffer(driver, Number(accept[1]));
      return dashboard(driver.id);
    }, 'offer.accepted');
  }
  const reject = url.pathname.match(/^\/api\/offers\/(\d+)\/reject$/);
  if (request.method === 'POST' && reject) {
    return idempotentResponse(async () => {
      await rejectOffer(driver, Number(reject[1]));
      return dashboard(driver.id);
    }, 'offer.rejected');
  }
  const pickup = url.pathname.match(/^\/api\/assignments\/(\d+)\/pickup$/);
  if (request.method === 'POST' && pickup) {
    return idempotentResponse(async () => {
      await pickupAssignment(driver, Number(pickup[1]));
      return dashboard(driver.id);
    }, 'assignment.picked_up');
  }
  const complete = url.pathname.match(/^\/api\/assignments\/(\d+)\/complete$/);
  if (request.method === 'POST' && complete) {
    return idempotentResponse(async () => {
      const scoreAward = await completeAssignment(driver, Number(complete[1]));
      return { ...await dashboard(driver.id), scoreAward };
    }, 'assignment.completed');
  }
  return json(response, 404, { code: 'NOT_FOUND', message: 'このエンドポイントは存在しません' });
}

const server = http.createServer(async (request, response) => {
  const requestId = randomUUID();
  const startedRequestAt = Date.now();
  response.setHeader('X-Request-Id', requestId);
  response.on('finish', () => logRequest(request, response, requestId, startedRequestAt));
  try {
    await handle(request, response);
  } catch (error) {
    console.error(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'error',
      event: 'request_failed',
      requestId,
      errorName: error.name,
      errorCode: error.code || 'INTERNAL_ERROR',
      message: error.status ? error.message : 'Unexpected server error',
    }));
    json(response, error.status || 500, {
      code: error.code || 'INTERNAL_ERROR',
      message: error.status ? error.message : 'サーバーでエラーが発生しました',
    });
  }
});

realtimeHub = createRealtimeHub(server, authenticateAccessToken);

ensureSeed().then(() => {
  server.listen(port, () => {
    console.log(`DeliveryFlow is running at http://localhost:${port}`);
    const locationCleanupTimer = setInterval(() => {
      clearExpiredLocations().catch((error) => console.error(JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'error',
        event: 'location_cleanup_failed',
        message: error.message,
      })));
    }, 5 * 60 * 1000);
    locationCleanupTimer.unref();
  });
});

