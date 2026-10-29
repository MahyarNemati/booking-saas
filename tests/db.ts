import { afterAll, inject } from "vitest";
import { createDb, type Database } from "@/db/client";
import { users } from "@/db/schema";

export const databaseUrl = inject("databaseUrl");
export const hasDatabase = databaseUrl !== "";

let handle: ReturnType<typeof createDb> | undefined;

export function testDb(): Database {
  if (!handle) {
    handle = createDb(databaseUrl, 5);
  }
  return handle.db;
}

afterAll(async () => {
  await handle?.sql.end();
  handle = undefined;
});

let seq = 0;

export async function createUser(
  db: Database,
  name = "user",
): Promise<{ id: string; email: string }> {
  seq += 1;
  const email = `${name}.${process.pid}.${seq}.${Date.now()}@example.test`;
  const [row] = await db
    .insert(users)
    .values({ email, name })
    .returning({ id: users.id, email: users.email });
  if (!row?.email) throw new Error("failed to create user");
  return { id: row.id, email: row.email };
}

/** Awaits a promise expected to fail and returns the underlying Postgres error. */
export async function pgError(
  promise: Promise<unknown>,
): Promise<{ code?: string; message: string }> {
  try {
    await promise;
  } catch (err) {
    const cause =
      err instanceof Error && err.cause instanceof Error ? err.cause : err;
    return cause as { code?: string; message: string };
  }
  throw new Error("expected the query to fail");
}
