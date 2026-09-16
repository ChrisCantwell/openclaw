import { isValidAgentId, normalizeAgentIdStrict } from "@openclaw/normalization-core/agent-id";
import { ENV_SECRET_REF_ID_RE } from "../config/types.secrets.js";
import { hasErrnoCode } from "../infra/errors.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import { ensureAgentSecretAssignmentSchema } from "../state/openclaw-state-db-schema-additive.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { SECRET_PROVIDER_ALIAS_PATTERN } from "./ref-contract.js";

type AssignmentDatabase = Pick<OpenClawStateKyselyDatabase, "agent_secret_assignments">;
/** Presentation page size for operator/admin inventory listings, not an authorization bound. */
export const AGENT_SECRET_ASSIGNMENTS_PAGE_SIZE = 256;

export class AgentSecretAssignmentValidationError extends Error {
  constructor(
    readonly code:
      | "AGENT_SECRET_ASSIGNMENT_INVALID_AGENT_ID"
      | "AGENT_SECRET_ASSIGNMENT_INVALID_SECRET_NAME"
      | "AGENT_SECRET_ASSIGNMENT_INVALID_PROVIDER_HINT",
    message: string,
  ) {
    super(message);
    this.name = "AgentSecretAssignmentValidationError";
  }
}

function normalizeStrictAgentId(agentId: string): string {
  if (!isValidAgentId(agentId)) {
    throw new AgentSecretAssignmentValidationError(
      "AGENT_SECRET_ASSIGNMENT_INVALID_AGENT_ID",
      "Agent ID must contain only ASCII letters, numbers, underscores, or hyphens, start with a letter or number, and be at most 64 characters.",
    );
  }
  const normalized = normalizeAgentIdStrict(agentId);
  if (!normalized.ok) {
    throw new AgentSecretAssignmentValidationError(
      "AGENT_SECRET_ASSIGNMENT_INVALID_AGENT_ID",
      "Agent ID is not representable.",
    );
  }
  return normalized.value;
}

function assertSecretName(name: string): void {
  if (!ENV_SECRET_REF_ID_RE.test(name)) {
    throw new AgentSecretAssignmentValidationError(
      "AGENT_SECRET_ASSIGNMENT_INVALID_SECRET_NAME",
      `Secret name must match ${String(ENV_SECRET_REF_ID_RE)}.`,
    );
  }
}

function normalizeProviderHint(providerHint: string | null | undefined): string | null {
  if (providerHint == null) {
    return null;
  }
  const normalized = providerHint.trim().toLowerCase();
  if (!SECRET_PROVIDER_ALIAS_PATTERN.test(normalized)) {
    throw new AgentSecretAssignmentValidationError(
      "AGENT_SECRET_ASSIGNMENT_INVALID_PROVIDER_HINT",
      `Provider hint must match ${String(SECRET_PROVIDER_ALIAS_PATTERN)}.`,
    );
  }
  return normalized;
}

function isMissingAssignmentTableError(error: unknown): boolean {
  return (
    error instanceof Error &&
    hasErrnoCode(error, "ERR_SQLITE_ERROR") &&
    error.message === "no such table: agent_secret_assignments"
  );
}

/** Lists exact assignment names for one validated agent, with no provider or value metadata. */
export function listAgentSecretAssignments(params: {
  agentId: string;
  database?: OpenClawStateDatabaseOptions;
}): string[] {
  const agentId = normalizeStrictAgentId(params.agentId);
  try {
    return (
      withExistingOpenClawStateDatabaseReadOnly(({ db: sqlite }) => {
        const db = getNodeSqliteKysely<AssignmentDatabase>(sqlite);
        return executeSqliteQuerySync(
          sqlite,
          db
            .selectFrom("agent_secret_assignments")
            .select("secret_name")
            .where("agent_id", "=", agentId)
            .orderBy("secret_name", "asc"),
        ).rows.map((row) => row.secret_name);
      }, params.database ?? {}) ?? []
    );
  } catch (error) {
    if (isMissingAssignmentTableError(error)) {
      return [];
    }
    throw error;
  }
}

