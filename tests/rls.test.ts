import { eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import {
  apiKeys,
  auditLogs,
  memberships,
  organizations,
  services,
  users,
} from "@/db/schema";
import { withTenant, withUser } from "@/db/tenant";
import { createOrganization } from "@/server/orgs";
import { createUser, hasDatabase, pgError, testDb } from "./db";

describe.skipIf(!hasDatabase)("row-level security", () => {
  const db = hasDatabase ? testDb() : (undefined as never);
  let alice: { id: string; email: string };
  let bob: { id: string; email: string };
  let orgA: string;
  let orgB: string;
  let serviceB: string;

  beforeAll(async () => {
    alice = await createUser(db, "alice");
    bob = await createUser(db, "bob");
    orgA = (await createOrganization(db, { userId: alice.id, name: "Acme" }))
      .id;
    orgB = (await createOrganization(db, { userId: bob.id, name: "Globex" }))
      .id;
    await withTenant(db, { orgId: orgA }, (tx) =>
      tx.insert(services).values({
        orgId: orgA,
        name: "alpha",
        slug: "alpha",
        durationMinutes: 30,
      }),
    );
    const [p] = await withTenant(db, { orgId: orgB }, (tx) =>
      tx
        .insert(services)
        .values({
          orgId: orgB,
          name: "beta",
          slug: "beta",
          durationMinutes: 30,
        })
        .returning(),
    );
    serviceB = p!.id;
  });

  it("filters reads to the current org even without a where clause", async () => {
    const rows = await withTenant(db, { orgId: orgA }, (tx) =>
      tx.select().from(services),
    );
    expect(rows.map((r) => r.name)).toEqual(["alpha"]);
    const orgs = await withTenant(db, { orgId: orgA }, (tx) =>
      tx.select().from(organizations),
    );
    expect(orgs.map((o) => o.id)).toEqual([orgA]);
  });

  it("returns nothing when querying another org's rows by id", async () => {
    const rows = await withTenant(db, { orgId: orgA }, (tx) =>
      tx.select().from(services).where(eq(services.id, serviceB)),
    );
    expect(rows).toHaveLength(0);
  });

  it("rejects inserts that target another org", async () => {
    expect(
      (
        await pgError(
          withTenant(db, { orgId: orgA }, (tx) =>
            tx.insert(services).values({
              orgId: orgB,
              name: "smuggled",
              slug: "smuggled",
              durationMinutes: 30,
            }),
          ),
        )
      ).message,
    ).toMatch(/row-level security/);
  });

  it("cannot update or delete another org's rows", async () => {
    const updated = await withTenant(db, { orgId: orgA }, (tx) =>
      tx
        .update(services)
        .set({ name: "pwned" })
        .where(eq(services.id, serviceB))
        .returning(),
    );
    expect(updated).toHaveLength(0);
    const deleted = await withTenant(db, { orgId: orgA }, (tx) =>
      tx.delete(services).where(eq(services.id, serviceB)).returning(),
    );
    expect(deleted).toHaveLength(0);
    const [still] = await db
      .select()
      .from(services)
      .where(eq(services.id, serviceB));
    expect(still?.name).toBe("beta");
  });

  it("cannot move a row into another org", async () => {
    expect(
      (
        await pgError(
          withTenant(db, { orgId: orgA }, (tx) =>
            tx.update(services).set({ orgId: orgB }),
          ),
        )
      ).message,
    ).toMatch(/row-level security/);
  });

  it("sees nothing when no org is selected", async () => {
    const rows = await db.transaction(async (tx) => {
      await tx.execute(sql`set local role app_tenant`);
      return tx.select().from(services);
    });
    expect(rows).toHaveLength(0);
  });

  it("keeps audit logs append-only for tenants", async () => {
    expect(
      (
        await pgError(
          withTenant(db, { orgId: orgA }, (tx) =>
            tx.update(auditLogs).set({ action: "tampered" }),
          ),
        )
      ).message,
    ).toMatch(/permission denied/);
    expect(
      (
        await pgError(
          withTenant(db, { orgId: orgA }, (tx) => tx.delete(auditLogs)),
        )
      ).message,
    ).toMatch(/permission denied/);
  });

  it("hides other orgs' api keys and members", async () => {
    await db.insert(apiKeys).values({
      orgId: orgB,
      name: "ci",
      prefix: `${Date.now().toString(16).slice(-12).padStart(12, "0")}`,
      keyHash: "00",
      scopes: ["bookings:read"],
    });
    const keys = await withTenant(db, { orgId: orgA }, (tx) =>
      tx.select().from(apiKeys),
    );
    expect(keys).toHaveLength(0);
    const members = await withTenant(db, { orgId: orgA }, (tx) =>
      tx.select().from(memberships),
    );
    expect(members.map((m) => m.userId)).toEqual([alice.id]);
  });

  it("only exposes users who share the current org", async () => {
    const visible = await withTenant(
      db,
      { orgId: orgA, userId: alice.id },
      (tx) => tx.select().from(users),
    );
    expect(visible.map((u) => u.id)).toEqual([alice.id]);
  });

  it("lists only the user's own memberships when no org is selected", async () => {
    const orgs = await withUser(db, alice.id, (tx) =>
      tx.select().from(organizations),
    );
    expect(orgs.map((o) => o.id)).toEqual([orgA]);
  });

  it("does not leak tenant settings to the next transaction on the same connection", async () => {
    await withTenant(db, { orgId: orgA }, async () => undefined);
    const [row] = await db.execute<{ org: string | null; role: string }>(
      sql`select nullif(current_setting('app.current_org', true), '') as org, current_user as role`,
    );
    expect(row?.org).toBeNull();
    expect(row?.role).not.toBe("app_tenant");
  });

  it("rejects malformed org ids before touching the database", async () => {
    await expect(
      withTenant(db, { orgId: "' or 1=1 --" }, async () => undefined),
    ).rejects.toThrow();
  });
});
