import { describe, expect, it } from "vitest";
import { AppError } from "@/lib/errors";
import {
  assertFeature,
  assertWithinLimit,
  entitlementsFor,
  planForPrice,
} from "./plans";

describe("entitlements", () => {
  it("falls back to free without a subscription", () => {
    const ent = entitlementsFor(null);
    expect(ent.plan).toBe("free");
    expect(ent.maxSeats).toBe(3);
  });

  it("grants paid features for active, trialing and past_due subscriptions", () => {
    for (const status of ["active", "trialing", "past_due"]) {
      expect(entitlementsFor({ plan: "pro", status, seats: 5 }).plan).toBe(
        "pro",
      );
    }
  });

  it("drops to free when the subscription is canceled or unpaid", () => {
    for (const status of [
      "canceled",
      "unpaid",
      "incomplete_expired",
      "incomplete",
    ]) {
      expect(
        entitlementsFor({ plan: "enterprise", status, seats: 5 }).plan,
      ).toBe("free");
    }
  });

  it("gates features by plan with a payment_required error", () => {
    expect(() => assertFeature(entitlementsFor(null), "api_keys")).toThrow(
      AppError,
    );
    try {
      assertFeature(entitlementsFor(null), "audit_log");
    } catch (err) {
      expect((err as AppError).status).toBe(402);
    }
    expect(() =>
      assertFeature(
        entitlementsFor({ plan: "pro", status: "active", seats: 1 }),
        "api_keys",
      ),
    ).not.toThrow();
    expect(() =>
      assertFeature(
        entitlementsFor({ plan: "pro", status: "active", seats: 1 }),
        "sso",
      ),
    ).toThrow(/sso/);
  });

  it("enforces numeric limits and treats null as unlimited", () => {
    expect(() => assertWithinLimit(3, 2, "seat")).not.toThrow();
    expect(() => assertWithinLimit(3, 3, "seat")).toThrow(/seat limit of 3/);
    expect(() => assertWithinLimit(null, 10_000, "seat")).not.toThrow();
  });

  it("maps price ids to plans", () => {
    const catalog = { pro: "price_pro", enterprise: "price_ent" };
    expect(planForPrice(catalog, "price_pro")).toBe("pro");
    expect(planForPrice(catalog, "price_ent")).toBe("enterprise");
    expect(planForPrice(catalog, "price_other")).toBeNull();
    expect(planForPrice({}, "price_pro")).toBeNull();
  });
});
