ALTER TABLE "Offer" ADD COLUMN "priorityRank" INTEGER;
CREATE UNIQUE INDEX "Offer_one_prioritized_pending_per_order" ON "Offer"("orderId") WHERE "status" = 'PENDING' AND "priorityRank" IS NOT NULL;
CREATE TABLE "MonthlyAwardPeriod" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "month" TEXT NOT NULL,
  "startsAt" DATETIME NOT NULL,
  "endsAt" DATETIME NOT NULL,
  "finalizedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "MonthlyAwardPeriod_month_key" ON "MonthlyAwardPeriod"("month");
CREATE TABLE "MonthlyAward" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "driverId" INTEGER NOT NULL,
  "month" TEXT NOT NULL,
  "rank" INTEGER NOT NULL,
  "points" INTEGER NOT NULL,
  "title" TEXT NOT NULL,
  "awardedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MonthlyAward_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "MonthlyAward_month_fkey" FOREIGN KEY ("month") REFERENCES "MonthlyAwardPeriod"("month") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "MonthlyAward_driverId_month_key" ON "MonthlyAward"("driverId", "month");
CREATE INDEX "MonthlyAward_driverId_rank_idx" ON "MonthlyAward"("driverId", "rank");
