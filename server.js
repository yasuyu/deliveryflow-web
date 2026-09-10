const http = require('http');
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('./generated/client-v2');

process.env.DATABASE_URL = 'file:./delivery.db';

const prisma = new PrismaClient();
const port = Number(process.env.PORT || 3000);
const offerTtlMilliseconds = 2 * 60 * 1000;

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new ApiError(400, 'INVALID_JSON', 'JSONの形式が正しくありません'));
      }
    });
  });
}

function serveFile(response, fileName, contentType) {
  fs.readFile(path.join(__dirname, 'public', fileName), (error, content) => {
    if (error) {
      json(response, 404, { code: 'NOT_FOUND', message: 'ファイルが見つかりません' });
      return;
    }
    response.writeHead(200, { 'Content-Type': contentType });
    response.end(content);
  });
}

async function currentDriver(client = prisma) {
  return client.driver.findFirst({ orderBy: { id: 'asc' } });
}

async function authenticateDriver(request) {
  const authorization = request.headers.authorization || '';
  const match = authorization.match(/^Bearer (\d+)$/);
  if (!match) {
    throw new ApiError(401, 'UNAUTHORIZED', 'AuthorizationヘッダーにBearerトークンが必要です');
  }
  const driver = await prisma.driver.findUnique({ where: { id: Number(match[1]) } });
  if (!driver) throw new ApiError(401, 'UNAUTHORIZED', '配達員が見つかりません');
  return driver;
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

  const store = await client.store.findFirst();
  const number = (await client.order.count()) + 1;
  const order = await client.order.create({
    data: {
      storeId: store.id,
      pickupName: store.name,
      dropoffName: `プリズムハウス ${number}号館`,
      status: 'OFFERING',
    },
  });
  await client.offer.create({
    data: {
      driverId: driver.id,
      orderId: order.id,
      expiresAt: new Date(Date.now() + offerTtlMilliseconds),
    },
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
}

async function ensureSeed() {
  let driver = await currentDriver();
  if (!driver) {
    driver = await prisma.driver.create({ data: { name: '山田 配達員' } });
    await prisma.store.create({
      data: { name: 'BKC カフェ', address: '立命館大学 BKC' },
    });
  }

  await prisma.offer.updateMany({
    where: { status: 'PENDING', expiresAt: null },
    data: { expiresAt: new Date(Date.now() + offerTtlMilliseconds) },
  });

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
    driver: await prisma.driver.findUnique({ where: { id: driverId } }),
    offer,
    assignment,
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
  return updated;
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
      data: { status: 'OFFLINE', shiftStartedAt: null },
    }),
  ]);
  for (const offer of pendingOffers) {
    await restoreOrderWhenCandidatesAreGone(offer.orderId);
  }
  return prisma.driver.findUnique({ where: { id: driver.id } });
}

async function showCurrentOffer(driver) {
  if (driver.status !== 'IDLE') {
    throw new ApiError(409, 'INVALID_STATE_TRANSITION', '待機中のときだけオファーを表示できます');
  }
  await expireOffers();
  await createNextOffer(driver);
  const offer = await prisma.offer.findFirst({
    where: { driverId: driver.id, status: 'PENDING' },
  });
  if (!offer) throw new ApiError(404, 'OFFER_NOT_FOUND', '現在のオファーはありません');

  await prisma.driver.update({
    where: { id: driver.id },
    data: { status: 'OFFERED' },
  });
  return offer;
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
    await transaction.driver.update({
      where: { id: driver.id },
      data: { status: 'BUSY' },
    });
    await transaction.assignment.create({
      data: { orderId: offer.orderId, driverId: driver.id },
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
    include: { order: true },
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
    include: { order: true },
  });
  if (!assignment || assignment.order.status !== 'PICKED_UP') {
    throw new ApiError(409, 'INVALID_STATE_TRANSITION', '完了できる配達がありません');
  }
  await prisma.$transaction([
    prisma.assignment.update({
      where: { id: assignment.id },
      data: { deliveredAt: new Date() },
    }),
    prisma.order.update({
      where: { id: assignment.orderId },
      data: { status: 'DELIVERED' },
    }),
    prisma.driver.update({ where: { id: driver.id }, data: { status: 'IDLE' } }),
  ]);
  await createNextOffer(driver);
}

