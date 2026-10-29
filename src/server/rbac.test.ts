import { describe, expect, it } from "vitest";
import type { Role } from "@/db/schema";
import { AppError } from "@/lib/errors";
import {
  PERMISSION_MATRIX,
  PERMISSIONS,
  assertCan,
  can,
  canChangeRole,
  canManageRole,
  type Permission,
} from "./rbac";

const user = (role: Role) => ({ kind: "user" as const, userId: "u", role });

describe("permission matrix", () => {
  it("gives owners every permission", () => {
    for (const p of PERMISSIONS) expect(can(user("owner"), p)).toBe(true);
  });

  it("is monotonic: each role holds everything the role below it holds", () => {
    for (const p of PERMISSION_MATRIX.member)
      expect(PERMISSION_MATRIX.admin.has(p)).toBe(true);
    for (const p of PERMISSION_MATRIX.admin)
      expect(PERMISSION_MATRIX.owner.has(p)).toBe(true);
  });

  it.each<[Permission, boolean, boolean]>([
    ["billing:manage", false, false],
    ["org:delete", false, false],
    ["members:invite", true, false],
    ["api_keys:manage", true, false],
    ["audit:read", true, false],
    ["bookings:write", true, true],
    ["billing:read", true, true],
  ])("%s: admin=%s member=%s", (permission, admin, member) => {
    expect(can(user("admin"), permission)).toBe(admin);
    expect(can(user("member"), permission)).toBe(member);
  });

  it("limits api keys to their scopes", () => {
    const key = {
      kind: "api_key" as const,
      keyId: "k",
      scopes: ["bookings:read" as const],
    };
    expect(can(key, "bookings:read")).toBe(true);
    expect(can(key, "bookings:write")).toBe(false);
    expect(can(key, "members:invite")).toBe(false);
  });

  it("throws a forbidden AppError", () => {
    expect(() => assertCan(user("member"), "billing:manage")).toThrow(AppError);
  });
});

describe("role management", () => {
  it("lets admins manage members and admins but not owners", () => {
    expect(canManageRole("admin", "member")).toBe(true);
    expect(canManageRole("admin", "admin")).toBe(true);
    expect(canManageRole("admin", "owner")).toBe(false);
    expect(canManageRole("member", "member")).toBe(false);
  });

  it("forbids promoting to a role the actor cannot manage", () => {
    expect(canChangeRole("admin", "member", "admin")).toBe(true);
    expect(canChangeRole("admin", "member", "owner")).toBe(false);
    expect(canChangeRole("admin", "owner", "member")).toBe(false);
    expect(canChangeRole("owner", "owner", "member")).toBe(true);
  });
});
