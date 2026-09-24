const path = require('node:path');
const { resetHackathonDemoRankings } = require('../apps/server/src/modules/demo/demo-fixtures');

if (!process.argv.includes('--confirm-demo-reset')) {
  console.error('デモ用ランキング実績を初期化するには --confirm-demo-reset を指定してください。');
  process.exitCode = 1;
  return;
}

const provider = process.env.DATABASE_PROVIDER || 'sqlite';
if (!['sqlite', 'postgresql'].includes(provider)) throw new Error('DATABASE_PROVIDER must be sqlite or postgresql');
const clientPath = provider === 'postgresql'
  ? path.resolve(__dirname, '../generated/client-postgresql')
  : path.resolve(__dirname, '../generated/client-v2');
const { PrismaClient } = require(clientPath);
const prisma = new PrismaClient();

resetHackathonDemoRankings(prisma)
  .then((result) => {
    console.log(`デモ用ランキングを初期状態へ戻しました（配達実績${result.resetDeliveries}件、配達員${result.competitors}人）。`);
  })
  .finally(() => prisma.$disconnect());
