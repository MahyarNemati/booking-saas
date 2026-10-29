import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Database, Executor } from "@/db/client";
import { memberships, organizations, type Organization, type Role } from "@/db/schema";
import { withUser } from "@/db/tenant";
import { randomToken } from "@/lib/crypto";
import { AppError } from "@/lib/errors";
import { recordAudit, type RequestMeta } from "./audit";
import { assertCan, type Actor } from "./rbac";

export const orgNameSchema = z.string().trim().min(2).max(64);

export function slugify(name: string): string {
  const base = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base || "org";
}

const UNIQUE_VIOLATION = "23505";

function isUniqueViolation(err: unknown): boolean {
  const cause = err instanceof Error && "cause" in err ? err.cause : err;
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === UNIQUE_VIOLATION
  );
}

/**
 * Creating an org is the one tenant write that cannot run under RLS: there is
 * no org to scope to yet. It runs on the privileged connection and does
 * nothing except insert the org, its owner membership and the audit entry.
 */
export async function createOrganization(
  db: Database,
  input: { userId: string; name: string; request?: RequestMeta },
): Promise<Organization> {
  const name = orgNameSchema.parse(input.name);
  const base = slugify(name);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const slug =
      attempt === 0
        ? base
        : `${base}-${randomToken(4)
            .toLowerCase()
            .replace(/[^a-z0-9]/g, "")}`;
    try {
      return await db.transaction(async (tx) => {
        const [org] = await tx.insert(organizations).values({ name, slug }).returning();
        if (!org) throw new Error("insert returned no row");
        await tx.insert(memberships).values({ orgId: org.id, userId: input.userId, role: "owner" });
        await recordAudit(tx, {
          orgId: org.id,
          actor: { kind: "user", userId: input.userId, role: "owner" },
          action: "org.created",
          target: { type: "organization", id: org.id },
          metadata: { name },
          request: input.request,
        });
        return org;
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
  }
  throw new AppError("conflict", "could not allocate a unique slug");
}

export interface OrgMembership {
  org: Organization;
  role: Role;
}

/** Organizations the user belongs to, resolved under RLS with no org selected. */
export function listUserOrganizations(db: Database, userId: string): Promise<OrgMembership[]> {
  return withUser(db, userId, (tx) =>
    tx
      .select({ org: organizations, role: memberships.role })
      .from(memberships)
      .innerJoin(organizations, eq(organizations.id, memberships.orgId))
      .where(eq(memberships.userId, userId))
      .orderBy(asc(organizations.name)),
  );
}

export async function findMembershipBySlug(
  db: Database,
  userId: string,
  slug: string,
): Promise<OrgMembership | null> {
  const rows = await withUser(db, userId, (tx) =>
    tx
      .select({ org: organizations, role: memberships.role })
      .from(memberships)
      .innerJoin(organizations, eq(organizations.id, memberships.orgId))
      .where(and(eq(memberships.userId, userId), eq(organizations.slug, slug)))
      .limit(1),
  );
  return rows[0] ?? null;
}

export async function renameOrganization(
  tx: Executor,
  actor: Actor,
  orgId: string,
  name: string,
  request?: RequestMeta,
): Promise<void> {
  assertCan(actor, "org:update");
  const parsed = orgNameSchema.parse(name);
  const updated = await tx
    .update(organizations)
    .set({ name: parsed })
    .where(eq(organizations.id, orgId))
    .returning({ id: organizations.id });
  if (updated.length === 0) throw new AppError("not_found", "organization not found");
  await recordAudit(tx, {
    orgId,
    actor,
    action: "org.renamed",
    target: { type: "organization", id: orgId },
    metadata: { name: parsed },
    request,
  });
}
