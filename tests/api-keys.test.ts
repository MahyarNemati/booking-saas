import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { apiKeys, subscriptions } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import {
  authenticateApiKey,
  createApiKey,
  listApiKeys,
  parseKey,
  revokeApiKey,
} from "@/server/api-keys";
import { createOrganization } from "@/server/orgs";
import type { Actor } from "@/server/rbac";
import { createUser, hasDatabase, testDb } from "./db";

describe("api key format", () => {
  it("parses well-formed keys and rejects anything else", () => {
    const key = `sk_0123456789ab_${"A".repeat(43)}`;
    expect(parseKey(key)).toEqual({ prefix: "0123456789ab" });
    expect(parseKey("sk_short_x")).toBeNull();
    expect(parseKey(`pk_0123456789ab_${"A".repeat(43)}`)).toBeNull();
  });
});

describe.skipIf(!hasDatabase)("api keys", () => {
  const db = hasDatabase ? testDb() : (undefined as never);
  let orgId: string;
  let actor: Actor;

  async function upgrade() {
    await withTenant(db, { orgId }, (tx) =>
      tx.insert(subscriptions).values({
        orgId,
        stripeSubscriptionId: `sub_${orgId}`,
        stripePriceId: "price_pro",
        plan: "pro",
        status: "active",
        lastEventAt: new Date(),
      }),
    );
  }

  beforeEach(async () => {
    const user = await createUser(db, "dev");
    orgId = (await createOrganization(db, { userId: user.id, name: "Keys" })).id;
    actor = { kind: "user", userId: user.id, role: "owner" };
  });

  const create = (
    scopes: ("projects:read" | "projects:write")[] = ["projects:read"],
    expiresInDays?: number,
  ) =>
    withTenant(db, { orgId }, (tx) =>
      createApiKey(tx, actor, { orgId, name: "ci", scopes, expiresInDays }),
    );

  it("requires a plan with the api_keys feature", async () => {
    await expect(create()).rejects.toMatchObject({ code: "payment_required" });
  });

  it("stores only a hash and authenticates the plaintext key", async () => {
    await upgrade();
    const { key, record } = await create(["projects:read"]);
    const [stored] = await db.select().from(apiKeys).where(eq(apiKeys.id, record.id));
    expect(stored?.keyHash).not.toContain(key);
    expect(JSON.stringify(record)).not.toContain(key);
    expect("keyHash" in record).toBe(false);

    const resolved = await authenticateApiKey(db, key);
    expect(resolved).toMatchObject({
      orgId,
      actor: { kind: "api_key", keyId: record.id, scopes: ["projects:read"] },
    });
    const [touched] = await db.select().from(apiKeys).where(eq(apiKeys.id, record.id));
    expect(touched?.lastUsedAt).toBeInstanceOf(Date);
  });

  it("rejects a key whose secret was altered", async () => {
    await upgrade();
    const { key } = await create();
    const last = key.at(-1) === "A" ? "B" : "A";
    await expect(authenticateApiKey(db, key.slice(0, -1) + last)).rejects.toMatchObject({
      code: "unauthenticated",
    });
  });

  it("rejects revoked keys", async () => {
    await upgrade();
    const { key, record } = await create();
    await withTenant(db, { orgId }, (tx) => revokeApiKey(tx, actor, { orgId, keyId: record.id }));
    await expect(authenticateApiKey(db, key)).rejects.toThrow(/revoked/);
    const listed = await withTenant(db, { orgId }, (tx) => listApiKeys(tx, actor));
    expect(listed[0]?.revokedAt).toBeInstanceOf(Date);
  });

  it("rejects expired keys", async () => {
    await upgrade();
    const { key, record } = await create(["projects:read"], 1);
    await db
      .update(apiKeys)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(apiKeys.id, record.id));
    await expect(authenticateApiKey(db, key)).rejects.toThrow(/expired/);
  });

  it("does not let members manage keys", async () => {
    await upgrade();
    const member: Actor = {
      kind: "user",
      userId: (actor as { userId: string }).userId,
      role: "member",
    };
    await expect(
      withTenant(db, { orgId }, (tx) =>
        createApiKey(tx, member, { orgId, name: "x", scopes: ["projects:read"] }),
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});
