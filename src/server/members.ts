import { and, asc, count, eq } from "drizzle-orm";
import { z } from "zod";
import type { Executor } from "@/db/client";
import { memberships, roleEnum, users, type Role } from "@/db/schema";
import { AppError } from "@/lib/errors";
import { recordAudit, type RequestMeta } from "./audit";
import { assertCan, canChangeRole, canManageRole, type Actor } from "./rbac";

export const roleSchema = z.enum(roleEnum.enumValues);

export interface MemberRow {
  id: string;
  userId: string;
  role: Role;
  name: string | null;
  email: string | null;
  image: string | null;
  createdAt: Date;
}

/** All functions here expect to run inside withTenant(). */
export async function listMembers(
  tx: Executor,
  actor: Actor,
): Promise<MemberRow[]> {
  assertCan(actor, "members:read");
  return tx
    .select({
      id: memberships.id,
      userId: memberships.userId,
      role: memberships.role,
      name: users.name,
      email: users.email,
      image: users.image,
      createdAt: memberships.createdAt,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .orderBy(asc(memberships.createdAt));
}

async function loadMembership(tx: Executor, membershipId: string) {
  const [row] = await tx
    .select()
    .from(memberships)
    .where(eq(memberships.id, membershipId))
    .limit(1);
  if (!row) throw new AppError("not_found", "member not found");
  return row;
}

async function ownerCount(tx: Executor): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(memberships)
    .where(eq(memberships.role, "owner"));
  return row?.n ?? 0;
}

function actorRole(actor: Actor): Role {
  if (actor.kind !== "user")
    throw new AppError("forbidden", "only users can manage members");
  return actor.role;
}

export async function changeMemberRole(
  tx: Executor,
  actor: Actor,
  input: { orgId: string; membershipId: string; role: Role },
  request?: RequestMeta,
): Promise<void> {
  assertCan(actor, "members:update");
  const role = roleSchema.parse(input.role);
  const target = await loadMembership(tx, input.membershipId);
  if (target.role === role) return;
  if (!canChangeRole(actorRole(actor), target.role, role)) {
    throw new AppError(
      "forbidden",
      `cannot change a ${target.role} to ${role}`,
    );
  }
  if (target.role === "owner" && (await ownerCount(tx)) <= 1) {
    throw new AppError(
      "conflict",
      "an organization must keep at least one owner",
    );
  }
  await tx
    .update(memberships)
    .set({ role })
    .where(eq(memberships.id, target.id));
  await recordAudit(tx, {
    orgId: input.orgId,
    actor,
    action: "member.role_changed",
    target: { type: "user", id: target.userId },
    metadata: { from: target.role, to: role },
    request,
  });
}

export async function removeMember(
  tx: Executor,
  actor: Actor,
  input: { orgId: string; membershipId: string },
  request?: RequestMeta,
): Promise<{ userId: string }> {
  const target = await loadMembership(tx, input.membershipId);
  const self = actor.kind === "user" && actor.userId === target.userId;
  if (!self) {
    assertCan(actor, "members:remove");
    if (!canManageRole(actorRole(actor), target.role)) {
      throw new AppError("forbidden", `cannot remove a ${target.role}`);
    }
  }
  if (target.role === "owner" && (await ownerCount(tx)) <= 1) {
    throw new AppError(
      "conflict",
      "transfer ownership before the last owner leaves",
    );
  }
  await tx
    .delete(memberships)
    .where(
      and(eq(memberships.id, target.id), eq(memberships.orgId, input.orgId)),
    );
  await recordAudit(tx, {
    orgId: input.orgId,
    actor,
    action: self ? "member.left" : "member.removed",
    target: { type: "user", id: target.userId },
    metadata: { role: target.role },
    request,
  });
  return { userId: target.userId };
}
