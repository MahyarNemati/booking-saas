import { asc, count, eq } from "drizzle-orm";
import { z } from "zod";
import type { Executor } from "@/db/client";
import { projects, type Project } from "@/db/schema";
import { AppError } from "@/lib/errors";
import { recordAudit, type RequestMeta } from "./audit";
import { assertWithinLimit } from "./billing/plans";
import { getEntitlements } from "./billing/service";
import { actorId, assertCan, type Actor } from "./rbac";

export const projectInputSchema = z.object({ name: z.string().trim().min(1).max(80) });

/** All functions here expect to run inside withTenant(). */
export async function listProjects(tx: Executor, actor: Actor): Promise<Project[]> {
  assertCan(actor, "projects:read");
  return tx.select().from(projects).orderBy(asc(projects.createdAt));
}

export async function createProject(
  tx: Executor,
  actor: Actor,
  input: { orgId: string; name: string },
  request?: RequestMeta,
): Promise<Project> {
  assertCan(actor, "projects:write");
  const { name } = projectInputSchema.parse(input);
  const ent = await getEntitlements(tx);
  const [used] = await tx.select({ n: count() }).from(projects);
  assertWithinLimit(ent.maxProjects, used?.n ?? 0, "project");

  const [project] = await tx
    .insert(projects)
    .values({ orgId: input.orgId, name, createdBy: actor.kind === "user" ? actor.userId : null })
    .onConflictDoNothing()
    .returning();
  if (!project) throw new AppError("conflict", `a project named "${name}" already exists`);
  await recordAudit(tx, {
    orgId: input.orgId,
    actor,
    action: "project.created",
    target: { type: "project", id: project.id },
    metadata: { name, via: actor.kind, by: actorId(actor) },
    request,
  });
  return project;
}

export async function deleteProject(
  tx: Executor,
  actor: Actor,
  input: { orgId: string; projectId: string },
  request?: RequestMeta,
): Promise<void> {
  assertCan(actor, "projects:write");
  const deleted = await tx
    .delete(projects)
    .where(eq(projects.id, input.projectId))
    .returning({ id: projects.id, name: projects.name });
  if (deleted.length === 0) throw new AppError("not_found", "project not found");
  await recordAudit(tx, {
    orgId: input.orgId,
    actor,
    action: "project.deleted",
    target: { type: "project", id: input.projectId },
    metadata: { name: deleted[0]?.name },
    request,
  });
}
