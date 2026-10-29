/**
 * Seeds a business with services, staff and opening hours.
 *
 * Exists so the app can be opened and used within a minute of cloning it. A
 * booking product with no business in it shows nothing at all, which makes
 * the whole thing look broken.
 *
 * Idempotent: running it again updates the same rows rather than making a
 * second salon.
 */

import { and, eq } from "drizzle-orm";
import { createDb } from "./client";
import {
  availabilityRules,
  dateOverrides,
  organizations,
  services,
  staff,
  staffServices,
  users,
} from "./schema";

const ZONE = "Europe/London";

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    process.stderr.write("DATABASE_URL is required\n");
    process.exit(1);
  }
  const { db, sql } = createDb(url, 1);

  try {
    // The owner. A real sign-in is not needed to demonstrate booking, which
    // is a customer-facing flow with no account at all.
    const [owner] = await db
      .insert(users)
      .values({ email: "owner@snips.test", name: "Sam Snips" })
      .onConflictDoUpdate({ target: users.email, set: { name: "Sam Snips" } })
      .returning({ id: users.id });
    if (!owner) throw new Error("could not seed the owner");

    const [org] = await db
      .insert(organizations)
      .values({
        name: "Snips",
        slug: "snips",
        timeZone: ZONE,
        reminderOffsetsMinutes: [24 * 60, 60],
      })
      .onConflictDoUpdate({
        target: organizations.slug,
        set: { timeZone: ZONE, reminderOffsetsMinutes: [24 * 60, 60] },
      })
      .returning({ id: organizations.id });
    if (!org) throw new Error("could not seed the organization");
    const orgId = org.id;

    const servicePlan = [
      {
        name: "Dry Cut",
        slug: "dry-cut",
        description: "A cut, no wash.",
        durationMinutes: 30,
        stepMinutes: 30,
        priceMinor: 2500,
      },
      {
        name: "Cut and Blow Dry",
        slug: "cut-and-blow-dry",
        description: "Wash, cut and finish.",
        durationMinutes: 45,
        stepMinutes: 15,
        bufferAfterMinutes: 10,
        priceMinor: 4500,
      },
      {
        // The one that shows the deposit flow, and the buffers: colour needs
        // the chair prepared and cleaned.
        name: "Full Colour",
        slug: "full-colour",
        description: "Takes the afternoon. A deposit holds the slot.",
        durationMinutes: 120,
        stepMinutes: 30,
        bufferBeforeMinutes: 15,
        bufferAfterMinutes: 20,
        priceMinor: 12000,
        depositMinor: 3000,
        requiresPayment: true,
        cancellationWindowHours: 48,
      },
    ];

    const serviceIds = new Map<string, string>();
    for (const plan of servicePlan) {
      const [row] = await db
        .insert(services)
        .values({
          orgId,
          currency: "GBP",
          minimumNoticeMinutes: 60,
          maximumAdvanceDays: 90,
          ...plan,
        })
        .onConflictDoUpdate({
          target: [services.orgId, services.slug],
          set: { ...plan, active: true },
        })
        .returning({ id: services.id, slug: services.slug });
      if (row) serviceIds.set(row.slug, row.id);
    }

    const staffPlan = [
      { name: "Ana", email: "ana@snips.test", timeZone: ZONE },
      // In a different zone on purpose: it is the case that makes per-staff
      // hours worth having, and the one most likely to be wrong.
      { name: "Ben", email: "ben@snips.test", timeZone: "Europe/Lisbon" },
    ];

    const staffIds = new Map<string, string>();
    for (const plan of staffPlan) {
      const [existing] = await db
        .select({ id: staff.id })
        .from(staff)
        .where(and(eq(staff.orgId, orgId), eq(staff.email, plan.email)));
      if (existing) {
        await db.update(staff).set(plan).where(eq(staff.id, existing.id));
        staffIds.set(plan.name, existing.id);
        continue;
      }
      const [row] = await db
        .insert(staff)
        .values({ orgId, ...plan })
        .returning({ id: staff.id });
      if (row) staffIds.set(plan.name, row.id);
    }

    // Ana does everything; Ben does not do colour. That difference is what
    // makes the staff filter visible on the booking page.
    const ana = staffIds.get("Ana");
    const ben = staffIds.get("Ben");
    if (ana && ben) {
      await db.delete(staffServices).where(eq(staffServices.orgId, orgId));
      await db.insert(staffServices).values([
        ...[...serviceIds.values()].map((serviceId) => ({
          orgId,
          staffId: ana,
          serviceId,
        })),
        ...["dry-cut", "cut-and-blow-dry"]
          .map((slug) => serviceIds.get(slug))
          .filter((id): id is string => Boolean(id))
          .map((serviceId) => ({ orgId, staffId: ben, serviceId })),
      ]);
    }

    await db
      .delete(availabilityRules)
      .where(eq(availabilityRules.orgId, orgId));
    await db.insert(availabilityRules).values([
      // The business: Tuesday to Saturday, 09:00 to 17:30, closed for lunch.
      ...[2, 3, 4, 5, 6].flatMap((weekday) => [
        {
          orgId,
          staffId: null,
          weekday,
          startMinute: 9 * 60,
          endMinute: 13 * 60,
        },
        {
          orgId,
          staffId: null,
          weekday,
          startMinute: 14 * 60,
          endMinute: 17 * 60 + 30,
        },
      ]),
      // Thursday late, which is where the extra evening slots come from.
      {
        orgId,
        staffId: null,
        weekday: 4,
        startMinute: 17 * 60 + 30,
        endMinute: 20 * 60,
      },
      // Ben works mornings only, in his own zone -- so his hours shift
      // relative to the shop's whenever the two zones disagree.
      ...(ben
        ? [2, 3, 4, 5].map((weekday) => ({
            orgId,
            staffId: ben,
            weekday,
            startMinute: 9 * 60,
            endMinute: 13 * 60,
          }))
        : []),
    ]);

    // A closure, to show an override doing its job.
    const christmas = `${new Date().getUTCFullYear()}-12-25`;
    await db
      .insert(dateOverrides)
      .values({
        orgId,
        staffId: null,
        onDate: christmas,
        closed: true,
        reason: "Christmas Day",
      })
      .onConflictDoUpdate({
        target: [
          dateOverrides.orgId,
          dateOverrides.staffId,
          dateOverrides.onDate,
        ],
        set: { closed: true, windows: [], reason: "Christmas Day" },
      });

    process.stdout.write(
      [
        "seeded Snips",
        `  services: ${[...serviceIds.keys()].join(", ")}`,
        `  staff:    ${[...staffIds.keys()].join(", ")}`,
        `  hours:    Tue-Sat 09:00-13:00 and 14:00-17:30 (${ZONE}), Thursday until 20:00`,
        `  closed:   ${christmas}`,
        "",
        "open http://localhost:3000/b/snips",
        "",
      ].join("\n"),
    );
  } finally {
    await sql.end();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`seed failed: ${String(err)}\n`);
  process.exit(1);
});
