/**
 * Cancelling from the link in a confirmation email.
 *
 * The token in the path is the credential. It identifies the booking *and*
 * authorises the change, which is why it is 32 random bytes rather than the
 * appointment id, and why it is compared in constant time inside the service.
 */

import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db/client";
import { appointments } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { AppError } from "@/lib/errors";
import { clientIp, json, problem, readJson } from "@/lib/http";
import { cancel } from "@/server/booking/service";

const bodySchema = z
  .object({ reason: z.string().trim().max(500).optional() })
  .default({});

export async function POST(
  request: Request,
  context: { params: Promise<{ token: string }> },
): Promise<Response> {
  try {
    const { token } = await context.params;
    const db = getDb();

    // The lookup is by token on the privileged connection, because the
    // customer has no session and no organization is known yet. Only the
    // org id is taken from it; the cancellation itself runs inside the tenant
    // transaction, and the service compares the token again in constant time.
    const [found] = await db
      .select({ id: appointments.id, orgId: appointments.orgId })
      .from(appointments)
      .where(eq(appointments.manageToken, token));
    if (!found) throw new AppError("not_found", "that link is not valid");

    const body = bodySchema.parse(await readJson(request).catch(() => ({})));

    const result = await withTenant(db, { orgId: found.orgId }, (tx) =>
      cancel(
        tx,
        { kind: "public", manageToken: token },
        {
          orgId: found.orgId,
          appointmentId: found.id,
          ...(body.reason ? { reason: body.reason } : {}),
        },
        { ip: clientIp(request), userAgent: request.headers.get("user-agent") },
      ),
    );

    // Whether a refund is due is reported, not promised: moving the money is
    // the payments module's job and may still fail.
    return json({
      status: result.appointment.status,
      refundExpected: result.refundable,
      refundMinor: result.refundMinor,
      currency: result.appointment.currency,
    });
  } catch (err) {
    return problem(err);
  }
}
