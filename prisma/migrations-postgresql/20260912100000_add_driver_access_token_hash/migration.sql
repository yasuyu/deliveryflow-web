ALTER TABLE "Driver" ADD COLUMN "accessTokenHash" TEXT;
CREATE UNIQUE INDEX "Driver_accessTokenHash_key" ON "Driver"("accessTokenHash");
