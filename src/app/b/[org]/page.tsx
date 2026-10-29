/**
 * A business's public booking page: pick a service.
 *
 * A server component, so the services are read on the server and there is no
 * loading state for data the page cannot render without.
 */

import { and, asc, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { organizations, services } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { formatMoney } from "@/lib/money";

export const dynamic = "force-dynamic";

async function loadBusiness(slug: string) {
  const db = getDb();
  // Resolved on the privileged connection: no org is known until the slug is.
  const [org] = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      timeZone: organizations.timeZone,
    })
    .from(organizations)
    .where(eq(organizations.slug, slug));
  if (!org) return null;

  const rows = await withTenant(db, { orgId: org.id }, (tx) =>
    tx
      .select()
      .from(services)
      .where(and(eq(services.orgId, org.id), eq(services.active, true)))
      .orderBy(asc(services.name)),
  );
  return { org, services: rows };
}

export default async function BusinessPage({
  params,
}: {
  params: Promise<{ org: string }>;
}) {
  const { org: slug } = await params;
  const data = await loadBusiness(slug);
  if (!data) notFound();

  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">{data.org.name}</h1>
      <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
        All times are shown in {data.org.timeZone}.
      </p>

      {data.services.length === 0 ? (
        <p className="mt-10 rounded-lg border border-zinc-200 p-6 text-zinc-600 dark:border-zinc-800 dark:text-zinc-400">
          This business is not taking bookings online at the moment.
        </p>
      ) : (
        <ul className="mt-10 space-y-3">
          {data.services.map((service) => (
            <li key={service.id}>
              <Link
                href={`/b/${slug}/${service.slug}`}
                className="block rounded-lg border border-zinc-200 p-5 transition hover:border-zinc-400 dark:border-zinc-800 dark:hover:border-zinc-600"
              >
                <div className="flex items-baseline justify-between gap-4">
                  <span className="font-medium">{service.name}</span>
                  <span className="shrink-0 text-sm text-zinc-500 dark:text-zinc-400">
                    {service.durationMinutes} min
                    {service.priceMinor > 0 &&
                      ` · ${formatMoney(service.priceMinor, service.currency)}`}
                  </span>
                </div>
                {service.description && (
                  <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
                    {service.description}
                  </p>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
