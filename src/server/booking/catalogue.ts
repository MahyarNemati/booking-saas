/**
 * What the business sells and who can deliver it: services, staff, and the
 * assignment between them.
 *
 * All functions here expect to run inside `withTenant()`, so row-level
 * security is already narrowing every query to one organization. The
 * `assertCan` calls are not a second line of defence against a hostile query
 * -- RLS is that -- they decide which *members* of the organization may do
 * which thing, which is a different question the database cannot answer.
 */

import { and, asc, count, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";
import type { Executor } from "@/db/client";
import {
  appointments,
  services,
  staff,
  staffServices,
  type Service,
  type Staff,
} from "@/db/schema";
import { isValidZone } from "@/domain/time/zone";
import { AppError } from "@/lib/errors";
import { recordAudit, type RequestMeta } from "@/server/audit";
import { assertWithinLimit } from "@/server/billing/plans";
import { getEntitlements } from "@/server/billing/service";
import { actorId, assertCan, type Actor } from "@/server/rbac";

/** A slug for a public booking URL: lower case, hyphens, no surprises. */
const slug = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(60)
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    "use lower-case letters, numbers and hyphens",
  );

const timeZone = z.string().refine(isValidZone, "not a known IANA time zone");

export const serviceInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    slug: slug.optional(),
    description: z.string().trim().max(2000).optional(),
    durationMinutes: z
      .number()
      .int()
      .positive()
      .max(24 * 60),
    stepMinutes: z
      .number()
      .int()
      .positive()
      .max(24 * 60)
      .default(15),
    bufferBeforeMinutes: z
      .number()
      .int()
      .min(0)
      .max(8 * 60)
      .default(0),
    bufferAfterMinutes: z
      .number()
      .int()
      .min(0)
      .max(8 * 60)
      .default(0),
    minimumNoticeMinutes: z
      .number()
      .int()
      .min(0)
      .max(365 * 24 * 60)
      .default(60),
    maximumAdvanceDays: z.number().int().min(1).max(730).default(60),
    priceMinor: z.number().int().min(0).default(0),
    // ISO 4217, upper case. The database checks this too; validating here
    // gives a useful message instead of a constraint violation.
    currency: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{3}$/)
      .default("GBP"),
    depositMinor: z.number().int().min(0).optional(),
    requiresPayment: z.boolean().default(false),
    cancellationWindowHours: z
      .number()
      .int()
      .min(0)
      .max(24 * 90)
      .default(24),
    active: z.boolean().default(true),
  })
  .superRefine((input, ctx) => {
    if (
      input.depositMinor !== undefined &&
      input.depositMinor > input.priceMinor
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["depositMinor"],
        message: "a deposit cannot exceed the price",
      });
    }
    if (input.requiresPayment && input.priceMinor === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["requiresPayment"],
        message: "a service that requires payment needs a price",
      });
    }
  });

export type ServiceInput = z.input<typeof serviceInputSchema>;

/** `Hair Cut & Blow Dry` becomes `hair-cut-blow-dry`. */
export function slugify(name: string): string {
  const out = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  // A name of nothing but punctuation would otherwise produce an empty slug
  // and a confusing validation error about a field the user never saw.
  return out || "service";
}

export async function listServices(
  tx: Executor,
  actor: Actor,
  options: { includeInactive?: boolean } = {},
): Promise<Service[]> {
  assertCan(actor, "services:read");
  return tx
    .select()
    .from(services)
    .where(options.includeInactive ? undefined : eq(services.active, true))
    .orderBy(asc(services.name));
}

