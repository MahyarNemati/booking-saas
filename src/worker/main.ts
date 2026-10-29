/**
 * The background worker.
 *
 * Two jobs, both of which have to happen whether or not anyone is looking at
 * the website: sending reminders that have come due, and releasing slots whose
 * payment never arrived.
 *
 * Deliberately a separate process from the web app rather than a timer inside
 * it. A Next.js server can be scaled to zero, restarted on deploy, or run as
 * several instances; none of those is a safe home for work that must happen
 * once at a particular time. Safe to run as several instances itself: the
 * claim is leased, so two workers never send the same reminder.
 */

import { getDb } from "@/db/client";
import { env } from "@/env";
import { logger } from "@/lib/logger";
import { releaseUnpaidHolds } from "@/server/payments/service";
import {
  LoggingSender,
  TwilioSender,
  type MessageSender,
} from "@/server/reminders/provider";
import { runOnce, stuckReminders } from "@/server/reminders/service";
import type { ReminderChannel } from "@/db/schema";

const TICK_MS = 30_000;
/** How often to report on reminders that are not getting out. */
const AUDIT_EVERY_TICKS = 20;

function buildSenders(): Partial<Record<ReminderChannel, MessageSender>> {
  const e = env();
  const senders: Partial<Record<ReminderChannel, MessageSender>> = {};

  if (e.TWILIO_ACCOUNT_SID && e.TWILIO_AUTH_TOKEN && e.TWILIO_FROM) {
    senders.sms = new TwilioSender(
      {
        accountSid: e.TWILIO_ACCOUNT_SID,
        authToken: e.TWILIO_AUTH_TOKEN,
        from: e.TWILIO_FROM,
      },
      logger,
    );
  } else {
    // Logging rather than silently dropping: a developer running this locally
    // should be able to see the message that would have been sent.
    logger.warn(
      "no Twilio credentials; SMS reminders will be logged, not sent",
    );
    senders.sms = new LoggingSender("sms", logger);
  }

  // Email goes through the same interface. Wiring a real provider is a matter
  // of another MessageSender; the worker does not change.
  senders.email = new LoggingSender("email", logger);
  return senders;
}

async function main(): Promise<void> {
  const db = getDb();
  const senders = buildSenders();
  let stopping = false;
  let ticks = 0;

  // Woken by a signal, so the sleep between passes is interruptible.
  let wake: (() => void) | null = null;

  // SIGTERM arrives on every deploy. Finishing the current pass rather than
  // dying mid-send means no reminder is left leased for its full timeout --
  // but the wait between passes must not be part of that, or a deploy sits
  // for up to a tick before the process exits and the orchestrator kills it.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      if (stopping) process.exit(1); // a second signal means now
      logger.info({ signal }, "worker stopping after the current pass");
      stopping = true;
      wake?.();
    });
  }

  logger.info({ tickMs: TICK_MS }, "worker started");

  while (!stopping) {
    const startedAt = Date.now();
    try {
      const outcome = await runOnce(db, senders, logger, { limit: 100 });
      if (outcome.sent || outcome.failed || outcome.skipped) {
        logger.info(outcome, "reminders processed");
      }

      const released = await releaseUnpaidHolds(db, {
        olderThanMinutes: env().BOOKING_HOLD_MINUTES,
      });
      if (released.length > 0) {
        logger.info({ count: released.length }, "released unpaid holds");
      }

      ticks += 1;
      if (ticks % AUDIT_EVERY_TICKS === 0) {
        const stuck = await stuckReminders(db);
        if (stuck.length > 0) {
          logger.warn(
            { count: stuck.length, ids: stuck.slice(0, 10).map((r) => r.id) },
            "reminders are overdue and not going out",
          );
        }
      }
    } catch (err) {
      // One bad pass must not stop the worker: the next tick may well
      // succeed, and a crash loop is harder to diagnose than a logged error.
      logger.error({ err: String(err) }, "worker pass failed");
    }

    // Measured from the start of the pass, so a slow pass does not add to the
    // interval and the worker keeps a steady cadence. Interruptible, so a
    // signal arriving during the wait is acted on at once rather than up to a
    // tick later.
    const elapsed = Date.now() - startedAt;
    if (!stopping && elapsed < TICK_MS) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, TICK_MS - elapsed);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      wake = null;
    }
  }

  logger.info("worker stopped");
  process.exit(0);
}

main().catch((err: unknown) => {
  logger.error({ err: String(err) }, "worker failed to start");
  process.exit(1);
});
