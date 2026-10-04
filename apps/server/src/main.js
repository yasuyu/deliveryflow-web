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
const { elevationProfile } = require('./modules/elevation/elevation');
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
let sqliteTransactionQueue = Promise.resolve();

function databaseTransaction(operation) {
  const run = async () => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        return await prisma.$transaction(operation, {
          isolationLevel: 'Serializable', maxWait: 10_000, timeout: 10_000,
        });
      } catch (error) {
        if (!['P2034', 'P2002', 'P1008', 'P2028'].includes(error.code)) throw error;
        if (attempt === 3) {
          throw new ApiError(409, 'CONCURRENT_OPERATION_RETRY', '操作が競合しました。最新の状態を確認して再送してください');
        }
        await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
      }
    }
  };
  if (databaseProvider !== 'sqlite') return run();
  // SQLite has one writer; queue local transactions instead of waiting on its write lock.
  const result = sqliteTransactionQueue.then(run, run);
  sqliteTransactionQueue = result.catch(() => {});
  return result;
}
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
    const chunks = [];
    let receivedBytes = 0;
    let tooLarge = false;
    request.on('data', (chunk) => {
      receivedBytes += chunk.length;
      if (receivedBytes > maximumJsonBodyBytes) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (tooLarge) {
        reject(new ApiError(413, 'PAYLOAD_TOO_LARGE', 'JSON本文は1MB以下にしてください'));
        return;
      }
      try {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new ApiError(400, 'INVALID_JSON', 'JSONの形式が正しくありません'));
      }
    });
    request.on('error', reject);
    request.on('aborted', () => reject(new ApiError(400, 'REQUEST_ABORTED', '送信が中断されました')));
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
  return databaseTransaction(async (transaction) => {
    const current = await transaction.driver.findUnique({ where: { id: driver.id } });
    if (!current || current.accessTokenHash !== driver.accessTokenHash) {
      throw new ApiError(401, 'UNAUTHORIZED', 'ログインし直してください');
    }
    const previous = await transaction.idempotencyKey.findUnique({ where: identity });
    if (previous?.response !== null && previous?.response !== undefined) {
      return { status: previous.statusCode, body: JSON.parse(previous.response), replayed: true };
    }
    // Only old versions can leave a committed key without its operation's response.
    const recovered = previous ? await recoverInterruptedDelivery(transaction, current, endpoint) : null;
    if (previous && !/^\/api\/(offers\/\d+\/accept|assignments\/\d+\/(pickup|complete))$/.test(endpoint)) {
      throw new ApiError(409, 'IDEMPOTENCY_RECOVERY_REQUIRED', '旧版で中断された操作です。最新の状態を確認し、新しい操作として実行してください');
    }
    if (!previous) {
      await transaction.idempotencyKey.create({
        data: { key: key.trim(), endpoint, driverId: driver.id },
      });
    }
    const body = recovered ? recovered.body : await operation(transaction, current);
    await transaction.idempotencyKey.update({
      where: identity,
      data: { statusCode: 200, response: JSON.stringify(body) },
    });
    return { status: 200, body, replayed: Boolean(recovered) };
  });
}

