-- PENDING Offerの期限をサーバー時刻で管理する
ALTER TABLE "Offer" ADD COLUMN "expiresAt" DATETIME;
