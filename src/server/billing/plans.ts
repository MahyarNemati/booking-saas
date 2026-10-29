import type { Plan, Subscription } from "@/db/schema";
import { AppError } from "@/lib/errors";

export type Feature = "api_keys" | "audit_log" | "sso";

export interface Entitlements {
  plan: Plan;
  /** null means unlimited. */
  maxSeats: number | null;
  maxProjects: number | null;
  features: ReadonlySet<Feature>;
}

const PLAN_LIMITS: Record<Plan, Omit<Entitlements, "plan">> = {
  free: { maxSeats: 3, maxProjects: 3, features: new Set() },
  pro: { maxSeats: null, maxProjects: 100, features: new Set(["api_keys", "audit_log"]) },
  enterprise: {
    maxSeats: null,
    maxProjects: null,
    features: new Set(["api_keys", "audit_log", "sso"]),
  },
};

/** Stripe statuses that still grant paid features. past_due keeps access during dunning. */
const ENTITLED_STATUSES = new Set(["active", "trialing", "past_due"]);

export function effectivePlan(sub: Pick<Subscription, "plan" | "status"> | null | undefined): Plan {
  if (!sub || !ENTITLED_STATUSES.has(sub.status)) return "free";
  return sub.plan;
}

export function entitlementsFor(
  sub: Pick<Subscription, "plan" | "status" | "seats"> | null | undefined,
): Entitlements {
  const plan = effectivePlan(sub);
  const limits = PLAN_LIMITS[plan];
  return { plan, ...limits };
}

export function hasFeature(ent: Entitlements, feature: Feature): boolean {
  return ent.features.has(feature);
}

export function assertFeature(ent: Entitlements, feature: Feature): void {
  if (!hasFeature(ent, feature)) {
    throw new AppError("payment_required", `the ${ent.plan} plan does not include ${feature}`, {
      feature,
      plan: ent.plan,
    });
  }
}

export function assertWithinLimit(limit: number | null, used: number, what: string): void {
  if (limit !== null && used >= limit) {
    throw new AppError("payment_required", `${what} limit of ${limit} reached`, { limit, used });
  }
}

export interface PriceCatalog {
  pro?: string;
  enterprise?: string;
}

export function planForPrice(catalog: PriceCatalog, priceId: string): Plan | null {
  if (catalog.pro && priceId === catalog.pro) return "pro";
  if (catalog.enterprise && priceId === catalog.enterprise) return "enterprise";
  return null;
}
