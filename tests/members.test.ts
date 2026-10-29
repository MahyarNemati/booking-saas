import { beforeEach, describe, expect, it } from "vitest";
import { subscriptions } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { AppError } from "@/lib/errors";
import { listAudit } from "@/server/audit";
import {
  acceptInvitation,
  createInvitation,
  listPendingInvitations,
  revokeInvitation,
} from "@/server/invitations";
import { MemoryMailer } from "@/server/mail";
import { changeMemberRole, listMembers, removeMember } from "@/server/members";
import { createOrganization, listUserOrganizations } from "@/server/orgs";
import { createService } from "@/server/booking/catalogue";
import type { Actor } from "@/server/rbac";
import { createUser, hasDatabase, testDb } from "./db";

describe.skipIf(!hasDatabase)("members and invitations", () => {
  const db = hasDatabase ? testDb() : (undefined as never);
  let mailer: MemoryMailer;
  let owner: { id: string; email: string };
  let orgId: string;
  let ownerActor: Actor;

  beforeEach(async () => {
    mailer = new MemoryMailer();
    owner = await createUser(db, "owner");
    orgId = (await createOrganization(db, { userId: owner.id, name: "Team" }))
      .id;
    ownerActor = { kind: "user", userId: owner.id, role: "owner" };
  });

  const tenant = <T>(fn: Parameters<typeof withTenant<T>>[2]) =>
    withTenant(db, { orgId }, fn);
  const deps = () => ({ mailer, appUrl: "http://app.test" });

  async function invite(
    email: string,
    role: "admin" | "member" = "member",
    actor = ownerActor,
  ) {
    return tenant((tx) =>
      createInvitation(tx, deps(), actor, {
        orgId,
        orgName: "Team",
        email,
        role,
      }),
    );
  }

  async function join(role: "admin" | "member" = "member") {
    const user = await createUser(db, role);
    const { token } = await invite(user.email, role);
    await acceptInvitation(db, { token, userId: user.id, email: user.email });
    return user;
  }

  it("emails a single-use link and adds the member on acceptance", async () => {
    const invitee = await createUser(db, "invitee");
    const { token } = await invite(invitee.email.toUpperCase());
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]?.text).toContain(`http://app.test/invite/${token}`);

    const result = await acceptInvitation(db, {
      token,
      userId: invitee.id,
      email: invitee.email,
    });
    expect(result.role).toBe("member");
    const orgs = await listUserOrganizations(db, invitee.id);
    expect(orgs.map((o) => o.org.id)).toEqual([orgId]);

    await expect(
      acceptInvitation(db, { token, userId: invitee.id, email: invitee.email }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("refuses an invitation redeemed by a different email", async () => {
    const invitee = await createUser(db, "invitee");
    const stranger = await createUser(db, "stranger");
    const { token } = await invite(invitee.email);
    await expect(
      acceptInvitation(db, {
        token,
        userId: stranger.id,
        email: stranger.email,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("refuses revoked and expired invitations", async () => {
    const a = await createUser(db, "a");
    const { token, invitation } = await invite(a.email);
    await tenant((tx) =>
      revokeInvitation(tx, ownerActor, { orgId, invitationId: invitation.id }),
    );
    await expect(
      acceptInvitation(db, { token, userId: a.id, email: a.email }),
    ).rejects.toThrow(AppError);

    const b = await createUser(db, "b");
    const past = new Date(Date.now() - 8 * 24 * 3600 * 1000);
    const expired = await tenant((tx) =>
      createInvitation(tx, { ...deps(), now: () => past }, ownerActor, {
        orgId,
        orgName: "Team",
        email: b.email,
        role: "member",
      }),
    );
    await expect(
      acceptInvitation(db, {
        token: expired.token,
        userId: b.id,
        email: b.email,
      }),
    ).rejects.toMatchObject({ code: "invalid" });
  });

  it("rejects a second pending invitation to the same address", async () => {
    await invite("dup@example.test");
    await expect(invite("dup@example.test")).rejects.toMatchObject({
      code: "conflict",
    });
  });

  it("counts members and pending invitations against the free plan seat limit", async () => {
    await join();
    await invite("third@example.test");
    await expect(invite("fourth@example.test")).rejects.toMatchObject({
      code: "payment_required",
    });
    const pending = await tenant((tx) =>
      listPendingInvitations(tx, ownerActor),
    );
    expect(pending).toHaveLength(1);
  });

  it("lifts the seat limit on a paid plan", async () => {
    await tenant((tx) =>
      tx.insert(subscriptions).values({
        orgId,
        stripeSubscriptionId: `sub_${orgId}`,
        stripePriceId: "price_pro",
        plan: "pro",
        status: "active",
        seats: 1,
        lastEventAt: new Date(),
      }),
    );
    for (let i = 0; i < 5; i += 1) await invite(`p${i}@example.test`);
  });

  it("stops admins from inviting or promoting owners", async () => {
    const admin = await join("admin");
    const adminActor: Actor = { kind: "user", userId: admin.id, role: "admin" };
    await expect(
      tenant((tx) =>
        createInvitation(tx, deps(), adminActor, {
          orgId,
          orgName: "Team",
          email: "x@example.test",
          role: "owner",
        }),
      ),
    ).rejects.toMatchObject({ code: "forbidden" });

    const members = await tenant((tx) => listMembers(tx, ownerActor));
    const ownerRow = members.find((m) => m.userId === owner.id)!;
    await expect(
      tenant((tx) =>
        changeMemberRole(tx, adminActor, {
          orgId,
          membershipId: ownerRow.id,
          role: "member",
        }),
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("keeps at least one owner", async () => {
    const members = await tenant((tx) => listMembers(tx, ownerActor));
    const self = members[0]!;
    await expect(
      tenant((tx) =>
        changeMemberRole(tx, ownerActor, {
          orgId,
          membershipId: self.id,
          role: "admin",
        }),
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      tenant((tx) =>
        removeMember(tx, ownerActor, { orgId, membershipId: self.id }),
      ),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("lets members leave and owners remove them, with an audit trail", async () => {
    const member = await join();
    const memberActor: Actor = {
      kind: "user",
      userId: member.id,
      role: "member",
    };
    const rows = await tenant((tx) => listMembers(tx, ownerActor));
    const row = rows.find((m) => m.userId === member.id)!;

    const other = await join();
    const otherRow = (await tenant((tx) => listMembers(tx, ownerActor))).find(
      (m) => m.userId === other.id,
    )!;
    await expect(
      tenant((tx) =>
        removeMember(tx, memberActor, { orgId, membershipId: otherRow.id }),
      ),
    ).rejects.toMatchObject({ code: "forbidden" });

    await tenant((tx) =>
      removeMember(tx, memberActor, { orgId, membershipId: row.id }),
    );
    await tenant((tx) =>
      removeMember(tx, ownerActor, { orgId, membershipId: otherRow.id }),
    );
    expect(await tenant((tx) => listMembers(tx, ownerActor))).toHaveLength(1);

    const actions = (await tenant((tx) => listAudit(tx))).map((a) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        "member.left",
        "member.removed",
        "invitation.accepted",
        "org.created",
      ]),
    );
  });

  it("derives a service slug from its name and refuses a duplicate", async () => {
    const created = await tenant((tx) =>
      createService(tx, ownerActor, {
        orgId,
        name: "Hair Cut & Blow Dry",
        durationMinutes: 45,
      }),
    );
    expect(created.slug).toBe("hair-cut-blow-dry");

    // The slug is what a public booking URL is built from, so two services
    // cannot share one. The unique index decides, not a prior read, so two
    // concurrent creates cannot both win.
    await expect(
      tenant((tx) =>
        createService(tx, ownerActor, {
          orgId,
          name: "Hair cut & blow dry",
          durationMinutes: 30,
        }),
      ),
    ).rejects.toMatchObject({ code: "conflict" });

    // A different name is fine, and the rules are validated as a whole: a
    // deposit larger than the price is rejected before it reaches a
    // constraint.
    await tenant((tx) =>
      createService(tx, ownerActor, {
        orgId,
        name: "Colour",
        durationMinutes: 90,
      }),
    );
    await expect(
      tenant((tx) =>
        createService(tx, ownerActor, {
          orgId,
          name: "Perm",
          durationMinutes: 60,
          priceMinor: 1000,
          depositMinor: 2000,
        }),
      ),
    ).rejects.toThrow(/deposit cannot exceed/);
  });

  it("refuses a service to a member who may read but not write", async () => {
    // Front-desk staff take bookings; they do not decide what the business
    // sells. That split is the whole point of having two permissions.
    const frontDesk: Actor = { kind: "user", userId: owner.id, role: "member" };
    await expect(
      tenant((tx) =>
        createService(tx, frontDesk, {
          orgId,
          name: "Cheap",
          durationMinutes: 5,
        }),
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});
