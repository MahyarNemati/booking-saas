import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { z } from "zod";
import type { Database, Executor } from "@/db/client";
import {
  invitations,
  memberships,
  organizations,
  type Invitation,
  type Role,
} from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { randomToken, sha256 } from "@/lib/crypto";
import { AppError } from "@/lib/errors";
import { recordAudit, type RequestMeta } from "./audit";
import { assertWithinLimit } from "./billing/plans";
import { getEntitlements } from "./billing/service";
import { countSeats } from "./billing/seats";
import type { Mailer } from "./mail";
import { roleSchema } from "./members";
import { assertCan, canManageRole, type Actor } from "./rbac";

export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const inviteInputSchema = z.object({
  email: z.email().transform((e) => e.trim().toLowerCase()),
  role: roleSchema,
});

export interface InviteDeps {
  mailer: Mailer;
  appUrl: string;
  now?: () => Date;
}

/** Runs inside withTenant(). Returns the raw token so callers can show or test it; only its hash is stored. */
export async function createInvitation(
  tx: Executor,
  deps: InviteDeps,
  actor: Actor,
  input: { orgId: string; orgName: string; email: string; role: Role },
  request?: RequestMeta,
): Promise<{ invitation: Invitation; token: string }> {
  assertCan(actor, "members:invite");
  const { email, role } = inviteInputSchema.parse(input);
  if (actor.kind !== "user" || !canManageRole(actor.role, role)) {
    throw new AppError("forbidden", `cannot invite as ${role}`);
  }

  const entitlements = await getEntitlements(tx);
  const seats = await countSeats(tx);
  assertWithinLimit(
    entitlements.maxSeats,
    seats.members + seats.pending,
    "seat",
  );

  const now = deps.now?.() ?? new Date();
  const token = randomToken(32);
  const [invitation] = await tx
    .insert(invitations)
    .values({
      orgId: input.orgId,
      email,
      role,
      tokenHash: sha256(token),
      invitedBy: actor.userId,
      expiresAt: new Date(now.getTime() + INVITATION_TTL_MS),
    })
    .onConflictDoNothing()
    .returning();
  if (!invitation)
    throw new AppError("conflict", `${email} already has a pending invitation`);

  await recordAudit(tx, {
    orgId: input.orgId,
    actor,
    action: "invitation.created",
    target: { type: "invitation", id: invitation.id },
    metadata: { email, role },
    request,
  });

  const link = `${deps.appUrl}/invite/${token}`;
  await deps.mailer.send({
    to: email,
    subject: `You have been invited to ${input.orgName}`,
    text: `You have been invited to join ${input.orgName} as ${role}.\n\nAccept the invitation: ${link}\n\nThe link expires in 7 days.`,
  });
  return { invitation, token };
}

export async function listPendingInvitations(
  tx: Executor,
  actor: Actor,
): Promise<Invitation[]> {
  assertCan(actor, "members:read");
  return tx
    .select()
    .from(invitations)
    .where(
      and(
        isNull(invitations.acceptedAt),
        isNull(invitations.revokedAt),
        gt(invitations.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(invitations.createdAt));
}

export async function revokeInvitation(
  tx: Executor,
  actor: Actor,
  input: { orgId: string; invitationId: string },
  request?: RequestMeta,
): Promise<void> {
  assertCan(actor, "members:invite");
  const revoked = await tx
    .update(invitations)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(invitations.id, input.invitationId),
        isNull(invitations.acceptedAt),
        isNull(invitations.revokedAt),
      ),
    )
    .returning({ id: invitations.id, email: invitations.email });
  if (revoked.length === 0)
    throw new AppError("not_found", "invitation not found");
  await recordAudit(tx, {
    orgId: input.orgId,
    actor,
    action: "invitation.revoked",
    target: { type: "invitation", id: input.invitationId },
    metadata: { email: revoked[0]?.email },
    request,
  });
}

/**
 * Redeems an invitation token for the signed-in user. The token lookup is the
 * only step that runs outside RLS, since the org is unknown until the token
 * resolves; the membership write happens under the invitation's org.
 */
export async function acceptInvitation(
  db: Database,
  input: { token: string; userId: string; email: string | null },
  request?: RequestMeta,
): Promise<{ orgId: string; slug: string; role: Role }> {
  const [inv] = await db
    .select()
    .from(invitations)
    .where(eq(invitations.tokenHash, sha256(input.token)))
    .limit(1);
  if (!inv || inv.revokedAt || inv.acceptedAt)
    throw new AppError("not_found", "invitation is not valid");
  if (inv.expiresAt.getTime() <= Date.now())
    throw new AppError("invalid", "invitation has expired");
  if (!input.email || input.email.toLowerCase() !== inv.email) {
    throw new AppError(
      "forbidden",
      "invitation was sent to a different email address",
    );
  }

  return withTenant(
    db,
    { orgId: inv.orgId, userId: input.userId },
    async (tx) => {
      const claimed = await tx
        .update(invitations)
        .set({ acceptedAt: new Date() })
        .where(
          and(
            eq(invitations.id, inv.id),
            isNull(invitations.acceptedAt),
            isNull(invitations.revokedAt),
          ),
        )
        .returning({ id: invitations.id });
      if (claimed.length === 0)
        throw new AppError("conflict", "invitation was already used");

      await tx
        .insert(memberships)
        .values({ orgId: inv.orgId, userId: input.userId, role: inv.role })
        .onConflictDoNothing();
      await recordAudit(tx, {
        orgId: inv.orgId,
        actor: { kind: "user", userId: input.userId, role: inv.role },
        action: "invitation.accepted",
        target: { type: "invitation", id: inv.id },
        metadata: { email: inv.email, role: inv.role },
        request,
      });
      const [org] = await tx
        .select({ slug: organizations.slug })
        .from(organizations)
        .where(eq(organizations.id, inv.orgId));
      if (!org)
        throw new AppError("not_found", "organization no longer exists");
      return { orgId: inv.orgId, slug: org.slug, role: inv.role };
    },
  );
}
