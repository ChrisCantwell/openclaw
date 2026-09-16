import type { Selectable } from "kysely";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import { normalizeExactAllowedHost } from "../exact-hostname.js";
import {
  SECRET_STORE_ALLOWED_HOSTS_MAX,
  SecretStoreValidationError,
} from "./secret-store-validation-error.js";

/** Kysely view over the team/identity secret store table. */
export type SecretStoreDatabase = Pick<OpenClawStateKyselyDatabase, "secret_store_entries">;

export type SecretStoreRow = Selectable<OpenClawStateKyselyDatabase["secret_store_entries"]>;

export type SecretStoreScope = { kind: "team" };

export type SecretStoreKind = "secret" | "env";

/**
 * Secret-value audience: orthogonal to value protection (kind).
 *
 * An "all" entry keeps the legacy team-wide delivery to every valid agent.
 * A "selected" entry projects only to agents with an explicit row in
 * agent_secret_assignments. Existing rows predate the column and behave as
 * "all" for backward compatibility; empty assignment sets never imply
 * global access.
 */
export type SecretStoreAudience = "all" | "selected";

export const SECRET_STORE_AUDIENCES: readonly SecretStoreAudience[] = ["all", "selected"];

/** Normalizes the persisted audience; absent/invalid legacy values stay "all". */
export function normalizeSecretStoreAudience(
  value: string | null | undefined,
): SecretStoreAudience {
  return value === "selected" ? "selected" : "all";
}

const SECRET_STORE_AUDIENCE_SET = new Set<string>(SECRET_STORE_AUDIENCES);

export function isSecretStoreAudience(value: unknown): value is SecretStoreAudience {
  return typeof value === "string" && SECRET_STORE_AUDIENCE_SET.has(value);
}

export type SecretStoreEgressBinding = {
  name: string;
  sentinel: string;
  allowedHosts: string[];
};

export type SecretStoreExecEnvironment = {
  env?: Record<string, string>;
  secretSentinels?: Record<string, string>;
  secretEgressBindings?: SecretStoreEgressBinding[];
};

export function isMissingSecretStoreTableError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as NodeJS.ErrnoException).code === "ERR_SQLITE_ERROR" &&
    error.message === "no such table: secret_store_entries"
  );
}
/** Config policy controlling agent assignment filtering of exec store snapshots. */
export type AgentSecretAssignmentEnforcement = "off" | "advisory" | "enforce";

/** Resolves the snapshot enforcement mode from raw config; anything invalid or absent stays "off". */
export function resolveAgentSecretAssignmentEnforcement(
  value: unknown,
): AgentSecretAssignmentEnforcement {
  return value === "advisory" || value === "enforce" ? value : "off";
}

function normalizeSecretAllowedHost(raw: string): string {
  try {
    return normalizeExactAllowedHost(raw);
  } catch (error) {
    throw new SecretStoreValidationError(
      "SECRET_STORE_INVALID_ALLOWED_HOST",
      error instanceof Error ? error.message : `Allowed host "${raw}" is not a valid hostname.`,
    );
  }
}

export function normalizeSecretAllowedHosts(hosts: readonly string[]): string[] {
  if (hosts.length > SECRET_STORE_ALLOWED_HOSTS_MAX) {
    throw new SecretStoreValidationError(
      "SECRET_STORE_INVALID_ALLOWED_HOST",
      `A secret can allow at most ${SECRET_STORE_ALLOWED_HOSTS_MAX} hosts.`,
    );
  }
  return [...new Set(hosts.map(normalizeSecretAllowedHost))].toSorted();
}

export function parseSecretAllowedHosts(raw: string | null | undefined): string[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) && parsed.every((host) => typeof host === "string")
      ? normalizeSecretAllowedHosts(parsed)
      : [];
  } catch {
    // Corrupt policy is never interpreted permissively: an empty list fails closed.
    return [];
  }
}
