"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Cancelling, with a confirmation step.
 *
 * Two clicks on purpose: cancelling is irreversible from the customer's side —
 * the slot goes back on sale and may be gone a second later — so a stray tap
 * must not do it.
 */
export function CancelButton({ token }: { token: string }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const router = useRouter();

  const cancel = async () => {
    setBusy(true);
    setFailure(null);
    const response = await fetch(`/api/public/bookings/${token}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    setBusy(false);
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      setFailure(body?.error?.message ?? "the booking could not be cancelled");
      return;
    }
    // Re-rendered from the server rather than patched here, so the page shows
    // the booking's real state including whether a refund is expected.
    router.refresh();
  };

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="text-sm text-red-700 hover:underline dark:text-red-400"
      >
        Cancel this booking
      </button>
    );
  }

  return (
    <div className="rounded-lg border border-red-300 p-4 text-sm dark:border-red-900">
      <p>Cancel this booking? The time goes back on sale immediately.</p>
      {failure && (
        <p role="alert" className="mt-2 text-red-700 dark:text-red-400">
          {failure}
        </p>
      )}
      <div className="mt-3 flex gap-3">
        <button
          type="button"
          onClick={cancel}
          disabled={busy}
          className="rounded bg-red-700 px-3 py-1.5 font-medium text-white disabled:opacity-60"
        >
          {busy ? "Cancelling…" : "Yes, cancel it"}
        </button>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          className="rounded border border-zinc-300 px-3 py-1.5 dark:border-zinc-700"
        >
          Keep it
        </button>
      </div>
    </div>
  );
}