export async function createService(
  tx: Executor,
  actor: Actor,
  input: { orgId: string } & ServiceInput,
  request?: RequestMeta,
): Promise<Service> {
  assertCan(actor, "services:write");
  const parsed = serviceInputSchema.parse(input);
  const theSlug = parsed.slug ?? slugify(parsed.name);

  const [row] = await tx
    .insert(services)
    .values({
      orgId: input.orgId,
      name: parsed.name,
      slug: theSlug,
      description: parsed.description ?? null,
      durationMinutes: parsed.durationMinutes,
      stepMinutes: parsed.stepMinutes,
      bufferBeforeMinutes: parsed.bufferBeforeMinutes,
      bufferAfterMinutes: parsed.bufferAfterMinutes,
      minimumNoticeMinutes: parsed.minimumNoticeMinutes,
      maximumAdvanceDays: parsed.maximumAdvanceDays,
      priceMinor: parsed.priceMinor,
      currency: parsed.currency,
      depositMinor: parsed.depositMinor ?? null,
      requiresPayment: parsed.requiresPayment,
      cancellationWindowHours: parsed.cancellationWindowHours,
      active: parsed.active,
    })
    // The unique index does the deciding, so two concurrent creates cannot
    // both succeed. Checking first and then inserting would let them.
    .onConflictDoNothing()
    .returning();
  if (!row) {
    throw new AppError(
      "conflict",
      `a service with the slug "${theSlug}" already exists`,
      {
        slug: theSlug,
      },
    );
  }

  await recordAudit(tx, {
    orgId: input.orgId,
    actor,
    action: "service.created",
    target: { type: "service", id: row.id },
    metadata: { name: parsed.name, slug: theSlug, by: actorId(actor) },
    ...(request ? { request } : {}),
  });
  return row;
}

export async function updateService(
  tx: Executor,
  actor: Actor,
  input: { orgId: string; serviceId: string } & Partial<ServiceInput>,
): Promise<Service> {
  assertCan(actor, "services:write");
  const [existing] = await tx
    .select()
    .from(services)
    .where(eq(services.id, input.serviceId));
  if (!existing) throw new AppError("not_found", "no such service");

  // Validated as a whole rather than field by field, so a change that breaks
  // a cross-field rule -- a deposit now larger than a reduced price -- is
  // caught here instead of by a constraint.
  const merged = serviceInputSchema.parse({
    name: input.name ?? existing.name,
    slug: input.slug ?? existing.slug,
    description: input.description ?? existing.description ?? undefined,
    durationMinutes: input.durationMinutes ?? existing.durationMinutes,
    stepMinutes: input.stepMinutes ?? existing.stepMinutes,
    bufferBeforeMinutes:
      input.bufferBeforeMinutes ?? existing.bufferBeforeMinutes,
    bufferAfterMinutes: input.bufferAfterMinutes ?? existing.bufferAfterMinutes,
    minimumNoticeMinutes:
      input.minimumNoticeMinutes ?? existing.minimumNoticeMinutes,
    maximumAdvanceDays: input.maximumAdvanceDays ?? existing.maximumAdvanceDays,
    priceMinor: input.priceMinor ?? existing.priceMinor,
    currency: input.currency ?? existing.currency,
    depositMinor: input.depositMinor ?? existing.depositMinor ?? undefined,
    requiresPayment: input.requiresPayment ?? existing.requiresPayment,
    cancellationWindowHours:
      input.cancellationWindowHours ?? existing.cancellationWindowHours,
    active: input.active ?? existing.active,
  });

  const [row] = await tx
    .update(services)
    .set({
      name: merged.name,
      slug: merged.slug ?? existing.slug,
      description: merged.description ?? null,
      durationMinutes: merged.durationMinutes,
      stepMinutes: merged.stepMinutes,
      bufferBeforeMinutes: merged.bufferBeforeMinutes,
      bufferAfterMinutes: merged.bufferAfterMinutes,
      minimumNoticeMinutes: merged.minimumNoticeMinutes,
      maximumAdvanceDays: merged.maximumAdvanceDays,
      priceMinor: merged.priceMinor,
      currency: merged.currency,
      depositMinor: merged.depositMinor ?? null,
      requiresPayment: merged.requiresPayment,
      cancellationWindowHours: merged.cancellationWindowHours,
      active: merged.active,
    })
    .where(eq(services.id, input.serviceId))
    .returning();
  if (!row) throw new AppError("conflict", "the service was not updated");
  return row;
}

/**
 * Retires a service rather than deleting it.
 *
 * Appointments reference it with ON DELETE RESTRICT, so a delete would fail
 * for any business that has ever used it -- and deleting it anyway would
 * erase what a past appointment was for. Deactivating takes it off the
 * booking page and leaves the history intact.
 */
