import postgres from "postgres";
import type { TestProject } from "vitest/node";
import { runMigrations } from "../src/db/migrate";

declare module "vitest" {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

/**
 * Creates a throwaway database for the run when TEST_DATABASE_URL points at a
 * reachable server. Without it, database-backed suites skip.
 */
export default async function setup(project: TestProject) {
  const adminUrl = process.env.TEST_DATABASE_URL;
  if (!adminUrl) {
    project.provide("databaseUrl", "");
    return;
  }
  const name = `saas_starter_test_${process.pid}`;
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  await admin.unsafe(`drop database if exists ${name}`);
  await admin.unsafe(`create database ${name}`);
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  await runMigrations(url.toString());
  project.provide("databaseUrl", url.toString());

  return async () => {
    await admin.unsafe(`drop database if exists ${name} with (force)`);
    await admin.end();
  };
}
