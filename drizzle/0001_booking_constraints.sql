-- Integrity for the booking domain, enforced by the database.
--
-- The headline is the exclusion constraint on appointments. Everything else
-- in this file is the same idea applied to smaller things: if a rule can be
-- expressed as a constraint, it belongs here rather than in the application,
-- because the application runs many times concurrently and the database runs
-- once.

-- btree_gist lets a GiST index hold a plain uuid alongside a range, which is
-- what makes the per-staff exclusion constraint possible: GiST alone cannot
-- index equality on a uuid.
CREATE EXTENSION IF NOT EXISTS btree_gist;--> statement-breakpoint

-- The block of time an appointment occupies, including its buffers.
--
-- Two plain columns plus a generated range, rather than a range generated
-- directly from starts_at and the buffer minutes. That would be the obvious
-- way to write it and Postgres refuses it: `timestamptz - interval` is marked
-- STABLE, not IMMUTABLE, because interval arithmetic depends on the session's
-- TimeZone setting. A generated column may only use immutable expressions, so
-- the subtraction has to happen somewhere else.
--
-- A trigger is that somewhere, not the application. If the application filled
-- these columns it could fill them wrongly -- a stale buffer value, a forgotten
-- update path -- and the exclusion constraint below would faithfully protect
-- the wrong interval. The trigger runs on every insert and update of the
-- relevant columns, so there is one definition of what time an appointment
-- occupies and nothing can write a row that disagrees with it.
ALTER TABLE "appointments"
  ADD COLUMN "blocked_from" timestamptz,
  ADD COLUMN "blocked_to" timestamptz;--> statement-breakpoint

CREATE OR REPLACE FUNCTION appointments_set_block() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  NEW.blocked_from := NEW.starts_at - make_interval(mins => NEW.buffer_before_minutes);
  NEW.blocked_to   := NEW.ends_at   + make_interval(mins => NEW.buffer_after_minutes);
  RETURN NEW;
END
$$;--> statement-breakpoint

CREATE TRIGGER appointments_block_trigger
  BEFORE INSERT OR UPDATE OF starts_at, ends_at, buffer_before_minutes, buffer_after_minutes
  ON "appointments"
  FOR EACH ROW EXECUTE FUNCTION appointments_set_block();--> statement-breakpoint

-- Now the range itself is immutable: a tstzrange over two timestamps.
--
-- '[)' makes it half-open, so an appointment ending at 10:00 and one starting
-- at 10:00 do not conflict. With '[]' they would, and the business could not
-- book back-to-back customers -- the single most common bug in a hand-rolled
-- booking system.
ALTER TABLE "appointments"
  ADD COLUMN "during" tstzrange GENERATED ALWAYS AS (
    tstzrange("blocked_from", "blocked_to", '[)')
  ) STORED;--> statement-breakpoint

-- Belt and braces: the block must cover the appointment. This cannot catch a
-- wrong buffer, but it does catch a block that does not contain the
-- appointment at all, which is the failure that would silently disable the
-- exclusion constraint.
ALTER TABLE "appointments"
  ADD CONSTRAINT "appointments_block_covers_appointment"
  CHECK ("blocked_from" <= "starts_at" AND "blocked_to" >= "ends_at");--> statement-breakpoint

-- No member of staff can be in two appointments at once.
--
-- This is the whole reason the column above exists. Checking availability and
-- then inserting is two statements: two requests can both run the check
-- before either inserts, and both succeed. Serialising the check with an
-- advisory lock would work but puts the correctness in the application, where
-- the next caller can forget it. An exclusion constraint cannot be forgotten
-- -- a conflicting insert raises 23P01 whatever wrote it, including a
-- migration, a psql session, or a future endpoint nobody has written yet.
--
-- Cancelled appointments are excluded by the WHERE clause, so cancelling
-- genuinely frees the slot while the row is kept for the record.
ALTER TABLE "appointments"
  ADD CONSTRAINT "appointments_no_double_booking"
  EXCLUDE USING gist ("staff_id" WITH =, "during" WITH &&)
  WHERE (status <> 'cancelled');--> statement-breakpoint

