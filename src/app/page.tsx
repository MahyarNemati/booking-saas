import Link from "next/link";

export default function HomePage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-24">
      <h1 className="text-4xl font-semibold tracking-tight">Booking</h1>
      <p className="mt-4 text-lg text-zinc-600 dark:text-zinc-400">
        Appointment booking for local businesses. Opening hours as rules in
        their own time zone, double booking refused by the database rather than
        by a check-then-insert, deposits confirmed by webhook, and reminders
        that survive a restart.
      </p>

      <h2 className="mt-12 text-sm font-medium tracking-wide text-zinc-500 uppercase dark:text-zinc-400">
        Try it
      </h2>
      <p className="mt-3 text-zinc-700 dark:text-zinc-300">
        Seed a business and open its booking page:
      </p>
      <pre className="mt-3 overflow-x-auto rounded-lg border border-zinc-200 p-4 text-sm dark:border-zinc-800">
        npm run seed
      </pre>
      <p className="mt-3">
        <Link href="/b/snips" className="underline">
          /b/snips
        </Link>{" "}
        <span className="text-zinc-500 dark:text-zinc-400">
          — the seeded example
        </span>
      </p>
    </main>
  );
}