/** Counts one validated agent's assignments without transferring any names. */
export function countAgentSecretAssignments(params: {
  agentId: string;
  database?: OpenClawStateDatabaseOptions;
}): number {
  const agentId = normalizeStrictAgentId(params.agentId);
  try {
    return (
      withExistingOpenClawStateDatabaseReadOnly(({ db: sqlite }) => {
        const db = getNodeSqliteKysely<AssignmentDatabase>(sqlite);
        const row = executeSqliteQuerySync(
          sqlite,
          db
            .selectFrom("agent_secret_assignments")
            .select((expression) => expression.fn.countAll<number>().as("count"))
            .where("agent_id", "=", agentId),
        ).rows[0];
        return Number(row?.count ?? 0);
      }, params.database ?? {}) ?? 0
    );
  } catch (error) {
    if (isMissingAssignmentTableError(error)) {
      return 0;
    }
    throw error;
  }
}

/**
 * Operator/admin paged inventory over all agents' assignments. The cursor is
 * the last (agentId, secretName) pair of the previous page; ordering is
 * stable. Presentation is bounded by the page size only — authorization never
 * truncates, and `nextCursor` is returned whenever more rows remain.
 */
export function listAgentSecretAssignmentsAdmin(params: {
  cursor?: string;
  database?: OpenClawStateDatabaseOptions;
}): {
  assignments: Array<{ agentId: string; names: string[] }>;
  nextCursor?: string;
} {
  let cursorAgentId: string | null = null;
  let cursorSecretName: string | null = null;
  if (params.cursor !== undefined) {
    const separator = params.cursor.indexOf("|");
    if (separator <= 0 || separator === params.cursor.length - 1) {
      throw new AgentSecretAssignmentValidationError(
        "AGENT_SECRET_ASSIGNMENT_INVALID_AGENT_ID",
        'Assignment inventory cursor must be "<agentId>|<secretName>".',
      );
    }
    let normalizedAgentId: string;
    try {
      normalizedAgentId = normalizeStrictAgentId(params.cursor.slice(0, separator));
    } catch (error) {
      if (error instanceof AgentSecretAssignmentValidationError) {
        throw new AgentSecretAssignmentValidationError(
          "AGENT_SECRET_ASSIGNMENT_INVALID_AGENT_ID",
          'Assignment inventory cursor must be "<agentId>|<secretName>".',
        );
      }
      throw error;
    }
    cursorAgentId = normalizedAgentId;
    cursorSecretName = params.cursor.slice(separator + 1);
    assertSecretName(cursorSecretName);
  }
  try {
    const rows =
      withExistingOpenClawStateDatabaseReadOnly(({ db: sqlite }) => {
        const db = getNodeSqliteKysely<AssignmentDatabase>(sqlite);
        let query = db
          .selectFrom("agent_secret_assignments")
          .selectAll()
          .orderBy("agent_id", "asc")
          .orderBy("secret_name", "asc")
          .limit(AGENT_SECRET_ASSIGNMENTS_PAGE_SIZE + 1);
        if (cursorAgentId !== null && cursorSecretName !== null) {
          query = query.where(({ eb, refTuple, tuple }) =>
            eb(refTuple("agent_id", "secret_name"), ">", tuple(cursorAgentId, cursorSecretName)),
          );
        }
        return executeSqliteQuerySync(sqlite, query).rows;
      }, params.database ?? {}) ?? [];
    const hasMore = rows.length > AGENT_SECRET_ASSIGNMENTS_PAGE_SIZE;
    const page = hasMore ? rows.slice(0, AGENT_SECRET_ASSIGNMENTS_PAGE_SIZE) : rows;
    const grouped = new Map<string, string[]>();
    for (const row of page) {
      const names = grouped.get(row.agent_id) ?? [];
      names.push(row.secret_name);
      grouped.set(row.agent_id, names);
    }
    const last = page[page.length - 1];
    return {
      assignments: [...grouped.entries()].map(([agentId, names]) => ({ agentId, names })),
      ...(hasMore && last ? { nextCursor: `${last.agent_id}|${last.secret_name}` } : {}),
    };
  } catch (error) {
    if (isMissingAssignmentTableError(error)) {
      return { assignments: [] };
    }
    throw error;
  }
}

