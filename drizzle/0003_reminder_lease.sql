-- A lease on a claimed reminder.
--
-- The bug this fixes: claiming used `SELECT ... FOR UPDATE SKIP LOCKED` and
-- then raised the attempt count, leaving the row `scheduled`. SKIP LOCKED only
-- holds for the life of the transaction, and the message is sent *after* that
-- transaction commits -- so a second worker starting in the gap claimed the
-- same reminder and the customer was texted twice.
--
-- A row is now moved to `sending` with the time it was claimed. The claim
-- query takes rows that are due and scheduled, plus rows stuck in `sending`
-- past their lease -- which is how a worker that died mid-send is recovered
-- without a separate sweeper.
ALTER TYPE "reminder_status" ADD VALUE IF NOT EXISTS 'sending';--> statement-breakpoint

ALTER TABLE "reminders" ADD COLUMN "claimed_at" timestamptz;--> statement-breakpoint

-- The claim query's index: due and claimable, in due order.
CREATE INDEX "reminders_claimable_idx" ON "reminders" ("status", "due_at");--> statement-breakpoint

-- A reminder in flight must say when it was claimed, or its lease can never
-- expire and it is lost for good.
ALTER TABLE "reminders"
  ADD CONSTRAINT "reminders_sending_has_claimed_at"
  CHECK ("status" <> 'sending' OR "claimed_at" IS NOT NULL);
