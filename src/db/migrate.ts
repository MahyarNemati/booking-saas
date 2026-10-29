import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "./client";

export async function runMigrations(url: string): Promise<void> {
  const { db, sql } = createDb(url, 1);
  try {
    await migrate(db, { migrationsFolder: "drizzle" });
  } finally {
    await sql.end();
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) {
    process.stderr.write("DATABASE_URL or MIGRATION_DATABASE_URL is required\n");
    process.exit(1);
  }
  runMigrations(url)
    .then(() => process.stdout.write("migrations applied\n"))
    .catch((err: unknown) => {
      process.stderr.write(`migration failed: ${String(err)}\n`);
      process.exit(1);
    });
}
