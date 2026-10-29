import type { Role } from "@/db/schema";
import { AppError } from "@/lib/errors";

export const PERMISSIONS = [
  "org:read",
  "org:update",
  "org:delete",
  "members:read",
  "members:invite",
  "members:update",
  "members:remove",
  "billing:read",
  "billing:manage",
  "api_keys:read",
  "api_keys:manage",
  "audit:read",
  // The booking domain. Read and write are separated because a front-desk
  // member of staff needs to take bookings, while an integration that only
  // syncs a calendar needs to see them and nothing more.
  "bookings:read",
  "bookings:write",
  "schedule:read",
  "schedule:write",
  "services:read",
  "services:write",
  "customers:read",
  "customers:write",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

// A member is front-desk staff: they take and change bookings and see the
// diary, but they do not define what the business sells or when it opens.
const MEMBER: readonly Permission[] = [
  "org:read",
  "members:read",
  "billing:read",
  "bookings:read",
  "bookings:write",
  "schedule:read",
  "services:read",
  "customers:read",
  "customers:write",
];

const ADMIN: readonly Permission[] = [
  ...MEMBER,
  "org:update",
  "members:invite",
  "members:update",
  "members:remove",
  "api_keys:read",
  "api_keys:manage",
  "audit:read",
  "schedule:write",
  "services:write",
];

export const PERMISSION_MATRIX: Readonly<
  Record<Role, ReadonlySet<Permission>>
> = {
  owner: new Set(PERMISSIONS),
  admin: new Set(ADMIN),
  member: new Set(MEMBER),
};

const RANK: Record<Role, number> = { member: 0, admin: 1, owner: 2 };

/** Scopes an API key may carry. Keys never get member-management or billing rights. */
export const API_KEY_SCOPES = [
  "bookings:read",
  "bookings:write",
  "schedule:read",
  "services:read",
  "customers:read",
  "audit:read",
] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export type Actor =
  | { kind: "user"; userId: string; role: Role }
  | { kind: "api_key"; keyId: string; scopes: readonly ApiKeyScope[] };

export function can(actor: Actor, permission: Permission): boolean {
  if (actor.kind === "user")
    return PERMISSION_MATRIX[actor.role].has(permission);
  return (actor.scopes as readonly string[]).includes(permission);
}

export function assertCan(actor: Actor, permission: Permission): void {
  if (!can(actor, permission)) {
    throw new AppError("forbidden", `missing permission ${permission}`, {
      permission,
    });
  }
}

/** Owners manage anyone; admins manage members and admins but never owners. */
export function canManageRole(actorRole: Role, targetRole: Role): boolean {
  if (actorRole === "owner") return true;
  if (actorRole === "admin") return RANK[targetRole] <= RANK.admin;
  return false;
}

/**
 * Whether `actorRole` may move someone from `from` to `to`. Granting a role
 * requires being able to manage both the current and the requested role.
 */
export function canChangeRole(actorRole: Role, from: Role, to: Role): boolean {
  return canManageRole(actorRole, from) && canManageRole(actorRole, to);
}

export function actorId(actor: Actor): string {
  return actor.kind === "user" ? actor.userId : actor.keyId;
}
