import { normalizeAgentIdStrict } from "@openclaw/normalization-core/agent-id";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../../state/openclaw-state-db-readonly.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import type { OpenClawStateDatabaseOptions } from "../../state/openclaw-state-db.js";
import { classifyHiddenGitHubStoreName } from "./secret-store-hidden-github.js";
import {
  isMissingSecretStoreTableError,
  normalizeSecretStoreAudience,
} from "./secret-store-shared.js";
import { getSecretStoreEntryMetadata, listSecretStoreEntries } from "./secret-store.js";

type SecretStoreAccessDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "secret_store_entries" | "agent_secret_assignments"
>;

/**
 * Resolves one validated agent's effective secret-name access over the live
 * team store: every live entry with audience "all" (legacy team-wide
 * delivery) plus every live entry with audience "selected" that has an
 * explicit assignment row for the agent. An empty assignment set never
 * implies global access. Missing tables fail open only to the "all" side —
 * identical to legacy behavior before assignments existed.
 */
export function listEffectiveAgentSecretNames(params: {
  agentId: string;
  database?: OpenClawStateDatabaseOptions;
}): string[] {
  const normalized = normalizeAgentIdStrict(params.agentId);
  if (!normalized.ok) {
    return [];
  }
  try {
    return (
      withExistingOpenClawStateDatabaseReadOnly(({ db: sqlite }) => {
        const db = getNodeSqliteKysely<SecretStoreAccessDatabase>(sqlite);
        const rows = executeSqliteQuerySync(
          sqlite,
          db
            .selectFrom("secret_store_entries")
            .select(["name", "audience"])
            .where("scope_kind", "=", "team")
            .where("scope_id", "=", "")
            .where("deleted_at_ms", "is", null),
        ).rows.filter((row) => classifyHiddenGitHubStoreName(row.name) === undefined);
        const assigned = new Set(
          executeSqliteQuerySync(
            sqlite,
            db
              .selectFrom("agent_secret_assignments")
              .select("secret_name")
              .where("agent_id", "=", normalized.value),
          ).rows.map((row) => row.secret_name),
        );
        return rows
          .filter(
            (row) => normalizeSecretStoreAudience(row.audience) === "all" || assigned.has(row.name),
          )
          .map((row) => row.name)
          .toSorted();
      }, params.database ?? {}) ?? []
    );
  } catch (error) {
    if (
      isMissingSecretStoreTableError(error) ||
      (error instanceof Error && error.message === "no such table: agent_secret_assignments")
    ) {
      // No assignments table: selected entries cannot exist yet; "all"
      // entries keep legacy delivery.
      try {
        return listSecretStoreEntries({ scope: { kind: "team" }, database: params.database })
          .filter((entry) => entry.audience === "all")
          .map((entry) => entry.name);
      } catch {
        return [];
      }
    }
    throw error;
  }
}

/**
 * Effective single-name access check mirroring listEffectiveAgentSecretNames:
 * audience "all" is accessible to every valid agent; audience "selected"
 * requires an explicit assignment row.
 */
export function hasEffectiveAgentSecretAccess(params: {
  agentId: string;
  secretName: string;
  database?: OpenClawStateDatabaseOptions;
}): boolean {
  const normalized = normalizeAgentIdStrict(params.agentId);
  if (!normalized.ok) {
    return false;
  }
  try {
    return (
      withExistingOpenClawStateDatabaseReadOnly(({ db: sqlite }) => {
        const db = getNodeSqliteKysely<SecretStoreAccessDatabase>(sqlite);
        const entry = executeSqliteQueryTakeFirstSync(
          sqlite,
          db
            .selectFrom("secret_store_entries")
            .select("audience")
            .where("scope_kind", "=", "team")
            .where("scope_id", "=", "")
            .where("name", "=", params.secretName)
            .where("deleted_at_ms", "is", null)
            .limit(1),
        );
        if (!entry || classifyHiddenGitHubStoreName(params.secretName) !== undefined) {
          return false;
        }
        if (normalizeSecretStoreAudience(entry.audience) === "all") {
          return true;
        }
        return (
          executeSqliteQueryTakeFirstSync(
            sqlite,
            db
              .selectFrom("agent_secret_assignments")
              .select("secret_name")
              .where("agent_id", "=", normalized.value)
              .where("secret_name", "=", params.secretName)
              .limit(1),
          ) !== undefined
        );
      }, params.database ?? {}) ?? false
    );
  } catch (error) {
    if (isMissingSecretStoreTableError(error)) {
      return false;
    }
    if (error instanceof Error && error.message === "no such table: agent_secret_assignments") {
      // Legacy database: only "all"-audience entries can exist.
      try {
        const entry = getSecretStoreEntryMetadata({
          scope: { kind: "team" },
          name: params.secretName,
          database: params.database,
        });
        return entry?.audience === "all";
      } catch {
        return false;
      }
    }
    throw error;
  }
}
