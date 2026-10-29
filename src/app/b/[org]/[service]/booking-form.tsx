"use client";

/**
 * The booking form for one slot.
 *
 * A client component because it is a form, and the only one on the page:
 * everything else is rendered on the server. React Hook Form with a Zod
 * resolver, so the same shape validates here and in the route handler and
 * there is one definition of what a valid booking looks like.
 */

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

const formSchema = z.object({
  name: z.string().trim().min(1, "we need a name for the booking").max(120),
  email: z.email("that does not look like an email address"),
  // Optional, but if given it has to be plausible: a reminder to a number
  // that cannot receive one is worse than no reminder.
  phone: z
    .string()
    .trim()
    .regex(
      /^\+?[0-9 ()-]{7,20}$/,
      "use digits, spaces and an optional leading +",
    )
    .optional()
    .or(z.literal("")),
  notes: z.string().trim().max(1000).optional(),
});

type FormValues = z.infer<typeof formSchema>;

export interface BookingFormProps {
  orgSlug: string;
  serviceSlug: string;
  /** ISO 8601, exactly as the server rendered it. */
  startsAt: string;
  label: string;
  staff: { id: string; name: string }[];
  requiresPayment: boolean;
  depositLabel: string | null;
}

export function BookingForm(props: BookingFormProps) {
  const [open, setOpen] = useState(false);
  const [staffId, setStaffId] = useState(props.staff[0]?.id ?? "");
  const [failure, setFailure] = useState<string | null>(null);
  // One random key per mounted form: stable across re-renders and retries, so
  // a double-clicked submit books once, and different between page loads, so
  // two customers never share one.
  //
  // Not useId(). That is stable per position in the tree, which means the
  // same slot rendered on two different days produces the same key -- and the
  // second customer is handed the first customer's booking, cancelled or not.
  // An idempotency key has to be unique to the request, not to the component.
  const [idempotencyKey] = useState(randomKey);
  const router = useRouter();

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(formSchema) });

  const onSubmit = async (values: FormValues) => {
    setFailure(null);
    const response = await fetch("/api/public/bookings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        org: props.orgSlug,
        service: props.serviceSlug,
        startsAt: props.startsAt,
        ...(staffId ? { staffId } : {}),
        customer: {
          name: values.name,
          email: values.email,
          ...(values.phone ? { phone: values.phone } : {}),
        },
        // The browser's own zone, so the confirmation and the reminders are
        // in the times the customer actually lives in.
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        ...(values.notes ? { notes: values.notes } : {}),
        idempotencyKey,
      }),
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      // The server's message is shown because it is written for a customer --
      // "that time has just been taken" rather than a status code.
      setFailure(body?.error?.message ?? "the booking could not be made");
      return;
    }

    const booking = (await response.json()) as { manageToken: string };
    router.push(`/b/${props.orgSlug}/booked/${booking.manageToken}`);
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded border border-zinc-300 px-3 py-1.5 text-sm tabular-nums transition hover:border-zinc-500 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:border-zinc-500 dark:hover:bg-zinc-800"
      >
        {props.label}
      </button>
    );
  }

  return (
    <form
      onSubmit={handleSubmit(onSubmit)}
      // noValidate so this form's own validation is the one the customer
      // sees. The browser's native messages cannot be styled, are worded
      // differently in every browser, and appear as a transient tooltip that
      // a screen reader does not announce -- and because they block submit
      // first, the accessible messages below would never render at all.
      noValidate
      className="w-72 rounded-lg border border-zinc-400 p-4 text-sm dark:border-zinc-600"
    >
      <div className="flex items-baseline justify-between">
        <strong className="tabular-nums">{props.label}</strong>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-zinc-500 hover:underline dark:text-zinc-400"
        >
          cancel
        </button>
      </div>

      {props.staff.length > 1 && (
        <label className="mt-3 block">
          <span className="text-zinc-600 dark:text-zinc-400">With</span>
          <select
            value={staffId}
            onChange={(e) => setStaffId(e.target.value)}
            className="mt-1 w-full rounded border border-zinc-300 bg-transparent px-2 py-1.5 dark:border-zinc-700"
          >
            {props.staff.map((person) => (
              <option key={person.id} value={person.id}>
                {person.name}
              </option>
            ))}
          </select>
        </label>
      )}

      <Field label="Name" error={errors.name?.message}>
        <input
          {...register("name")}
          autoComplete="name"
          className="mt-1 w-full rounded border border-zinc-300 bg-transparent px-2 py-1.5 dark:border-zinc-700"
        />
      </Field>

      <Field label="Email" error={errors.email?.message}>
        <input
          {...register("email")}
          type="email"
          autoComplete="email"
          className="mt-1 w-full rounded border border-zinc-300 bg-transparent px-2 py-1.5 dark:border-zinc-700"
        />
      </Field>

      <Field label="Phone (for reminders)" error={errors.phone?.message}>
        <input
          {...register("phone")}
          type="tel"
          autoComplete="tel"
          className="mt-1 w-full rounded border border-zinc-300 bg-transparent px-2 py-1.5 dark:border-zinc-700"
        />
      </Field>

      {props.requiresPayment && props.depositLabel && (
        <p className="mt-3 text-zinc-600 dark:text-zinc-400">
          A {props.depositLabel} deposit is taken to hold this time.
        </p>
      )}

      {failure && (
        <p
          role="alert"
          className="mt-3 rounded bg-red-50 p-2 text-red-700 dark:bg-red-950 dark:text-red-300"
        >
          {failure}
        </p>
      )}

      <button
        type="submit"
        disabled={isSubmitting}
        className="mt-4 w-full rounded bg-zinc-900 px-3 py-2 font-medium text-white transition disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900"
      >
        {isSubmitting ? "Booking…" : "Confirm"}
      </button>
    </form>
  );
}

/**
 * A random key for one booking attempt.
 *
 * `crypto.randomUUID` is only defined in a secure context, so it is missing
 * when the app is served over plain HTTP from anything other than localhost --
 * a staging box on a LAN, say. `crypto.getRandomValues` carries no such
 * restriction, so it is the fallback rather than `Math.random`, which would
 * make collisions plausible across many tabs.
 */
function randomKey(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="mt-3 block">
      <span className="text-zinc-600 dark:text-zinc-400">{label}</span>
      {children}
      {error && (
        <span
          role="alert"
          className="mt-1 block text-red-600 dark:text-red-400"
        >
          {error}
        </span>
      )}
    </label>
  );
}
