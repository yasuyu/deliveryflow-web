-- 利用人数を保存できるよう、既存のOrderテーブルに列を追加するMigration
-- 既存の依頼は全て1人として扱う
ALTER TABLE "Order" ADD COLUMN "passengerCount" INTEGER NOT NULL DEFAULT 1;
