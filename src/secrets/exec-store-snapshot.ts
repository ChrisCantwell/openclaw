import { isValidAgentId, normalizeAgentIdStrict } from "@openclaw/normalization-core/agent-id";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import {
  resolveAgentSecretAssignmentEnforcement,
  readSecretStoreExecEnvironment,
} from "./store/secret-store.js";

/** Kysely view including the assignments table. */
type AssignmentsSnapshotDatabase = Pick<OpenClawStateKyselyDatabase, "agent_secret_assignments">;

function isMissingAgentSecretAssignmentsTableError(error: unknown): boolean {
  return error instanceof Error && error.message === "no such table: agent_secret_assignments";
}

/**
 * Lists team-store entry names assigned to `agentId` (empty when the table is
 * missing). Uses the same strict normalization as assignment writes so a
 * valid mixed-case runtime id cannot fail closed against its lowercase rows.
 */
function assignedStoreNamesForAgent(
  agentId: string,
  database?: OpenClawStateDatabaseOptions,
): Set<string> {
  const normalized = normalizeAgentIdStrict(agentId);
  if (!normalized.ok) {
    return new Set();
  }
  try {
    return new Set(
      withExistingOpenClawStateDatabaseReadOnly(({ db: sqlite }) => {
        const db = getNodeSqliteKysely<AssignmentsSnapshotDatabase>(sqlite);
        return executeSqliteQuerySync(
          sqlite,
          db
            .selectFrom("agent_secret_assignments")
            .select("secret_name")
            .where("agent_id", "=", normalized.value)
            .orderBy("secret_name", "asc"),
        ).rows.map((row) => row.secret_name);
      }, database ?? {}) ?? [],
    );
  } catch (error) {
    if (isMissingAgentSecretAssignmentsTableError(error)) {
      return new Set();
    }
    throw error;
  }
}

/** Resolves the exec-snapshot assignment policy from operator config. */
export function resolveExecSnapshotAssignmentEnforcement(
  config?: OpenClawConfig,
): "off" | "advisory" | "enforce" {
  return resolveAgentSecretAssignmentEnforcement(config?.secrets?.agentAssignmentEnforcement);
}

/** Generic safe denial: no identity detail, no store shape, no assignment existence. */
const AGENT_IDENTITY_REQUIRED_ENFORCE =
  "Secret store snapshot unavailable: agent assignment enforcement is enabled and no valid agent identity was derived for this run.";

/** Captures an assignment-scoped team-store exec snapshot for one derived agent identity. */
export function readAssignedSecretStoreExecEnvironment(params: {
  includeSecretSentinels: boolean;
  excludeNames?: readonly string[];
  /** Derived from authenticated runtime context inside createExecTool; never model/tool args. */
  agentId?: string;
  config?: OpenClawConfig;
  database?: Parameters<typeof readSecretStoreExecEnvironment>[0]["database"];
}): ReturnType<typeof readSecretStoreExecEnvironment> {
  const enforcement = resolveExecSnapshotAssignmentEnforcement(params.config);
  const agentId = params.agentId?.trim();
  if (enforcement === "enforce" && (!agentId || !isValidAgentId(agentId))) {
    // Fail closed: absent or invalid identity means no projection — never the
    // legacy full snapshot. Operator/admin surfaces and startup config
    // materialization keep using the original unfiltered store/config paths.
    throw new Error(AGENT_IDENTITY_REQUIRED_ENFORCE);
  }
  const assignedNames = agentId ? assignedStoreNamesForAgent(agentId, params.database) : undefined;
  return readSecretStoreExecEnvironment({
    includeSecretSentinels: params.includeSecretSentinels,
    excludeNames: params.excludeNames,
    agentId,
    assignmentEnforcement: enforcement,
    assignedNames,
    database: params.database,
  });
}
