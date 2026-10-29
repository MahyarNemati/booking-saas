/**
 * Helpers for route handlers.
 *
 * One place that turns an AppError into a response, so every endpoint reports
 * a failure the same way and no handler invents its own shape. The important
 * part is the last branch: an unexpected error is logged with its detail and
 * answered with a generic message, because a stack trace or a Postgres
 * constraint name in a response body is how internals leak.
 */

import { ZodError } from "zod";
import { isAppError } from "@/lib/errors";
import { logger } from "@/lib/logger";

export interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

export function problem(err: unknown): Response {
  if (isAppError(err)) {
    const body: ErrorBody = {
      error: {
        code: err.code,
        message: err.message,
        ...(err.details ? { details: err.details } : {}),
      },
    };
    return Response.json(body, { status: err.status });
  }

  if (err instanceof ZodError) {
    // Field-level messages are safe and genuinely useful: they are about the
    // request the caller just sent.
    const body: ErrorBody = {
      error: {
        code: "invalid",
        message: "the request body is not valid",
        details: err.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      },
    };
    return Response.json(body, { status: 422 });
  }

  logger.error({ err: String(err) }, "unhandled error in a route handler");
  const body: ErrorBody = {
    error: { code: "internal", message: "something went wrong" },
  };
  return Response.json(body, { status: 500 });
}

/** Parses a JSON body, turning a malformed one into a 422 rather than a 500. */
export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ZodError([
      {
        code: "custom",
        path: [],
        message: "the body is not valid JSON",
      } as never,
    ]);
  }
}

/** The client's address, for rate limiting and the audit log. */
export function clientIp(request: Request): string | null {
  // Only the first entry of X-Forwarded-For is used, and only because this is
  // expected to run behind a proxy that sets it. A header a client controls
  // is not identity; it is a best-effort label for a log.
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() ?? null;
  return request.headers.get("x-real-ip");
}
