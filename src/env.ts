import { z } from "zod";

const optional = z
  .string()
  .trim()
  .transform((v) => (v === "" ? undefined : v))
  .optional();

const schema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    APP_URL: z.url().default("http://localhost:3000"),
    DATABASE_URL: z.url(),
    DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
    AUTH_SECRET: z
      .string()
      .min(32, "AUTH_SECRET must be at least 32 characters"),
    AUTH_GITHUB_ID: optional,
    AUTH_GITHUB_SECRET: optional,
    AUTH_RESEND_KEY: optional,
    EMAIL_FROM: z.string().default("Booking <no-reply@localhost>"),
    DEV_MAIL_OUTBOX: optional,
    STRIPE_SECRET_KEY: optional,
    STRIPE_WEBHOOK_SECRET: optional,
    STRIPE_PRICE_PRO: optional,
    STRIPE_PRICE_ENTERPRISE: optional,
    RATE_LIMIT_BACKEND: z.enum(["memory", "postgres"]).default("postgres"),
    // Reminders. Without these the worker logs the messages instead of
    // sending them, which is what a developer wants and what CI needs.
    TWILIO_ACCOUNT_SID: optional,
    TWILIO_AUTH_TOKEN: optional,
    TWILIO_FROM: optional,
    // How long a booking awaiting payment keeps its slot. Generous on
    // purpose: a customer fetching a card from another room is normal, and
    // giving their slot away after ninety seconds is worse than holding it.
    BOOKING_HOLD_MINUTES: z.coerce
      .number()
      .int()
      .positive()
      .max(1440)
      .default(30),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace"])
      .default("info"),
  })
  .superRefine((env, ctx) => {
    // No sign-in provider is required. That rule is inherited from the
    // starter, where every surface was behind a session. Here the
    // customer-facing booking flow has no account at all and the only
    // authenticated surface is the API-key endpoint, so demanding an OAuth
    // app before a booking page will render is a requirement this product
    // does not have.
    //
    // What it does require in production is a rate limiter that holds across
    // instances. The public booking form is a free, unauthenticated write
    // endpoint, and an in-memory bucket is per instance -- so the real limit
    // becomes the configured one multiplied by however many are running.
    if (env.NODE_ENV === "production" && env.RATE_LIMIT_BACKEND === "memory") {
      ctx.addIssue({
        code: "custom",
        path: ["RATE_LIMIT_BACKEND"],
        message:
          "use the postgres backend in production: an in-memory limit is per " +
          "instance, so it does not bound a public endpoint",
      });
    }
    if (Boolean(env.AUTH_GITHUB_ID) !== Boolean(env.AUTH_GITHUB_SECRET)) {
      ctx.addIssue({
        code: "custom",
        message: "AUTH_GITHUB_ID and AUTH_GITHUB_SECRET go together",
      });
    }
    if (env.STRIPE_SECRET_KEY && !env.STRIPE_WEBHOOK_SECRET) {
      ctx.addIssue({
        code: "custom",
        message: "STRIPE_WEBHOOK_SECRET is required with Stripe",
      });
    }
  });

export type Env = z.infer<typeof schema>;

export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = schema.safeParse(source);
  if (!result.success) {
    const details = result.error.issues
      .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  return result.data;
}

let cached: Env | undefined;

/** Parsed lazily so `next build` does not require runtime secrets. */
export function env(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}