-- The same for the customer: a person cannot be in two places either, and a
-- duplicate submission that slips past the idempotency key lands here.
ALTER TABLE "appointments"
  ADD CONSTRAINT "appointments_customer_no_overlap"
  EXCLUDE USING gist ("customer_id" WITH =, "during" WITH &&)
  WHERE (status <> 'cancelled');--> statement-breakpoint

-- An appointment has to end after it starts. Obvious, and worth stating:
-- without it a zero- or negative-length appointment makes an empty range,
-- and an empty range overlaps nothing, so the exclusion constraint above
-- would let any number of them through.
ALTER TABLE "appointments"
  ADD CONSTRAINT "appointments_ends_after_starts" CHECK ("ends_at" > "starts_at");--> statement-breakpoint

ALTER TABLE "appointments"
  ADD CONSTRAINT "appointments_buffers_non_negative"
  CHECK ("buffer_before_minutes" >= 0 AND "buffer_after_minutes" >= 0);--> statement-breakpoint

ALTER TABLE "appointments"
  ADD CONSTRAINT "appointments_money_non_negative"
  CHECK ("price_minor" >= 0 AND "deposit_minor" >= 0 AND "deposit_minor" <= "price_minor");--> statement-breakpoint

-- A cancelled appointment must say when, and an uncancelled one must not
-- claim to have been. Status and timestamp drifting apart is how a diary ends
-- up showing a cancelled booking as live.
ALTER TABLE "appointments"
  ADD CONSTRAINT "appointments_cancelled_at_matches_status"
  CHECK (("status" = 'cancelled') = ("cancelled_at" IS NOT NULL));--> statement-breakpoint

