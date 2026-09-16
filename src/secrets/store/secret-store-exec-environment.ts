import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { logWarn } from "../../logger.js";
import { registerSecretValueForRedaction } from "../../logging/secret-redaction-registry.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../../state/openclaw-state-db-readonly.js";
import type { OpenClawStateDatabaseOptions } from "../../state/openclaw-state-db.js";
import { sealSecretSentinel } from "../sentinel.js";
import { classifyHiddenGitHubStoreName } from "./secret-store-hidden-github.js";
import {
  isMissingSecretStoreTableError,
  normalizeSecretStoreAudience,
  parseSecretAllowedHosts,
  resolveAgentSecretAssignmentEnforcement,
  type AgentSecretAssignmentEnforcement,
  type SecretStoreDatabase,
  type SecretStoreEgressBinding,
  type SecretStoreExecEnvironment,
} from "./secret-store-shared.js";

/** Captures one coherent team-store snapshot for an agent run's exec environment. */
export function readSecretStoreExecEnvironment(params: {
  includeSecretSentinels: boolean;
  excludeNames?: readonly string[];
  /** Derived agent run identity; never caller-supplied. */
  agentId?: string;
  /** Assignment filtering policy resolved from config. Default "off" preserves legacy behavior. */
  assignmentEnforcement?: AgentSecretAssignmentEnforcement;
  /** Pre-resolved assigned names for `agentId`; resolved by the caller-side snapshot helper. */
  assignedNames?: Set<string>;
  database?: OpenClawStateDatabaseOptions;
}): SecretStoreExecEnvironment {
  try {
    return (
      withExistingOpenClawStateDatabaseReadOnly(({ db: sqlite }) => {
        const db = getNodeSqliteKysely<SecretStoreDatabase>(sqlite);
        const rows = executeSqliteQuerySync(
          sqlite,
          db
            .selectFrom("secret_store_entries")
            .selectAll()
            .where("scope_kind", "=", "team")
            .where("scope_id", "=", "")
            .where("deleted_at_ms", "is", null)
            .orderBy("name", "asc"),
        ).rows;
        const env: Record<string, string> = {};
        const secretSentinels: Record<string, string> = {};
        const secretEgressBindings: SecretStoreEgressBinding[] = [];
        const excludedNames = new Set(params.excludeNames ?? []);
        // Audience filtering: identity is the tool's derived agentId, never
        // model input. "all"-audience entries keep legacy team-wide delivery
        // to every valid agent; "selected"-audience entries project only to
        // explicitly assigned agents, and an empty assignment set never
        // implies global access. "enforce" fails closed on a missing/invalid
        // identity (enforced by the caller); "advisory" warns about withheld
        // selected entries but never delivers them to an unassigned agent.
        // Selected-audience entries are gated on an explicit assignment for
        // the derived agent identity: without an identity, or without that
        // agent's assignment row, a selected entry is withheld in every mode
        // (advisory only adds a warning). All-audience entries keep legacy
        // team-wide delivery. Enforcement mode never broadens the audience
        // boundary; it only chooses silent withholding (off/enforce) versus
        // warn-and-withhold soak (advisory).
        const enforcement = resolveAgentSecretAssignmentEnforcement(params.assignmentEnforcement);
        const assignedNames =
          params.agentId && params.assignedNames ? params.assignedNames : undefined;
        const advisory = enforcement === "advisory";
        for (const row of rows) {
          if (
            classifyHiddenGitHubStoreName(row.name) !== undefined ||
            excludedNames.has(row.name)
          ) {
            continue;
          }
          if (
            normalizeSecretStoreAudience(row.audience) === "selected" &&
            !(assignedNames?.has(row.name) ?? false)
          ) {
            // Selected-audience entries are withheld from any agent without an
            // explicit assignment in every mode, including the advisory soak.
            // Advisory only adds a warning while withholding; it never broadens
            // delivery beyond the off/enforce decision. Without a derived
            // identity there is nothing to attribute the entry to, so it also
            // fails closed.
            if (advisory && assignedNames) {
              logWarn(
                `secrets: exec snapshot withheld selected-audience store entry ${row.name} without an assignment for this agent`,
              );
            }
            continue;
          }
          if (row.kind === "env") {
            env[row.name] = row.value;
            continue;
          }
          registerSecretValueForRedaction(row.value);
          if (params.includeSecretSentinels) {
            // Subprocesses must never receive plaintext, even when provider-auth
            // sentinel masking is disabled for compatibility.
            const sentinel = sealSecretSentinel(row.value, {
              label: `exec-store:${row.name}`,
            });
            secretSentinels[row.name] = sentinel;
            secretEgressBindings.push({
              name: row.name,
              sentinel,
              allowedHosts: parseSecretAllowedHosts(row.allowed_hosts),
            });
          }
        }
        return {
          ...(Object.keys(env).length > 0 ? { env } : {}),
          ...(Object.keys(secretSentinels).length > 0 ? { secretSentinels } : {}),
          ...(secretEgressBindings.length > 0 ? { secretEgressBindings } : {}),
        };
      }, params.database ?? {}) ?? {}
    );
  } catch (error) {
    if (isMissingSecretStoreTableError(error)) {
      return {};
    }
    throw error;
  }
}
