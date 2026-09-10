-- OrderモデルをSQLiteのテーブルとして作成する最初のMigration
CREATE TABLE "Order" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "pickup" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "requestedAt" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "driver" TEXT,
    "eta" INTEGER
);
