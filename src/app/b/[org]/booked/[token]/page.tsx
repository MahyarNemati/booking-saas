/**
 * The confirmation page, reached with the manage token.
 *
 * It *reads* the appointment rather than asserting anything about it. That is
 * the point: a customer arriving here has not necessarily paid, and one who
 * paid and then lost their connection never arrives at all. The status shown
 * is whatever the database says, which the payment webhook is the only thing
 * that changes.
 */

import { eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import {
  appointments,
  customers,
  organizations,
  services,
  staff,
} from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { formatMoney } from "@/lib/money";
import { CancelButton } from "./cancel-button";

export const dynamic = "force-dynamic";

export default async function BookedPage({
  params,
}: {
  params: Promise<{ org: string; token: string }>;
}) {
  const { org: orgSlug, token } = await params;
  const db = getDb();

  // The token is the credential, so the lookup is by token. It is unique and
  // 32 random bytes; the appointment id would be neither.
  const [found] = await db
    .select({ orgId: appointments.orgId, id: appointments.id })
    .from(appointments)
    .where(eq(appointments.manageToken, token));
  if (!found) notFound();

  const row = await withTenant(db, { orgId: found.orgId }, async (tx) => {
    const [result] = await tx
      .select({
        appointment: appointments,
        serviceName: services.name,
        staffName: staff.name,
        customerName: customers.name,
        businessName: organizations.name,
        businessSlug: organizations.slug,
        businessTimeZone: organizations.timeZone,
      })
      .from(appointments)
      .innerJoin(services, eq(services.id, appointments.serviceId))
      .innerJoin(staff, eq(staff.id, appointments.staffId))
      .innerJoin(customers, eq(customers.id, appointments.customerId))
      .innerJoin(organizations, eq(organizations.id, appointments.orgId))
      .where(eq(appointments.id, found.id));
    return result;
  });
  if (!row) notFound();

  const { appointment } = row;
  // The zone the customer saw when they booked, so the page shows the time
  // they chose rather than the business's clock.
  const zone = appointment.customerTimeZone ?? row.businessTimeZone;
  const when = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(appointment.startsAt);

  const cancelled = appointment.status === "cancelled";
  const awaitingPayment = appointment.paymentStatus === "pending";

  return (
    <main className="mx-auto max-w-xl px-6 py-16">
      <h1 className="text-2xl font-semibold tracking-tight">
        {cancelled
          ? "This booking is cancelled"
          : awaitingPayment
            ? "Almost booked"
            : "You are booked in"}
      </h1>

      <dl className="mt-8 space-y-3 text-sm">
        <Row label="What">{row.serviceName}</Row>
        <Row label="When">{when}</Row>
        <Row label="With">{row.staffName}</Row>
        <Row label="Where">{row.businessName}</Row>
        <Row label="Name">{row.customerName}</Row>
        {appointment.priceMinor > 0 && (
          <Row label="Price">
            {formatMoney(appointment.priceMinor, appointment.currency)}
          </Row>
        )}
        {appointment.depositMinor > 0 && (
          <Row label="Deposit">
            {formatMoney(appointment.depositMinor, appointment.currency)}
            {" · "}
            {appointment.paymentStatus}
          </Row>
        )}
      </dl>

      {zone !== row.businessTimeZone && (
        <p className="mt-6 text-sm text-zinc-500 dark:text-zinc-400">
          Shown in {zone}. The business keeps {row.businessTimeZone} time.
        </p>
      )}

      {awaitingPayment && !cancelled && (
        <p className="mt-6 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          This time is held while the deposit is taken. If the payment does not
          complete, the slot is released.
        </p>
      )}

      {!cancelled && (
        <div className="mt-8">
          <CancelButton token={token} />
        </div>
      )}

      <p className="mt-10 text-sm">
        <Link
          href={`/b/${row.businessSlug}`}
          className="text-zinc-500 hover:underline dark:text-zinc-400"
        >
          ← {row.businessName}
        </Link>
      </p>
      {/* The token is in the URL, so this page is the link to keep. */}
      <p className="mt-2 text-xs text-zinc-400 dark:text-zinc-500">
        Keep this page’s link to change or cancel the booking. Slug: {orgSlug}
      </p>
    </main>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex gap-4 border-b border-zinc-200 pb-3 dark:border-zinc-800">
      <dt className="w-24 shrink-0 text-zinc-500 dark:text-zinc-400">
        {label}
      </dt>
      <dd className="font-medium">{children}</dd>
    </div>
  );
}