-- The idempotency key is unique per organization, but only when present.
-- A partial index is the right tool: a plain unique index would treat every
-- NULL as distinct, which is correct but hides the intent, and a NOT NULL
-- column would force a key onto bookings made from the admin UI.
CREATE UNIQUE INDEX "appointments_idempotency_uq"
  ON "appointments" ("org_id", "idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;--> statement-breakpoint

-- Looking up a diary is always "this staff member, this window", so the
-- range index carries the staff id too.
CREATE INDEX "appointments_during_idx" ON "appointments" USING gist ("staff_id", "during");--> statement-breakpoint

-- Service rules that make no sense as numbers.
ALTER TABLE "services"
  ADD CONSTRAINT "services_duration_positive" CHECK ("duration_minutes" > 0);--> statement-breakpoint
ALTER TABLE "services"
  ADD CONSTRAINT "services_step_positive" CHECK ("step_minutes" > 0);--> statement-breakpoint
ALTER TABLE "services"
  ADD CONSTRAINT "services_buffers_non_negative"
  CHECK ("buffer_before_minutes" >= 0 AND "buffer_after_minutes" >= 0);--> statement-breakpoint
ALTER TABLE "services"
  ADD CONSTRAINT "services_notice_non_negative"
  CHECK ("minimum_notice_minutes" >= 0 AND "maximum_advance_days" >= 0);--> statement-breakpoint
ALTER TABLE "services"
  ADD CONSTRAINT "services_price_non_negative"
  CHECK ("price_minor" >= 0 AND ("deposit_minor" IS NULL OR
         ("deposit_minor" >= 0 AND "deposit_minor" <= "price_minor")));--> statement-breakpoint
-- A currency is three letters, upper case. ISO 4217, checked here because a
-- lower-case 'gbp' reaching Stripe is a runtime error in a payment path.
ALTER TABLE "services"
  ADD CONSTRAINT "services_currency_iso" CHECK ("currency" ~ '^[A-Z]{3}$');--> statement-breakpoint
ALTER TABLE "appointments"
  ADD CONSTRAINT "appointments_currency_iso" CHECK ("currency" ~ '^[A-Z]{3}$');--> statement-breakpoint

-- Availability rules: a weekday is 0-6, and a window ends after it starts.
-- end_minute may exceed 1440, which is how a business open until 02:00 is
-- expressed, but two days is the limit -- past that it is a mistake.
ALTER TABLE "availability_rules"
  ADD CONSTRAINT "availability_rules_weekday_range" CHECK ("weekday" BETWEEN 0 AND 6);--> statement-breakpoint
ALTER TABLE "availability_rules"
  ADD CONSTRAINT "availability_rules_window_sane"
  CHECK ("start_minute" >= 0 AND "start_minute" < 1440
         AND "end_minute" > "start_minute" AND "end_minute" <= 2880);--> statement-breakpoint
-- Dates are stored as text because a calendar date is not an instant. The
-- format is checked so a malformed one fails at write time rather than when
-- something tries to parse it months later.
ALTER TABLE "availability_rules"
  ADD CONSTRAINT "availability_rules_dates_iso"
  CHECK (("valid_from" IS NULL OR "valid_from" ~ '^\d{4}-\d{2}-\d{2}$')
         AND ("valid_until" IS NULL OR "valid_until" ~ '^\d{4}-\d{2}-\d{2}$')
         AND ("valid_from" IS NULL OR "valid_until" IS NULL OR "valid_from" <= "valid_until"));--> statement-breakpoint

ALTER TABLE "date_overrides"
  ADD CONSTRAINT "date_overrides_date_iso" CHECK ("on_date" ~ '^\d{4}-\d{2}-\d{2}$');--> statement-breakpoint
-- A closed day carries no windows, and an open override carries at least one.
-- Allowing both would make "closed with hours" representable.
ALTER TABLE "date_overrides"
  ADD CONSTRAINT "date_overrides_closed_has_no_windows"
  CHECK (NOT "closed" OR jsonb_array_length("windows") = 0);--> statement-breakpoint

ALTER TABLE "time_off"
  ADD CONSTRAINT "time_off_ends_after_starts" CHECK ("ends_at" > "starts_at");--> statement-breakpoint

-- Reminders: an offset is before the appointment, and a sent one has a time.
ALTER TABLE "reminders"
  ADD CONSTRAINT "reminders_offset_positive" CHECK ("offset_minutes" > 0);--> statement-breakpoint
ALTER TABLE "reminders"
  ADD CONSTRAINT "reminders_sent_at_matches_status"
  CHECK (("status" = 'sent') = ("sent_at" IS NOT NULL));--> statement-breakpoint

-- A member of staff can only be assigned a service from the same
-- organization. Composite foreign keys, so the database enforces what would
-- otherwise be an application invariant that a single bad insert breaks.
ALTER TABLE "services" ADD CONSTRAINT "services_org_id_id_uq" UNIQUE ("org_id", "id");--> statement-breakpoint
ALTER TABLE "staff" ADD CONSTRAINT "staff_org_id_id_uq" UNIQUE ("org_id", "id");--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_org_id_id_uq" UNIQUE ("org_id", "id");--> statement-breakpoint
ALTER TABLE "staff_services"
  ADD CONSTRAINT "staff_services_staff_same_org"
  FOREIGN KEY ("org_id", "staff_id") REFERENCES "staff" ("org_id", "id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "staff_services"
  ADD CONSTRAINT "staff_services_service_same_org"
  FOREIGN KEY ("org_id", "service_id") REFERENCES "services" ("org_id", "id") ON DELETE CASCADE;--> statement-breakpoint
-- The same for an appointment: its service, staff and customer must all
-- belong to the organization the appointment does. Without this, a bug in one
-- endpoint could book another business's staff member.
ALTER TABLE "appointments"
  ADD CONSTRAINT "appointments_service_same_org"
  FOREIGN KEY ("org_id", "service_id") REFERENCES "services" ("org_id", "id");--> statement-breakpoint
ALTER TABLE "appointments"
  ADD CONSTRAINT "appointments_staff_same_org"
  FOREIGN KEY ("org_id", "staff_id") REFERENCES "staff" ("org_id", "id");--> statement-breakpoint
ALTER TABLE "appointments"
  ADD CONSTRAINT "appointments_customer_same_org"
  FOREIGN KEY ("org_id", "customer_id") REFERENCES "customers" ("org_id", "id");
