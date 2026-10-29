import { z } from "zod";

const optional = z
  .string()
  .trim()
  .transform((v) => (v === "" ? undefined : v))
  .optional();

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    APP_URL: z.url().default("http://localhost:3000"),
    DATABASE_URL: z.url(),
    DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
    AUTH_SECRET: z.string().min(32, "AUTH_SECRET must be at least 32 characters"),
    AUTH_GITHUB_ID: optional,
    AUTH_GITHUB_SECRET: optional,
    AUTH_RESEND_KEY: optional,
    EMAIL_FROM: z.string().default("SaaS Starter <no-reply@localhost>"),
    DEV_MAIL_OUTBOX: optional,
    STRIPE_SECRET_KEY: optional,
    STRIPE_WEBHOOK_SECRET: optional,
    STRIPE_PRICE_PRO: optional,
    STRIPE_PRICE_ENTERPRISE: optional,
    RATE_LIMIT_BACKEND: z.enum(["memory", "postgres"]).default("postgres"),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === "production" && !env.AUTH_RESEND_KEY && !env.AUTH_GITHUB_ID) {
      ctx.addIssue({ code: "custom", message: "configure at least one sign-in provider" });
    }
    if (Boolean(env.AUTH_GITHUB_ID) !== Boolean(env.AUTH_GITHUB_SECRET)) {
      ctx.addIssue({
        code: "custom",
        message: "AUTH_GITHUB_ID and AUTH_GITHUB_SECRET go together",
      });
    }
    if (env.STRIPE_SECRET_KEY && !env.STRIPE_WEBHOOK_SECRET) {
      ctx.addIssue({ code: "custom", message: "STRIPE_WEBHOOK_SECRET is required with Stripe" });
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
