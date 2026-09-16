// Operator-admin agent secret-assignment management for the Control UI.
//
// These functions call the dedicated `secrets.assignments.admin.*` /
// `secrets.assignments.enforcement.*` Gateway methods: separate, explicitly
// operator-admin-scoped RPCs with explicit agentId parameters. They never
// reuse the model-facing self-only assignment RPCs, which derive scope from
// runtime identity and accept no agent selector. No secret values cross
// either boundary.
import type { SecretStoreEntry } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { formatUiError } from "../format-error.ts";

export type AssignmentAdminEntry = { agentId: string; names: string[] };

export type AssignmentsAdminState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  assignments: AssignmentAdminEntry[];
  nextCursor: string | null;
  loaded: boolean;
  loading: boolean;
  busy: boolean;
  error: string | null;
};

export type EnforcementMode = "off" | "advisory" | "enforce";

export type EnforcementState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  mode: EnforcementMode;
  loaded: boolean;
  busy: boolean;
  error: string | null;
};

export function createInitialAssignmentsAdminState(
  snapshot: Partial<Pick<AssignmentsAdminState, "client" | "connected">> = {},
): AssignmentsAdminState {
  return {
    client: snapshot.client ?? null,
    connected: snapshot.connected ?? false,
    assignments: [],
    nextCursor: null,
    loaded: false,
    loading: false,
    busy: false,
    error: null,
  };
}

export function createInitialEnforcementState(
  snapshot: Partial<Pick<EnforcementState, "client" | "connected">> = {},
): EnforcementState {
  return {
    client: snapshot.client ?? null,
    connected: snapshot.connected ?? false,
    mode: "off",
    loaded: false,
    busy: false,
    error: null,
  };
}

type AdminListResult = {
  assignments: AssignmentAdminEntry[];
  nextCursor?: string;
};

type AdminMutationResult = { ok: true };

type EnforcementGetResult = { mode: EnforcementMode };
type EnforcementSetResult = { ok: true; mode: EnforcementMode };

export async function loadAssignmentsAdmin(
  state: AssignmentsAdminState,
  options?: { append?: boolean; cursor?: string },
): Promise<boolean> {
  const client = state.client;
  if (!client || !state.connected || state.loading) {
    return false;
  }
  state.loading = true;
  state.error = null;
  try {
    const params = options?.cursor ? { cursor: options.cursor } : {};
    const result = await client.request<AdminListResult>("secrets.assignments.admin.list", params);
    if (state.client === client && state.connected) {
      state.assignments = options?.append
        ? // Append pages grouped by agent: a later page continues an earlier
          // group rather than splitting one agent into duplicate rows.
          mergeAssignmentGroups(state.assignments, result.assignments)
        : result.assignments;
      state.nextCursor = result.nextCursor ?? null;
      state.loaded = true;
      return true;
    }
    return false;
  } catch (error) {
    if (state.client === client) {
      state.error = formatUiError(error);
    }
    return false;
  } finally {
    if (state.client === client) {
      state.loading = false;
    }
  }
}

function mergeAssignmentGroups(
  existing: AssignmentAdminEntry[],
  incoming: AssignmentAdminEntry[],
): AssignmentAdminEntry[] {
  const merged = new Map(existing.map((entry) => [entry.agentId, [...entry.names]]));
  for (const group of incoming) {
    const names = merged.get(group.agentId);
    merged.set(group.agentId, [...(names ?? []), ...group.names]);
  }
  return [...merged.entries()].map(([agentId, names]) => ({ agentId, names }));
}

/**
 * Loads every assignment page up front: legacy/deleted agent ids beyond the
 * first table page must still reach the picker's leftover-ids section, so
 * dropdown discovery cannot depend on how much of the table the operator has
 * paged through. The "Load more" control stays for presentation; selection
 * never waits on it.
 */
