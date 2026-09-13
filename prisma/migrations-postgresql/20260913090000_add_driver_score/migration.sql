ALTER TABLE "Driver" ADD COLUMN "score" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "ScoreRule" (
    "id" SERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "points" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ScoreRule_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ScoreEvent" (
    "id" SERIAL NOT NULL,
    "driverId" INTEGER NOT NULL,
    "assignmentId" INTEGER NOT NULL,
    "points" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ScoreEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ScoreRule_code_key" ON "ScoreRule"("code");
CREATE UNIQUE INDEX "ScoreEvent_assignmentId_key" ON "ScoreEvent"("assignmentId");
CREATE INDEX "ScoreEvent_driverId_createdAt_idx" ON "ScoreEvent"("driverId", "createdAt");

ALTER TABLE "ScoreEvent" ADD CONSTRAINT "ScoreEvent_driverId_fkey"
FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ScoreEvent" ADD CONSTRAINT "ScoreEvent_assignmentId_fkey"
FOREIGN KEY ("assignmentId") REFERENCES "Assignment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
