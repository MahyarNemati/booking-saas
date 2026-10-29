/**
 * The slot picker.
 *
 * The week is chosen with a query parameter rather than client state, so a
 * link to a particular week works, the back button does what it should, and
 * the slots are rendered on the server from the engine rather than fetched
 * after the page loads.
 */

import { and, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { organizations, services, staff } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { groupByLocalDate } from "@/domain/time/availability";
import {
  addDays,
  dateOf,
  formatDate,
  parseDate,
  startOfDay,
  type PlainDate,
} from "@/domain/time/zone";
import { formatMoney } from "@/lib/money";
import { listSlots } from "@/server/booking/service";
import { BookingForm } from "./booking-form";

export const dynamic = "force-dynamic";

/** A week at a time: enough to choose from, small enough to render. */
const DAYS_SHOWN = 7;

export default async function ServicePage({
  params,
  searchParams,
}: {
  params: Promise<{ org: string; service: string }>;
  searchParams: Promise<{ from?: string }>;
}) {
  const { org: orgSlug, service: serviceSlug } = await params;
  const { from } = await searchParams;
  const db = getDb();

  const [org] = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      timeZone: organizations.timeZone,
    })
    .from(organizations)
    .where(eq(organizations.slug, orgSlug));
  if (!org) notFound();

  const now = Date.now();
  const today = dateOf(now, org.timeZone);
  // A bad or past `from` falls back to today rather than erroring: it comes
  // from a URL, and a stale bookmark should still show something useful.
  let start: PlainDate = today;
  if (from) {
    try {
      const asked = parseDate(from);
      if (formatDate(asked) >= formatDate(today)) start = asked;
    } catch {
      start = today;
    }
  }
  const end = addDays(start, DAYS_SHOWN - 1);

  const result = await withTenant(db, { orgId: org.id }, async (tx) => {
    const [service] = await tx
      .select()
      .from(services)
      .where(and(eq(services.slug, serviceSlug), eq(services.active, true)));
    if (!service) return null;

    const slots = await listSlots(tx, {
      orgId: org.id,
      serviceId: service.id,
      within: {
        start: startOfDay(start, org.timeZone),
        end: startOfDay(addDays(end, 1), org.timeZone),
      },
      now,
    });

    const people = await tx
      .select({ id: staff.id, name: staff.name })
      .from(staff)
      .where(eq(staff.active, true));

    return { service, slots, people };
  });
  if (!result) notFound();

  const { service, slots, people } = result;
  const staffNames = new Map(people.map((p) => [p.id, p.name]));
  const byDate = groupByLocalDate(slots, org.timeZone);
  const dates = Array.from({ length: DAYS_SHOWN }, (_, i) => addDays(start, i));

  const deposit = service.requiresPayment
    ? (service.depositMinor ?? service.priceMinor)
    : 0;

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <nav className="text-sm">
        <Link
          href={`/b/${orgSlug}`}
          className="text-zinc-500 hover:underline dark:text-zinc-400"
        >
          ← {org.name}
        </Link>
      </nav>

      <h1 className="mt-4 text-3xl font-semibold tracking-tight">
        {service.name}
      </h1>
      <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
        {service.durationMinutes} minutes
        {service.priceMinor > 0 &&
          ` · ${formatMoney(service.priceMinor, service.currency)}`}
        {deposit > 0 && ` · ${formatMoney(deposit, service.currency)} deposit`}
        {` · times in ${org.timeZone}`}
      </p>
      {service.description && (
        <p className="mt-4 text-zinc-700 dark:text-zinc-300">
          {service.description}
        </p>
      )}

      <div className="mt-8 flex items-center justify-between text-sm">
        {formatDate(start) > formatDate(today) ? (
          <Link
            href={`?from=${formatDate(addDays(start, -DAYS_SHOWN))}`}
            className="rounded border border-zinc-300 px-3 py-1.5 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            ← Earlier
          </Link>
        ) : (
          <span />
        )}
        <span className="text-zinc-500 dark:text-zinc-400">
          {formatDate(start)} to {formatDate(end)}
        </span>
        <Link
          href={`?from=${formatDate(addDays(start, DAYS_SHOWN))}`}
          className="rounded border border-zinc-300 px-3 py-1.5 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
        >
          Later →
        </Link>
      </div>

      {slots.length === 0 && (
        <p className="mt-8 rounded-lg border border-zinc-200 p-6 text-zinc-600 dark:border-zinc-800 dark:text-zinc-400">
          Nothing available this week. Try a later one.
        </p>
      )}

      <div className="mt-6 space-y-6">
        {dates.map((date) => {
          const key = formatDate(date);
          const group = byDate.find((g) => g.date === key);
          if (!group || group.slots.length === 0) return null;
          return (
            <section key={key}>
              <h2 className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
                {new Intl.DateTimeFormat("en-GB", {
                  timeZone: org.timeZone,
                  weekday: "long",
                  day: "numeric",
                  month: "long",
                }).format(new Date(group.slots[0]!.start))}
              </h2>
              <ul className="mt-2 flex flex-wrap gap-2">
                {group.slots.map((slot) => (
                  <li key={slot.start}>
                    <BookingForm
                      orgSlug={orgSlug}
                      serviceSlug={serviceSlug}
                      startsAt={new Date(slot.start).toISOString()}
                      label={new Intl.DateTimeFormat("en-GB", {
                        timeZone: org.timeZone,
                        hour: "2-digit",
                        minute: "2-digit",
                        hourCycle: "h23",
                      }).format(new Date(slot.start))}
                      staff={slot.resourceIds.map((id) => ({
                        id,
                        name: staffNames.get(id) ?? "Staff",
                      }))}
                      requiresPayment={deposit > 0}
                      depositLabel={
                        deposit > 0
                          ? formatMoney(deposit, service.currency)
                          : null
                      }
                    />
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </main>
  );
}
