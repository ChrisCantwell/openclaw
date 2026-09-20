/**
 * Secret-assignment broker plugin.
 *
 * Owns per-agent assignment policy for the exec secret-store projection and
 * exposes operator/self-gateway RPCs. It enforces through the core
 * `secret_env_authorize` hook, which runs after secret resolution and before
 * the executable environment snapshot. That hook sees entry NAMES and kinds
 * only — never values — and handlers can only ever narrow the projection.
 *
 * Identity for self RPCs is derived from the authenticated client context
 * (`client.internal.agentRuntimeIdentity.agentId`); it is never caller-supplied.
 */
import {
  ErrorCodes,
  errorShape,
  type GatewayRequestHandlerOptions,
} from "openclaw/plugin-sdk/gateway-runtime";
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  allowedNamesForCandidate,
  applyAssignmentEdit,
  EMPTY_ASSIGNMENT,
  type AgentAssignmentMode,
} from "./src/assignments.js";
import { createKeyedAssignmentStore, type AssignmentStore } from "./src/store.js";

const NAMESPACE = "agent-assignments";

/** Resolves the authenticated agent id from the connection, never from params. */
function authenticatedAgentId(options: GatewayRequestHandlerOptions): string | undefined {
  return options.client?.internal?.agentRuntimeIdentity?.agentId?.trim() || undefined;
}

/** Wraps a handler body with consistent success/error responses. */
async function handle(
  options: GatewayRequestHandlerOptions,
  run: () => Promise<unknown>,
): Promise<void> {
  try {
    options.respond(true, await run());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, message));
  }
}

/** Builds the assignment store backed by the host keyed store. */
function createStore(api: OpenClawPluginApi): AssignmentStore {
  const keyed = api.runtime.state.openKeyedStore<unknown>({
    namespace: NAMESPACE,
    maxEntries: 10_000,
  });
  return createKeyedAssignmentStore(keyed);
}

export default definePluginEntry({
  id: "secret-assignment-broker",
  name: "Secret assignment broker",
  description: "Per-agent assignment policy for the exec secret-store projection.",
  register(api) {
    let store: AssignmentStore | undefined;
    const getStore = () => (store ??= createStore(api));

    // Core enforcement seam: narrow the resolved projection to the agent's
    // assignment. Names only; the seam withholds anything not returned.
    api.on("secret_env_authorize", async (event, ctx) => {
      const agentId = ctx.agentId?.trim();
      if (!agentId) {
        // No identity: authorize nothing. The seam withholds every entry.
        return { allowedNames: [] };
      }
      const assignment = await getStore().get(agentId);
      return {
        allowedNames: allowedNamesForCandidate({ assignment, candidates: event.candidates }),
      };
    });

    // Self-only inventory: the agent sees only its own assignment.
    api.registerGatewayMethod(
      "secrets.assignments.broker.self",
      (options: GatewayRequestHandlerOptions) =>
        handle(options, async () => {
          const agentId = authenticatedAgentId(options);
          if (!agentId) {
            return { agentId: null, assignment: EMPTY_ASSIGNMENT };
          }
          return { agentId, assignment: await getStore().get(agentId) };
        }),
      { scope: "operator.read" },
    );

    // Operator-admin: explicit agent ids, never derived from runtime context.
    api.registerGatewayMethod(
      "secrets.assignments.broker.list",
      (options: GatewayRequestHandlerOptions) =>
        handle(options, async () => ({ entries: await getStore().entries() })),
      { scope: "operator.admin" },
    );

    api.registerGatewayMethod(
      "secrets.assignments.broker.set",
      (options: GatewayRequestHandlerOptions) =>
        handle(options, async () => {
          const agentId = normalizeOptionalString(options.params.agentId);
          const rawMode = normalizeOptionalString(options.params.mode);
          if (!agentId || (rawMode !== "all" && rawMode !== "selected" && rawMode !== "none")) {
            throw new Error("agentId and mode (none|selected|all) are required");
          }
          const mode: AgentAssignmentMode = rawMode;
          const rawNames = options.params.names;
          const names = Array.isArray(rawNames)
            ? rawNames.filter((name): name is string => typeof name === "string")
            : [];
          const assignment = applyAssignmentEdit({ mode, names });
          await getStore().set(agentId, assignment);
          return { agentId, assignment };
        }),
      { scope: "operator.admin" },
    );
  },
});