export async function loadAllAssignmentsAdmin(
  state: AssignmentsAdminState,
  options?: { cursor?: string },
): Promise<boolean> {
  const client = state.client;
  if (!client || !state.connected || state.loading) {
    return false;
  }
  const first = await loadAssignmentsAdmin(
    state,
    options?.cursor ? { cursor: options.cursor, append: true } : undefined,
  );
  if (!first) {
    return false;
  }
  // Follow the cursor to exhaustion; page size is presentation-bounded, so
  // this terminates in bounded rounds for any real inventory.
  while (state.nextCursor && state.client === client) {
    const more = await loadAssignmentsAdmin(state, { cursor: state.nextCursor, append: true });
    if (!more) {
      break;
    }
  }
  return true;
}

async function mutateAssignments(
  state: AssignmentsAdminState,
  mutate: (client: GatewayBrowserClient) => Promise<unknown>,
): Promise<boolean> {
  const client = state.client;
  if (!client || !state.connected || state.busy) {
    return false;
  }
  state.busy = true;
  state.error = null;
  try {
    await mutate(client);
    await loadAssignmentsAdmin(state, { append: false });
    return true;
  } catch (error) {
    if (state.client === client) {
      state.error = formatUiError(error);
    }
    return false;
  } finally {
    if (state.client === client) {
      state.busy = false;
    }
  }
}

export function assignSecretName(
  state: AssignmentsAdminState,
  agentId: string,
  name: string,
): Promise<boolean> {
  return mutateAssignments(state, (client) =>
    client.request<AdminMutationResult>("secrets.assignments.admin.assign", {
      agentId,
      name,
    }),
  );
}

export function unassignSecretName(
  state: AssignmentsAdminState,
  agentId: string,
  name: string,
): Promise<boolean> {
  return mutateAssignments(state, (client) =>
    client.request<AdminMutationResult>("secrets.assignments.admin.unassign", {
      agentId,
      name,
    }),
  );
}

export async function loadEnforcementMode(state: EnforcementState): Promise<boolean> {
  const client = state.client;
  if (!client || !state.connected || state.busy) {
    return false;
  }
  state.busy = true;
  state.error = null;
  try {
    const result = await client.request<EnforcementGetResult>(
      "secrets.assignments.enforcement.get",
      {},
    );
    if (state.client === client && state.connected) {
      state.mode = result.mode;
      state.loaded = true;
      return true;
    }
    return false;
  } catch (error) {
    if (state.client === client) {
      state.error = formatUiError(error);
    }
    return false;
  } finally {
    if (state.client === client) {
      state.busy = false;
    }
  }
}

/**
 * Applies an enforcement mode. Resolves with the backend-confirmed mode on
 * success (verified live runtime state, never a request echo) or `null` on
 * failure, recording the error in `state.error`. Success and error feedback
 * are separate channels: callers must never render an error as a success.
 */
export async function setEnforcementMode(
  state: EnforcementState,
  mode: EnforcementMode,
): Promise<EnforcementMode | null> {
  const client = state.client;
  if (!client || !state.connected || state.busy) {
    return null;
  }
  state.busy = true;
  state.error = null;
  try {
    // The backend confirms only after an awaited durable persist AND a live
    // runtime read observing the requested mode (bounded, condition-based),
    // so a successful result here is verified state, not a request echo.
    const result = await client.request<EnforcementSetResult>(
      "secrets.assignments.enforcement.set",
      { mode },
    );
    if (state.client === client && state.connected) {
      state.mode = result.mode;
      state.loaded = true;
      return result.mode;
    }
    return null;
  } catch (error) {
    if (state.client === client) {
      state.error = formatUiError(error);
    }
    return null;
  } finally {
    if (state.client === client) {
      state.busy = false;
    }
  }
}

/** Flat selectable list of every store entry name for the picker. */
export function storeEntryNames(entries: SecretStoreEntry[]): string[] {
  return entries.map((entry) => entry.name);
}

/** All agent ids seen across assignment groups. */
export function assignmentAgentIds(assignments: AssignmentAdminEntry[]): string[] {
  return [...new Set(assignments.map((entry) => entry.agentId))].toSorted();
}