async function handle(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);

  if (request.method === 'GET' && url.pathname === '/') return serveFile(response, 'index.html', 'text/html; charset=utf-8');
  if (request.method === 'GET' && url.pathname === '/docs') return serveFile(response, 'docs.html', 'text/html; charset=utf-8');
  if (request.method === 'GET' && url.pathname === '/openapi.yaml') return serveFile(response, '../docs/openapi.yaml', 'text/yaml; charset=utf-8');
  if (request.method === 'GET' && url.pathname === '/app.js') return serveFile(response, 'app.js', 'application/javascript; charset=utf-8');
  if (request.method === 'GET' && url.pathname === '/style.css') return serveFile(response, 'style.css', 'text/css; charset=utf-8');

  if (request.method === 'POST' && url.pathname === '/api/drivers') {
    const { name } = await readJsonBody(request);
    if (!name || !name.trim()) {
      throw new ApiError(400, 'VALIDATION_ERROR', '配達員名を入力してください');
    }
    const newDriver = await prisma.driver.create({ data: { name: name.trim() } });
    return json(response, 201, newDriver);
  }

  const driver = await authenticateDriver(request);
  if (request.method === 'GET' && url.pathname === '/api/dashboard') {
    return json(response, 200, await dashboard(driver.id));
  }

  const idempotentResponse = async (operation) => {
    const result = await runIdempotently(request, driver, operation);
    return json(response, result.status, result.body);
  };

  if (request.method === 'POST' && url.pathname === '/api/shifts/start') {
    return idempotentResponse(() => startShift(driver));
  }
  if (request.method === 'POST' && url.pathname === '/api/shifts/end') {
    return idempotentResponse(() => endShift(driver));
  }
  if (request.method === 'POST' && url.pathname === '/api/offers/current') {
    return idempotentResponse(() => showCurrentOffer(driver));
  }

  const accept = url.pathname.match(/^\/api\/offers\/(\d+)\/accept$/);
  if (request.method === 'POST' && accept) {
    return idempotentResponse(async () => {
      await acceptOffer(driver, Number(accept[1]));
      return dashboard(driver.id);
    });
  }
  const reject = url.pathname.match(/^\/api\/offers\/(\d+)\/reject$/);
  if (request.method === 'POST' && reject) {
    return idempotentResponse(async () => {
      await rejectOffer(driver, Number(reject[1]));
      return dashboard(driver.id);
    });
  }
  const pickup = url.pathname.match(/^\/api\/assignments\/(\d+)\/pickup$/);
  if (request.method === 'POST' && pickup) {
    return idempotentResponse(async () => {
      await pickupAssignment(driver, Number(pickup[1]));
      return dashboard(driver.id);
    });
  }
  const complete = url.pathname.match(/^\/api\/assignments\/(\d+)\/complete$/);
  if (request.method === 'POST' && complete) {
    return idempotentResponse(async () => {
      await completeAssignment(driver, Number(complete[1]));
      return dashboard(driver.id);
    });
  }
  return json(response, 404, { code: 'NOT_FOUND', message: 'このエンドポイントは存在しません' });
}

const server = http.createServer(async (request, response) => {
  try {
    await handle(request, response);
  } catch (error) {
    console.error(error);
    json(response, error.status || 500, {
      code: error.code || 'INTERNAL_ERROR',
      message: error.status ? error.message : 'サーバーでエラーが発生しました',
    });
  }
});

ensureSeed().then(() => {
  server.listen(port, () => console.log(`DeliveryFlow is running at http://localhost:${port}`));
});
