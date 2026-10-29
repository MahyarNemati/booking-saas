-- The parts of the reminder lease that the schema file cannot express.
--
-- A check constraint and a composite index, so they live here rather than in
-- a generated migration. See 0003 for the column and the enum value.

-- The claim query's index: due and claimable, in due order.
CREATE INDEX "reminders_claimable_idx" ON "reminders" ("status", "due_at");--> statement-breakpoint

-- A reminder in flight must say when it was claimed, or its lease can never
-- expire and the reminder is lost for good.
ALTER TABLE "reminders"
  ADD CONSTRAINT "reminders_sending_has_claimed_at"
  CHECK ("status" <> 'sending' OR "claimed_at" IS NOT NULL);
