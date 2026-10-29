import { and, desc, eq, isNull, lt, or } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { Database, Executor } from "@/db/client";
import { apiKeys, type ApiKey } from "@/db/schema";
import { randomToken, safeEqualHex, sha256 } from "@/lib/crypto";
import { AppError } from "@/lib/errors";
import { recordAudit, type RequestMeta } from "./audit";
import { assertFeature } from "./billing/plans";
import { getEntitlements } from "./billing/service";
import {
  API_KEY_SCOPES,
  assertCan,
  type Actor,
  type ApiKeyScope,
} from "./rbac";

const KEY_PREFIX = "sk";
const KEY_PATTERN = /^sk_([0-9a-f]{12})_([A-Za-z0-9_-]{43})$/;
const LAST_USED_RESOLUTION_MS = 60_000;

export const createKeyInputSchema = z.object({
  name: z.string().trim().min(1).max(64),
  scopes: z.array(z.enum(API_KEY_SCOPES)).min(1),
  expiresInDays: z.number().int().min(1).max(365).nullable().default(null),
});

export type PublicApiKey = Omit<ApiKey, "keyHash">;

function toPublic({ keyHash: _hash, ...rest }: ApiKey): PublicApiKey {
  return rest;
}

/**
 * Keys look like sk_<12 hex prefix>_<43 char secret>. The prefix is stored in
 * clear for lookup and display; the full key is stored only as SHA-256. The
 * secret carries 256 bits of entropy, so a slow KDF would add latency to
 * every request without adding resistance to brute force.
 */
export function generateKey(): { key: string; prefix: string; hash: string } {
  const prefix = randomBytes(6).toString("hex");
  const key = `${KEY_PREFIX}_${prefix}_${randomToken(32)}`;
  return { key, prefix, hash: sha256(key) };
}

export function parseKey(key: string): { prefix: string } | null {
  const match = KEY_PATTERN.exec(key);
  return match?.[1] ? { prefix: match[1] } : null;
}

/** Runs inside withTenant(). The plaintext key is returned once and never stored. */
export async function createApiKey(
  tx: Executor,
  actor: Actor,
  input: {
    orgId: string;
    name: string;
    scopes: ApiKeyScope[];
    expiresInDays?: number | null;
  },
  request?: RequestMeta,
): Promise<{ key: string; record: PublicApiKey }> {
  assertCan(actor, "api_keys:manage");
  assertFeature(await getEntitlements(tx), "api_keys");
  const parsed = createKeyInputSchema.parse(input);
  const generated = generateKey();
  const [record] = await tx
    .insert(apiKeys)
    .values({
      orgId: input.orgId,
      name: parsed.name,
      prefix: generated.prefix,
      keyHash: generated.hash,
      scopes: parsed.scopes,
      createdBy: actor.kind === "user" ? actor.userId : null,
      expiresAt: parsed.expiresInDays
        ? new Date(Date.now() + parsed.expiresInDays * 86_400_000)
        : null,
    })
    .returning();
  if (!record) throw new Error("insert returned no row");
  await recordAudit(tx, {
    orgId: input.orgId,
    actor,
    action: "api_key.created",
    target: { type: "api_key", id: record.id },
    metadata: {
      name: parsed.name,
      scopes: parsed.scopes,
      prefix: generated.prefix,
    },
    request,
  });
  return { key: generated.key, record: toPublic(record) };
}

export async function listApiKeys(
  tx: Executor,
  actor: Actor,
): Promise<PublicApiKey[]> {
  assertCan(actor, "api_keys:read");
  const rows = await tx.select().from(apiKeys).orderBy(desc(apiKeys.createdAt));
  return rows.map(toPublic);
}

export async function revokeApiKey(
  tx: Executor,
  actor: Actor,
  input: { orgId: string; keyId: string },
  request?: RequestMeta,
): Promise<void> {
  assertCan(actor, "api_keys:manage");
  const revoked = await tx
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.id, input.keyId), isNull(apiKeys.revokedAt)))
    .returning({ id: apiKeys.id, prefix: apiKeys.prefix });
  if (revoked.length === 0)
    throw new AppError("not_found", "api key not found");
  await recordAudit(tx, {
    orgId: input.orgId,
    actor,
    action: "api_key.revoked",
    target: { type: "api_key", id: input.keyId },
    metadata: { prefix: revoked[0]?.prefix },
    request,
  });
}

export interface ResolvedKey {
  orgId: string;
  actor: Extract<Actor, { kind: "api_key" }>;
}

/**
 * Authenticates a bearer key. Like invitation tokens, this lookup runs before
 * any org is known, so it reads api_keys by its unique prefix on the
 * privileged connection and returns the org for the caller to scope into.
 */
export async function authenticateApiKey(
  db: Database,
  key: string,
): Promise<ResolvedKey> {
  const parsed = parseKey(key);
  if (!parsed) throw new AppError("unauthenticated", "malformed api key");
  const [row] = await db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.prefix, parsed.prefix))
    .limit(1);
  if (!row || !safeEqualHex(row.keyHash, sha256(key))) {
    throw new AppError("unauthenticated", "invalid api key");
  }
  const now = Date.now();
  if (row.revokedAt)
    throw new AppError("unauthenticated", "api key has been revoked");
  if (row.expiresAt && row.expiresAt.getTime() <= now) {
    throw new AppError("unauthenticated", "api key has expired");
  }

  const stale = new Date(now - LAST_USED_RESOLUTION_MS);
  await db
    .update(apiKeys)
    .set({ lastUsedAt: new Date(now) })
    .where(
      and(
        eq(apiKeys.id, row.id),
        or(isNull(apiKeys.lastUsedAt), lt(apiKeys.lastUsedAt, stale)),
      ),
    );

  return {
    orgId: row.orgId,
    actor: {
      kind: "api_key",
      keyId: row.id,
      scopes: row.scopes as ApiKeyScope[],
    },
  };
}
