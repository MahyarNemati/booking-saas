/**
 * The diary, for an integration.
 *
 * Authenticated with an API key rather than a session, which is what makes it
 * useful: the thing a business actually wants is their bookings in whatever
 * calendar or spreadsheet they already use.
 */

import { z } from "zod";
import { getDb } from "@/db/client";
import { withTenant } from "@/db/tenant";
import { AppError } from "@/lib/errors";
import { json, problem } from "@/lib/http";
import { authenticateApiKey } from "@/server/api-keys";
import { listAppointments } from "@/server/booking/service";
import { POLICIES, PostgresRateLimiter } from "@/server/rate-limit";

const querySchema = z.object({
  from: z.string().datetime(),
  to: z.string().datetime(),
  staffId: z.uuid().optional(),
});

export async function GET(request: Request): Promise<Response> {
  try {
    const db = getDb();
    const header = request.headers.get("authorization");
    const key = header?.startsWith("Bearer ") ? header.slice(7) : null;
    if (!key) throw new AppError("unauthenticated", "an api key is required");

    const { orgId, actor } = await authenticateApiKey(db, key);

    // Limited per key, not per address: a key is the identity here, and an
    // integration behind one address must not be able to spend another's
    // budget.
    const limit = await new PostgresRateLimiter(db).consume(
      `api:${actor.keyId}`,
      POLICIES.api,
    );
    if (!limit.allowed) {
      throw new AppError("rate_limited", "too many requests", {
        retryAfterMs: limit.retryAfterMs,
      });
    }

    const url = new URL(request.url);
    const query = querySchema.parse({
      from: url.searchParams.get("from"),
      to: url.searchParams.get("to"),
      ...(url.searchParams.get("staffId")
        ? { staffId: url.searchParams.get("staffId") }
        : {}),
    });

    const within = { start: Date.parse(query.from), end: Date.parse(query.to) };
    if (within.end <= within.start) {
      throw new AppError("invalid", "`to` must be after `from`");
    }
    // A bounded window, so one request cannot ask for every booking ever
    // made and the index is always usable.
    if (within.end - within.start > 92 * 24 * 60 * 60 * 1000) {
      throw new AppError("invalid", "ask for at most 92 days at a time");
    }

    const rows = await withTenant(db, { orgId }, (tx) =>
      listAppointments(tx, actor, {
        orgId,
        within,
        ...(query.staffId ? { staffId: query.staffId } : {}),
      }),
    );

    return json({
      appointments: rows.map((r) => ({
        id: r.id,
        startsAt: r.startsAt.toISOString(),
        endsAt: r.endsAt.toISOString(),
        status: r.status,
        paymentStatus: r.paymentStatus,
        service: r.serviceName,
        staff: r.staffName,
        customer: r.customerName,
        notes: r.notes,
      })),
    });
  } catch (err) {
    return problem(err);
  }
}