async function recoverInterruptedDelivery(client, driver, endpoint) {
  const accept = endpoint.match(/^\/api\/offers\/(\d+)\/accept$/);
  const action = endpoint.match(/^\/api\/assignments\/(\d+)\/(pickup|complete)$/);
  let scoreAward;
  if (accept) {
    const offer = await client.offer.findFirst({
      where: { id: Number(accept[1]), driverId: driver.id, status: 'ACCEPTED' },
      include: { order: { include: { assignment: true } } },
    });
    if (!offer || offer.order.assignment?.driverId !== driver.id) return null;
  } else if (action) {
    const assignment = await client.assignment.findFirst({
      where: { id: Number(action[1]), driverId: driver.id }, include: { scoreEvent: true },
    });
    if (action[2] === 'pickup') {
      if (!assignment?.pickedUpAt) return null;
    } else {
      if (!assignment?.deliveredAt || !assignment.scoreEvent) return null;
      const event = assignment.scoreEvent;
      scoreAward = {
        points: event.points, reason: event.reason,
        breakdown: parseBreakdown(event.breakdown), createdAt: event.createdAt,
      };
    }
  } else return null;
  return { body: { ...await dashboard(driver.id, client), ...(scoreAward ? { scoreAward } : {}) } };
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

async function expireOffers(client) {
  const expired = await client.offer.findMany({
    where: { status: 'PENDING', expiresAt: { lte: new Date() } },
    select: { id: true, orderId: true, driverId: true },
  });

  let changed = false;
  for (const offer of expired) {
    const result = await client.offer.updateMany({
      where: { id: offer.id, status: 'PENDING', expiresAt: { lte: new Date() } },
      data: { status: 'EXPIRED' },
    });
    if (!result.count) continue;
    changed = true;

    await client.driver.updateMany({
      where: { id: offer.driverId, status: 'OFFERED' },
      data: { status: 'IDLE' },
    });
    await restoreOrderWhenCandidatesAreGone(offer.orderId, client);
  }
  return changed;
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

async function dashboard(driverId, client = null) {
  if (!client) {
    const result = await databaseTransaction(async (transaction) => {
      const expired = await expireOffers(transaction);
      return { body: await dashboardSnapshot(driverId, transaction), expired };
    });
    if (result.expired) realtimeHub?.publish('offer.expired');
    return result.body;
  }
  await expireOffers(client);
  return dashboardSnapshot(driverId, client);
}

async function dashboardSnapshot(driverId, client) {
  const driver = await client.driver.findUnique({ where: { id: driverId } });
  const active = await client.assignment.count({
    where: { driverId: driver.id, deliveredAt: null },
  });
  if (driver.status === 'IDLE' && !active) await createNextOffer(driver, client);

  const offer = await client.offer.findFirst({
    where: { driverId: driver.id, status: 'PENDING' },
    include: { order: { include: { store: true } } },
  });
  const assignment = await client.assignment.findFirst({
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
      elevationProfile: elevationProfile(offer.order, driver),
    } : null,
    assignment: assignment
      ? {
        ...assignment,
        scoreBreakdown: parseBreakdown(assignment.scoreBreakdown),
        routeDistance: routeDistance(assignment.order, driver),
        elevationProfile: elevationProfile(assignment.order, driver, Boolean(assignment.pickedUpAt)),
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

async function updateSimulatorWeather(condition, client) {
  if (!['CLEAR', 'RAIN'].includes(condition)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'conditionはCLEARまたはRAINを指定してください');
  }
  const rules = await client.scoreRule.findMany();
  const pendingOffers = await client.offer.findMany({
    where: { status: 'PENDING', driver: { status: 'IDLE' } },
    include: { order: { include: { store: true } } },
  });
  for (const offer of pendingOffers) {
    const scoreSnapshot = buildScoreSnapshot(rules, {
      weatherCondition: condition,
      at: scoreEvaluationTime(),
      pickupToDropoffMeters: distanceMeters(
        { latitude: offer.order.store.latitude, longitude: offer.order.store.longitude },
        { latitude: offer.order.dropoffLatitude, longitude: offer.order.dropoffLongitude },
      ),
    });
    await client.offer.update({
      where: { id: offer.id },
      data: {
        estimatedPoints: scoreSnapshot.estimatedPoints,
        scoreBreakdown: JSON.stringify(scoreSnapshot.breakdown),
      },
    });
  }
  return {
    weatherCondition: condition,
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
  const cursorValue = searchParams.get('cursor');
  if (cursorValue !== null && (!/^[1-9]\d{0,15}$/.test(cursorValue) || !Number.isSafeInteger(Number(cursorValue)))) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'cursorが正しくありません');
  }
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

  let pageWhere = where;
  if (cursorValue !== null) {
    const anchor = await prisma.assignment.findFirst({ where: { ...where, id: Number(cursorValue) } });
    if (!anchor) throw new ApiError(400, 'VALIDATION_ERROR', 'cursorが現在の配達員・絞り込み条件に一致しません');
    // New arrivals cannot shift this timestamp/ID boundary between pages.
    pageWhere = { AND: [where, { OR: [
      { [dateField]: { lt: anchor[dateField] } },
      { [dateField]: anchor[dateField], id: { lt: anchor.id } },
    ] }] };
  }
  const [completedDeliveries, latestCompleted, filteredDeliveries, page] = await prisma.$transaction([
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
      where: pageWhere,
      include: { order: { include: { store: true } }, scoreEvent: true },
      orderBy: [{ [dateField]: 'desc' }, { id: 'desc' }],
      take: 21,
    }),
  ]);
  const deliveries = page.slice(0, 20);
  return {
    pagination: { pageSize: 20, hasMore: page.length > 20, nextCursor: page.length > 20 ? String(deliveries.at(-1).id) : null },
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

async function startShift(driver, client) {
  if (driver.status !== 'OFFLINE') {
    throw new ApiError(409, 'INVALID_STATE_TRANSITION', '退勤中のときだけ稼働開始できます');
  }
  const updated = await client.driver.update({
    where: { id: driver.id },
    data: { status: 'IDLE', shiftStartedAt: new Date() },
  });
  await createNextOffer(updated, client);
  return publicDriver(updated);
}

async function endShift(driver, client) {
  if (driver.status === 'BUSY') {
    throw new ApiError(409, 'INVALID_STATE_TRANSITION', '配達中は退勤できません');
  }
  if (!['IDLE', 'OFFERED'].includes(driver.status)) {
    throw new ApiError(409, 'INVALID_STATE_TRANSITION', '待機中またはオファー確認中のみ退勤できます');
  }

  const endedAt = new Date();
  const startedAt = driver.shiftStartedAt || endedAt;
  const pendingOffers = await client.offer.findMany({
    where: { driverId: driver.id, status: 'PENDING' },
    select: { orderId: true },
  });
  const completedDeliveries = await client.assignment.count({
    where: { driverId: driver.id, deliveredAt: { gte: startedAt, lte: endedAt } },
  });
  const scoreSummary = await client.scoreEvent.aggregate({
    where: { driverId: driver.id, createdAt: { gte: startedAt, lte: endedAt } },
    _sum: { points: true },
  });
  await client.offer.updateMany({
    where: { driverId: driver.id, status: 'PENDING' },
    data: { status: 'REJECTED' },
  });
  const updated = await client.driver.update({
    where: { id: driver.id },
    data: {
      status: 'OFFLINE',
      shiftStartedAt: null,
      ...clearedLocation,
    },
  });
  for (const offer of pendingOffers) {
    await restoreOrderWhenCandidatesAreGone(offer.orderId, client);
  }
  return {
    ...publicDriver(updated),
    shiftSummary: {
      startedAt,
      endedAt,
      durationSeconds: Math.max(0, Math.floor((endedAt.getTime() - startedAt.getTime()) / 1000)),
      completedDeliveries,
      pointsEarned: scoreSummary._sum.points || 0,
    },
  };
}

async function updateDriverLocation(driver, location, client) {
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

  const updated = await client.driver.update({
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

async function showCurrentOffer(driver, client) {
  if (driver.status !== 'IDLE') {
    throw new ApiError(409, 'INVALID_STATE_TRANSITION', '待機中のときだけオファーを表示できます');
  }
  await expireOffers(client);
  await createNextOffer(driver, client);
  const offer = await client.offer.findFirst({
    where: { driverId: driver.id, status: 'PENDING' },
    orderBy: { id: 'asc' },
    include: { order: { include: { store: true } } },
  });
  if (!offer) throw new ApiError(404, 'OFFER_NOT_FOUND', '現在受け取れるオファーはありません。現在地を更新してお待ちください');

  const shownOffer = await client.offer.update({
    where: { id: offer.id },
    data: { expiresAt: new Date(Date.now() + offerTtlMilliseconds) },
    include: { order: { include: { store: true } } },
  });
  await client.driver.update({
    where: { id: driver.id },
    data: { status: 'OFFERED' },
  });
  return {
    ...shownOffer,
    acceptanceSeconds: offerTtlMilliseconds / 1000,
    scoreBreakdown: parseBreakdown(shownOffer.scoreBreakdown),
  };
}

async function acceptOffer(driver, offerId, transaction) {
  if (driver.status !== 'OFFERED') {
    throw new ApiError(409, 'INVALID_STATE_TRANSITION', 'オファー確認中のみ受諾できます');
  }

  await expireOffers(transaction);
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
}

async function rejectOffer(driver, offerId, client) {
  if (driver.status !== 'OFFERED') {
    throw new ApiError(409, 'INVALID_STATE_TRANSITION', 'オファー確認中のみ辞退できます');
  }
  const offer = await client.offer.findFirst({
    where: { id: offerId, driverId: driver.id, status: 'PENDING' },
  });
  if (!offer) throw new ApiError(409, 'OFFER_ALREADY_TAKEN', '処理済みのオファーです');

  const rejected = await client.offer.updateMany({
    where: { id: offerId, driverId: driver.id, status: 'PENDING' },
    data: { status: 'REJECTED' },
  });
  if (!rejected.count) throw new ApiError(409, 'OFFER_ALREADY_TAKEN', '処理済みのオファーです');
  const updated = await client.driver.update({ where: { id: driver.id }, data: { status: 'IDLE' } });
  await restoreOrderWhenCandidatesAreGone(offer.orderId, client);
  await createNextOffer(updated, client);
}

async function pickupAssignment(driver, assignmentId, client) {
  if (driver.status !== 'BUSY') {
    throw new ApiError(409, 'INVALID_STATE_TRANSITION', '配達中のみ荷物を受け取れます');
  }
  const assignment = await client.assignment.findFirst({
    where: { id: assignmentId, driverId: driver.id, pickedUpAt: null },
    include: { order: { include: { store: true } } },
  });
  if (!assignment || assignment.order.status !== 'ASSIGNED') {
    throw new ApiError(409, 'INVALID_STATE_TRANSITION', '受取できる配達がありません');
  }
  await client.assignment.update({
    where: { id: assignment.id },
    data: { pickedUpAt: new Date() },
  });
  await client.order.update({
    where: { id: assignment.orderId },
    data: { status: 'PICKED_UP' },
  });
}

async function completeAssignment(driver, assignmentId, transaction) {
  if (driver.status !== 'BUSY') {
    throw new ApiError(409, 'INVALID_STATE_TRANSITION', '配達中のみ完了できます');
  }
  const assignment = await transaction.assignment.findFirst({
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
  const scoreAward = {
    points: event.points,
    reason: event.reason,
    breakdown,
    createdAt: event.createdAt,
  };
  const updated = await transaction.driver.findUnique({ where: { id: driver.id } });
  await createNextOffer(updated, transaction);
  return scoreAward;
}

async function logoutDriver(driver, client) {
  if (driver.status !== 'OFFLINE') {
    throw new ApiError(409, 'INVALID_STATE_TRANSITION', '勤務中はログアウトできません。退勤してからログアウトしてください');
  }
  await client.driver.update({
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
  if (request.method === 'GET' && url.pathname === '/elevation-profile.js') return serveFile(response, path.join(webPublicDirectory, 'elevation-profile.js'), 'application/javascript; charset=utf-8');
  if (request.method === 'GET' && url.pathname === '/bottom-sheet.js') return serveFile(response, path.join(webPublicDirectory, 'bottom-sheet.js'), 'application/javascript; charset=utf-8');
  if (request.method === 'GET' && url.pathname === '/app.js') return serveFile(response, path.join(webPublicDirectory, 'app.js'), 'application/javascript; charset=utf-8');
  if (request.method === 'GET' && url.pathname === '/delivery-ui.js') return serveFile(response, path.join(webPublicDirectory, 'delivery-ui.js'), 'application/javascript; charset=utf-8');
  if (request.method === 'GET' && url.pathname === '/offline-actions.js') return serveFile(response, path.join(webPublicDirectory, 'offline-actions.js'), 'application/javascript; charset=utf-8');
  if (request.method === 'GET' && url.pathname === '/delivery-map.js') return serveFile(response, path.join(webPublicDirectory, 'delivery-map.js'), 'application/javascript; charset=utf-8');
  if (request.method === 'GET' && url.pathname === '/vendor/leaflet.js') return serveFile(response, require.resolve('leaflet/dist/leaflet.js'), 'application/javascript; charset=utf-8');
  if (request.method === 'GET' && url.pathname === '/vendor/leaflet.css') return serveFile(response, require.resolve('leaflet/dist/leaflet.css'), 'text/css; charset=utf-8');
  if (request.method === 'GET' && url.pathname === '/style.css') return serveFile(response, path.join(webPublicDirectory, 'style.css'), 'text/css; charset=utf-8');
  if (request.method === 'GET' && url.pathname === '/manifest.webmanifest') return serveFile(response, path.join(webPublicDirectory, 'manifest.webmanifest'), 'application/manifest+json; charset=utf-8');
  if (request.method === 'GET' && /^\/icons\/app-icon-(180|192|512)\.png$/.test(url.pathname)) {
    return serveFile(response, path.join(webPublicDirectory, url.pathname.slice(1)), 'image/png');
  }

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
    const location = await readJsonBody(request);
    const updatedLocation = await databaseTransaction(async (transaction) => {
      const current = await transaction.driver.findUnique({ where: { id: driver.id } });
      if (!current || current.accessTokenHash !== driver.accessTokenHash) {
        throw new ApiError(401, 'UNAUTHORIZED', 'ログインし直してください');
      }
      return updateDriverLocation(current, location, transaction);
    });
    json(response, 200, updatedLocation);
    realtimeHub.publish('location.updated');
    return;
  }

  const idempotentResponse = async (operation, reason) => {
    const result = await runIdempotently(request, driver, operation);
    if (reason === 'simulator.updated' && !result.replayed) simulatedWeatherCondition = result.body.weatherCondition;
    json(response, result.status, result.body);
    realtimeHub.publish(reason);
  };

  if (request.method === 'POST' && url.pathname === '/api/shifts/start') {
    return idempotentResponse((client, current) => startShift(current, client), 'shift.started');
  }
  if (request.method === 'POST' && url.pathname === '/api/shifts/end') {
    return idempotentResponse((client, current) => endShift(current, client), 'shift.ended');
  }
  if (request.method === 'POST' && url.pathname === '/api/offers/current') {
    return idempotentResponse((client, current) => showCurrentOffer(current, client), 'offer.shown');
  }
  if (request.method === 'POST' && url.pathname === '/api/logout') {
    await idempotentResponse(async (client, current) => {
      await logoutDriver(current, client);
      return { message: 'ログアウトしました' };
    }, 'session.ended');
    realtimeHub.disconnectDriver(driver.id);
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/simulator/weather') {
    const { condition } = await readJsonBody(request);
    return idempotentResponse((client) => updateSimulatorWeather(condition, client), 'simulator.updated');
  }

  const accept = url.pathname.match(/^\/api\/offers\/(\d+)\/accept$/);
  if (request.method === 'POST' && accept) {
    return idempotentResponse(async (client, current) => {
      await acceptOffer(current, Number(accept[1]), client);
      return dashboard(current.id, client);
    }, 'offer.accepted');
  }
  const reject = url.pathname.match(/^\/api\/offers\/(\d+)\/reject$/);
  if (request.method === 'POST' && reject) {
    return idempotentResponse(async (client, current) => {
      await rejectOffer(current, Number(reject[1]), client);
      return dashboard(current.id, client);
    }, 'offer.rejected');
  }
  const pickup = url.pathname.match(/^\/api\/assignments\/(\d+)\/pickup$/);
  if (request.method === 'POST' && pickup) {
    return idempotentResponse(async (client, current) => {
      await pickupAssignment(current, Number(pickup[1]), client);
      return dashboard(current.id, client);
    }, 'assignment.picked_up');
  }
  const complete = url.pathname.match(/^\/api\/assignments\/(\d+)\/complete$/);
  if (request.method === 'POST' && complete) {
    return idempotentResponse(async (client, current) => {
      const scoreAward = await completeAssignment(current, Number(complete[1]), client);
      return { ...await dashboard(current.id, client), scoreAward };
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

