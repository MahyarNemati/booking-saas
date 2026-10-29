import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "@/env";
import * as schema from "./schema";

export type Database = PostgresJsDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
/** Anything that can run queries: the root handle or an open transaction. */
export type Executor = Database | Tx;

export function createDb(url: string, max = 10): { db: Database; sql: postgres.Sql } {
  const client = postgres(url, { max, prepare: false, onnotice: () => {} });
  return { db: drizzle(client, { schema, casing: "snake_case" }), sql: client };
}

const globalForDb = globalThis as unknown as { __db?: ReturnType<typeof createDb> };

/** Process-wide connection pool, reused across hot reloads in development. */
export function getDb(): Database {
  if (!globalForDb.__db) {
    const e = env();
    globalForDb.__db = createDb(e.DATABASE_URL, e.DATABASE_POOL_MAX);
  }
  return globalForDb.__db.db;
}
