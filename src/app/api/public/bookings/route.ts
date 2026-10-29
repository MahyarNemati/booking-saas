/**
 * The public booking endpoint.
 *
 * Open to the internet with no session, which shapes everything here: it is
 * rate limited, it only ever acts on the organization named by its slug, and
 * the slot is re-checked at write time rather than trusted from the request.
 */

import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db/client";
import { organizations, services } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { isValidZone } from "@/domain/time/zone";
import { AppError } from "@/lib/errors";
import { clientIp, json, problem, readJson } from "@/lib/http";
import { book } from "@/server/booking/service";
import {
  MemoryRateLimiter,
  POLICIES,
  PostgresRateLimiter,
  type RateLimiter,
} from "@/server/rate-limit";
import { env } from "@/env";

const bodySchema = z.object({
  org: z.string().trim().min(1).max(60),
  service: z.string().trim().min(1).max(60),
  /** ISO 8601. The instant the customer picked, as the page showed it. */
  startsAt: z.string().datetime(),
  staffId: z.uuid().optional(),
  customer: z.object({
    name: z.string().trim().min(1).max(120),
    email: z.email(),
    phone: z.string().trim().min(5).max(32).optional(),
  }),
  /** The zone the slot list was rendered in, so the confirmation matches it. */
  timeZone: z.string().refine(isValidZone, "not a known time zone").optional(),
  notes: z.string().trim().max(1000).optional(),
  /** Supplied by the form, so a double-clicked submit books once. */
  idempotencyKey: z.string().trim().min(8).max(100).optional(),
});

/**
 * The limiter the deployment is configured for.
 *
 * Postgres by default, because the booking form has to hold across instances:
 * an in-memory bucket per instance means the real limit is the configured one
 * multiplied by however many instances happen to be running.
 */
function limiter(db: ReturnType<typeof getDb>): RateLimiter {
  return env().RATE_LIMIT_BACKEND === "memory"
    ? new MemoryRateLimiter()
    : new PostgresRateLimiter(db);
}

export async function POST(request: Request): Promise<Response> {
  try {
    const db = getDb();
    const ip = clientIp(request);

    // Rate limited by address before anything is read from the database. A
    // public booking form is a free write endpoint, which is exactly what
    // gets abused.
    const limit = await limiter(db).consume(
      `public-booking:${ip ?? "unknown"}`,
      POLICIES.publicBooking,
    );
    if (!limit.allowed) {
      throw new AppError(
        "rate_limited",
        "too many booking attempts; try again shortly",
        {
          retryAfterMs: limit.retryAfterMs,
        },
      );
    }

    const body = bodySchema.parse(await readJson(request));

    // Resolved on the privileged connection, because no org is known yet --
    // the same pattern as an invitation or an API key.
    const [org] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.slug, body.org));
    if (!org) throw new AppError("not_found", "no such business");

    const result = await withTenant(db, { orgId: org.id }, async (tx) => {
      const [service] = await tx
        .select({ id: services.id })
        .from(services)
        .where(eq(services.slug, body.service));
      if (!service) throw new AppError("not_found", "no such service");

      return book(
        tx,
        { kind: "public" },
        {
          orgId: org.id,
          serviceId: service.id,
          startsAt: Date.parse(body.startsAt),
          ...(body.staffId ? { staffId: body.staffId } : {}),
          customer: {
            name: body.customer.name,
            email: body.customer.email,
            ...(body.customer.phone ? { phone: body.customer.phone } : {}),
            ...(body.timeZone ? { timeZone: body.timeZone } : {}),
          },
          ...(body.timeZone ? { customerTimeZone: body.timeZone } : {}),
          ...(body.notes ? { notes: body.notes } : {}),
          ...(body.idempotencyKey
            ? { idempotencyKey: body.idempotencyKey }
            : {}),
        },
      );
    });

    // The manage token is returned because it is the customer's only way back
    // to their booking; nothing else about the appointment is exposed.
    return json(
      {
        id: result.appointment.id,
        startsAt: result.appointment.startsAt.toISOString(),
        endsAt: result.appointment.endsAt.toISOString(),
        status: result.appointment.status,
        paymentStatus: result.appointment.paymentStatus,
        depositMinor: result.appointment.depositMinor,
        currency: result.appointment.currency,
        manageToken: result.appointment.manageToken,
      },
      result.deduplicated ? 200 : 201,
    );
  } catch (err) {
    return problem(err);
  }
}
