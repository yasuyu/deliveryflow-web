CREATE TABLE "IdempotencyKey" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "key" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "driverId" INTEGER NOT NULL,
    "response" TEXT,
    "statusCode" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "IdempotencyKey_key_endpoint_driverId_key"
ON "IdempotencyKey"("key", "endpoint", "driverId");
