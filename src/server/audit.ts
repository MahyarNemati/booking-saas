import { desc, lt } from "drizzle-orm";
import type { Executor } from "@/db/client";
import { auditLogs, type AuditLog } from "@/db/schema";
import { actorId, type Actor } from "./rbac";

export interface RequestMeta {
  ip?: string | null;
  userAgent?: string | null;
}

export interface AuditEntry {
  orgId: string;
  actor: Actor | { kind: "system" };
  action: string;
  target?: { type: string; id: string };
  metadata?: Record<string, unknown>;
  request?: RequestMeta;
}

export async function recordAudit(db: Executor, entry: AuditEntry): Promise<void> {
  await db.insert(auditLogs).values({
    orgId: entry.orgId,
    actorType: entry.actor.kind,
    actorId: entry.actor.kind === "system" ? null : actorId(entry.actor),
    action: entry.action,
    targetType: entry.target?.type ?? null,
    targetId: entry.target?.id ?? null,
    metadata: entry.metadata ?? {},
    ip: entry.request?.ip ?? null,
    userAgent: entry.request?.userAgent?.slice(0, 512) ?? null,
  });
}

/** Keyset-paginated, newest first. Callers run this inside withTenant(). */
export async function listAudit(
  db: Executor,
  opts: { limit?: number; before?: Date } = {},
): Promise<AuditLog[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  return db
    .select()
    .from(auditLogs)
    .where(opts.before ? lt(auditLogs.createdAt, opts.before) : undefined)
    .orderBy(desc(auditLogs.createdAt))
    .limit(limit);
}