export async function deactivateService(
  tx: Executor,
  actor: Actor,
  input: { orgId: string; serviceId: string },
): Promise<Service> {
  assertCan(actor, "services:write");
  const [row] = await tx
    .update(services)
    .set({ active: false })
    .where(eq(services.id, input.serviceId))
    .returning();
  if (!row) throw new AppError("not_found", "no such service");
  await recordAudit(tx, {
    orgId: input.orgId,
    actor,
    action: "service.deactivated",
    target: { type: "service", id: row.id },
  });
  return row;
}

export const staffInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.email().optional(),
  phone: z.string().trim().min(5).max(32).optional(),
  userId: z.uuid().optional(),
  timeZone: timeZone.default("UTC"),
  active: z.boolean().default(true),
});

export type StaffInput = z.input<typeof staffInputSchema>;

export async function listStaff(
  tx: Executor,
  actor: Actor,
  options: { includeInactive?: boolean } = {},
): Promise<Staff[]> {
  assertCan(actor, "schedule:read");
  return tx
    .select()
    .from(staff)
    .where(options.includeInactive ? undefined : eq(staff.active, true))
    .orderBy(asc(staff.name));
}

export async function createStaff(
  tx: Executor,
  actor: Actor,
  input: { orgId: string } & StaffInput,
): Promise<Staff> {
  assertCan(actor, "schedule:write");
  const parsed = staffInputSchema.parse(input);

  // Seats are the billable unit, and a member of staff occupies one whether
  // or not they ever sign in -- a room does not, but a room is rare enough
  // that counting it is the honest simplification.
  const ent = await getEntitlements(tx);
  const [used] = await tx
    .select({ n: count() })
    .from(staff)
    .where(eq(staff.active, true));
  assertWithinLimit(ent.maxSeats, used?.n ?? 0, "staff member");

  const [row] = await tx
    .insert(staff)
    .values({
      orgId: input.orgId,
      name: parsed.name,
      email: parsed.email ?? null,
      phone: parsed.phone ?? null,
      userId: parsed.userId ?? null,
      timeZone: parsed.timeZone,
      active: parsed.active,
    })
    .returning();
  if (!row) throw new AppError("conflict", "the staff member was not created");
  await recordAudit(tx, {
    orgId: input.orgId,
    actor,
    action: "staff.created",
    target: { type: "staff", id: row.id },
    metadata: { name: parsed.name },
  });
  return row;
}

/**
 * Sets exactly which services a member of staff offers.
 *
 * Replacing the whole set rather than adding one at a time, because the admin
 * screen is a list of checkboxes and a partial update would make the result
 * depend on what was there before.
 *
 * An empty set means "everything", which is what a one-person business gets
 * without configuring anything.
 */
export async function setStaffServices(
  tx: Executor,
  actor: Actor,
  input: { orgId: string; staffId: string; serviceIds: readonly string[] },
): Promise<void> {
  assertCan(actor, "schedule:write");
  const [member] = await tx
    .select({ id: staff.id })
    .from(staff)
    .where(eq(staff.id, input.staffId));
  if (!member) throw new AppError("not_found", "no such staff member");

  await tx
    .delete(staffServices)
    .where(eq(staffServices.staffId, input.staffId));
  if (input.serviceIds.length === 0) return;

  // The composite foreign key in 0001 refuses a service from another
  // organization, so a bad id here is a constraint violation rather than a
  // cross-tenant assignment.
  await tx.insert(staffServices).values(
    input.serviceIds.map((serviceId) => ({
      orgId: input.orgId,
      staffId: input.staffId,
      serviceId,
    })),
  );
}

/**
 * How many appointments the organization has booked this calendar month.
 *
 * Counted by `created_at`, not by when the appointment falls: the plan limits
 * usage of the product, and a business booking next year's diary in January
 * has done that work in January. Cancelled bookings are excluded, so a
 * mistake does not consume the allowance.
 *
 * `date_trunc('month', now())` is evaluated by Postgres in its own time zone,
 * which is UTC on every deployment of this. For a business in Auckland the
 * month therefore turns over mid-afternoon; stated rather than pretended
 * away, because the alternative is a per-organization month boundary and a
 * much more interesting query.
 */
export async function appointmentsThisMonth(tx: Executor): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(appointments)
    .where(
      and(
        sql`${appointments.createdAt} >= date_trunc('month', now())`,
        ne(appointments.status, "cancelled"),
      ),
    );
  return row?.n ?? 0;
}
