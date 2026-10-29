export type ErrorCode =
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "invalid"
  | "payment_required"
  | "rate_limited";

const STATUS: Record<ErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  invalid: 422,
  payment_required: 402,
  rate_limited: 429,
};

export class AppError extends Error {
  readonly status: number;

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AppError";
    this.status = STATUS[code];
  }
}

export const isAppError = (e: unknown): e is AppError => e instanceof AppError;
