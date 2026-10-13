ALTER TABLE "Offer" ADD COLUMN "priorityRank" INTEGER;
CREATE UNIQUE INDEX "Offer_one_prioritized_pending_per_order" ON "Offer"("orderId") WHERE "status" = 'PENDING' AND "priorityRank" IS NOT NULL;
CREATE TABLE "MonthlyAwardPeriod" (
  "id" SERIAL NOT NULL,
  "month" TEXT NOT NULL,
  "startsAt" TIMESTAMP(3) NOT NULL,
  "endsAt" TIMESTAMP(3) NOT NULL,
  "finalizedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MonthlyAwardPeriod_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "MonthlyAwardPeriod_month_key" ON "MonthlyAwardPeriod"("month");
CREATE TABLE "MonthlyAward" (
  "id" SERIAL NOT NULL,
  "driverId" INTEGER NOT NULL,
  "month" TEXT NOT NULL,
  "rank" INTEGER NOT NULL,
  "points" INTEGER NOT NULL,
  "title" TEXT NOT NULL,
  "awardedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MonthlyAward_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "MonthlyAward_driverId_month_key" ON "MonthlyAward"("driverId", "month");
CREATE INDEX "MonthlyAward_driverId_rank_idx" ON "MonthlyAward"("driverId", "rank");
ALTER TABLE "MonthlyAward" ADD CONSTRAINT "MonthlyAward_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MonthlyAward" ADD CONSTRAINT "MonthlyAward_month_fkey" FOREIGN KEY ("month") REFERENCES "MonthlyAwardPeriod"("month") ON DELETE RESTRICT ON UPDATE CASCADE;
