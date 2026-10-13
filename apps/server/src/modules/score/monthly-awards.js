const japanOffset = 9 * 60 * 60 * 1000;
const monthlyTitles = new Map([[1, '月間チャンピオン'], [2, '月間準優勝'], [3, '月間トップ3']]);

function japanMonthWindow(now = new Date()) {
  const local = new Date(now.getTime() + japanOffset);
  const year = local.getUTCFullYear();
  const month = local.getUTCMonth();
  return {
    label: `${year}-${String(month + 1).padStart(2, '0')}`,
    startsAt: new Date(Date.UTC(year, month, 1) - japanOffset),
    endsAt: new Date(Date.UTC(year, month + 1, 1) - japanOffset),
  };
}

function monthlyPodium(scores) {
  const sorted = scores.filter(({ points }) => points > 0)
    .sort((a, b) => b.points - a.points || a.driverId - b.driverId);
  let previous;
  let rank = 0;
  return sorted.flatMap((entry, index) => {
    if (entry.points !== previous) rank = index + 1;
    previous = entry.points;
    return rank <= 3 ? [{ ...entry, rank, title: monthlyTitles.get(rank) }] : [];
  });
}

async function finalizeCompletedMonths(client, now = new Date()) {
  const current = japanMonthWindow(now);
  const oldest = await client.scoreEvent.findFirst({
    where: { createdAt: { lt: current.startsAt } }, orderBy: { createdAt: 'asc' },
    select: { createdAt: true },
  });
  if (!oldest) return;
  const existing = new Set((await client.monthlyAwardPeriod.findMany({
    select: { month: true },
  })).map(({ month }) => month));
  let window = japanMonthWindow(oldest.createdAt);
  while (window.startsAt < current.startsAt) {
    if (!existing.has(window.label)) {
      const scores = await client.scoreEvent.groupBy({
        by: ['driverId'], where: { createdAt: { gte: window.startsAt, lt: window.endsAt } },
        _sum: { points: true },
      });
      const awards = monthlyPodium(scores.map(({ driverId, _sum }) => ({ driverId, points: _sum.points || 0 })));
      // Period and all awards are created together in the caller's transaction.
      await client.monthlyAwardPeriod.create({ data: {
        month: window.label, startsAt: window.startsAt, endsAt: window.endsAt,
        awards: { create: awards.map(({ driverId, points, rank, title }) => ({ driverId, points, rank, title })) },
      } });
      return true;
    }
    window = japanMonthWindow(window.endsAt);
  }
  return false;
}

function createMonthlyAwardMaintenance(runTransaction, { now = () => new Date() } = {}) {
  let finalizedFor;
  let pending;
  return {
    async onActivity() {
      const at = now();
      const month = japanMonthWindow(at).label;
      if (month === finalizedFor) return;
      if (pending) {
        await pending;
        return this.onActivity();
      }
      // One period per transaction keeps historical backfills within the DB
      // timeout. A failed batch can resume from its already committed periods.
      pending = (async () => {
        while (await runTransaction((client) => finalizeCompletedMonths(client, at))) {}
      })();
      try {
        await pending;
        finalizedFor = month;
      } finally { pending = null; }
    },
  };
}

async function listMonthlyAwards(client, driverId, cursor = null) {
  const where = { driverId };
  if (cursor !== null) {
    const anchor = await client.monthlyAward.findFirst({ where: { id: cursor, driverId }, select: { month: true } });
    if (!anchor) return null;
    where.month = { lt: anchor.month };
  }
  const rows = await client.monthlyAward.findMany({
    where, orderBy: { month: 'desc' }, take: 21,
    select: { id: true, month: true, rank: true, title: true, points: true },
  });
  const awards = rows.slice(0, 20);
  return { awards, pagination: {
    pageSize: 20, hasMore: rows.length > 20, nextCursor: rows.length > 20 ? awards.at(-1).id : null,
  } };
}

module.exports = { japanMonthWindow, monthlyPodium, finalizeCompletedMonths, createMonthlyAwardMaintenance, listMonthlyAwards };