/** Checks one exact assignment using the same response path for present and absent rows. */
export function hasAgentSecretAssignment(params: {
  agentId: string;
  secretName: string;
  database?: OpenClawStateDatabaseOptions;
}): boolean {
  const agentId = normalizeStrictAgentId(params.agentId);
  assertSecretName(params.secretName);
  try {
    return (
      withExistingOpenClawStateDatabaseReadOnly(({ db: sqlite }) => {
        const db = getNodeSqliteKysely<AssignmentDatabase>(sqlite);
        return (
          executeSqliteQuerySync(
            sqlite,
            db
              .selectFrom("agent_secret_assignments")
              .select("secret_name")
              .where("agent_id", "=", agentId)
              .where("secret_name", "=", params.secretName)
              .limit(1),
          ).rows.length === 1
        );
      }, params.database ?? {}) ?? false
    );
  } catch (error) {
    if (isMissingAssignmentTableError(error)) {
      return false;
    }
    throw error;
  }
}

/** Creates or replaces metadata for one assignment. No secret value is accepted. */
export function writeAgentSecretAssignment(params: {
  agentId: string;
  secretName: string;
  providerHint?: string | null;
  assignedBy?: string | null;
  database?: OpenClawStateDatabaseOptions;
}): void {
  const agentId = normalizeStrictAgentId(params.agentId);
  assertSecretName(params.secretName);
  const providerHint = normalizeProviderHint(params.providerHint);
  const assignedBy = params.assignedBy?.trim() || null;
  if (assignedBy && assignedBy.length > 128) {
    throw new RangeError("Assignment actor must be at most 128 characters.");
  }
  const now = Date.now();
  runOpenClawStateWriteTransaction(
    ({ db: sqlite }) => {
      ensureAgentSecretAssignmentSchema(sqlite);
      const db = getNodeSqliteKysely<AssignmentDatabase>(sqlite);
      executeSqliteQuerySync(
        sqlite,
        db
          .insertInto("agent_secret_assignments")
          .values({
            agent_id: agentId,
            secret_name: params.secretName,
            provider_hint: providerHint,
            created_at_ms: now,
            assigned_by: assignedBy,
          })
          .onConflict((conflict) =>
            conflict.columns(["agent_id", "secret_name"]).doUpdateSet({
              provider_hint: providerHint,
              created_at_ms: now,
              assigned_by: assignedBy,
            }),
          ),
      );
    },
    params.database,
    { operationLabel: "secrets.assignments.write" },
  );
}

/** Removes one exact assignment. Missing assignments are an idempotent success. */
export function deleteAgentSecretAssignment(params: {
  agentId: string;
  secretName: string;
  database?: OpenClawStateDatabaseOptions;
}): void {
  const agentId = normalizeStrictAgentId(params.agentId);
  assertSecretName(params.secretName);
  runOpenClawStateWriteTransaction(
    ({ db: sqlite }) => {
      ensureAgentSecretAssignmentSchema(sqlite);
      const db = getNodeSqliteKysely<AssignmentDatabase>(sqlite);
      executeSqliteQuerySync(
        sqlite,
        db
          .deleteFrom("agent_secret_assignments")
          .where("agent_id", "=", agentId)
          .where("secret_name", "=", params.secretName),
      );
    },
    params.database,
    { operationLabel: "secrets.assignments.delete" },
  );
}
