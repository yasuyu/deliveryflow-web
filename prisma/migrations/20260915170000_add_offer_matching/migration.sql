ALTER TABLE "Offer" ADD COLUMN "distanceToPickupMeters" INTEGER;

CREATE UNIQUE INDEX "Offer_orderId_driverId_key" ON "Offer"("orderId", "driverId");
CREATE INDEX "Offer_driverId_status_idx" ON "Offer"("driverId", "status");
CREATE INDEX "Offer_orderId_status_idx" ON "Offer"("orderId", "status");
