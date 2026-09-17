// Secrets gateway methods reload runtime secret snapshots and resolve scoped
// command secrets while redacting validation detail to caller-friendly fields.
import {
  ErrorCodes,
  errorShape,
  type ValidationError,
  validateSecretsAssignmentsHasParams,
  validateSecretsAssignmentsHasResult,
  validateSecretsAssignmentsEntryParams,
  validateSecretsAssignmentsEntryResult,
  validateSecretsAssignmentsAdminAssignParams,
  validateSecretsAssignmentsAdminListParams,
  validateSecretsAssignmentsAdminListResult,
  validateSecretsAssignmentsAdminMutationResult,
  validateSecretsAssignmentsAdminUnassignParams,
  type SecretsAssignmentsEntry,
  validateSecretsAssignmentsListParams,
  validateSecretsAssignmentsListResult,
  validateSecretsResolveParams,
  validateSecretsResolveResult,
  validateSecretsStoreDeleteParams,
  validateSecretsStoreListParams,
  validateSecretsStoreListResult,
  validateSecretsStoreMutationResult,
  validateSecretsStoreSetParams,
  type SecretStoreEntry,
} from "../../../packages/gateway-protocol/src/index.js";
import { formatErrorMessage as errorMessage } from "../../infra/errors.js";
import {
  AgentSecretAssignmentValidationError,
  deleteAgentSecretAssignment,
  listAgentSecretAssignmentsAdmin,
  writeAgentSecretAssignment,
} from "../../secrets/assignment-store.js";
import {
  hasEffectiveAgentSecretAccess,
  listEffectiveAgentSecretNames,
} from "../../secrets/store/secret-store-agent-access.js";
import {
  deleteSecretStoreEntry,
  getSecretStoreEntryMetadata,
  listSecretStoreEntries,
  SecretStoreValidationError,
  type SecretStoreEntryMetadata,
} from "../../secrets/store/secret-store.js";
import { isKnownCoreSecretTargetId, isKnownSecretTargetId } from "../../secrets/target-registry.js";
import { holdGatewayPolicyResponse } from "../server/ws-policy-close.js";
import { createAgentRuntimeAuthorityGuard } from "./agent-runtime-authority.js";
import { createEnforcementHandlers, type EnforcementConfigAccess } from "./enforcement-handlers.js";
import {
  storeUpdatedBy,
  type SecretStoreLogger,
  type SecretStoreReload,
  type SecretStoreWriteService,
} from "./secrets-store-write-service.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

const teamScope = { kind: "team" } as const;

/**
 * Model-visible inventory window, independent from operator-admin pagination
 * and from any authorization decision. Nothing authorized is ever treated as
 * absent: `total` and `truncated` disclose the remainder.
 */
const AGENT_SECRET_ASSIGNMENTS_WINDOW_MAX = 512;

/** Strips env plaintext from store metadata before any agent-scoped response. */
function toValueFreeEntryMetadata(
  entry: SecretStoreEntryMetadata | null,
): SecretsAssignmentsEntry | null {
  if (!entry) {
    return null;
  }
  // Team scope is a server-side fact of this read; narrow before mapping.
  const scope = {
    name: entry.name,
    scopeKind: "team",
    scopeId: "",
    kind: entry.kind,
    audience: entry.audience,
    createdAtMs: entry.createdAtMs,
    updatedAtMs: entry.updatedAtMs,
    ...(entry.updatedBy ? { updatedBy: entry.updatedBy } : {}),
  } as const;
  if (entry.kind === "env") {
    return scope;
  }
  return { ...scope, allowedHosts: entry.allowedHosts ?? [] };
}

function toProtocolStoreEntry(
  entry: ReturnType<typeof listSecretStoreEntries>[number],
): SecretStoreEntry {
  const metadata = {
    name: entry.name,
    scopeKind: "team" as const,
    scopeId: "" as const,
    audience: entry.audience,
    createdAtMs: entry.createdAtMs,
    updatedAtMs: entry.updatedAtMs,
    ...(entry.updatedBy ? { updatedBy: entry.updatedBy } : {}),
  };
  if (entry.kind === "env") {
    if (typeof entry.valuePreview !== "string") {
      throw new Error(`Secret store env metadata is missing its value for ${entry.name}.`);
    }
    return { ...metadata, kind: "env", value: entry.valuePreview };
  }
  return { ...metadata, kind: "secret", allowedHosts: entry.allowedHosts ?? [] };
}

function invalidSecretsResolveField(
  errors: ValidationError[] | null | undefined,
):
  | "allowedPaths"
  | "commandName"
  | "forcedActivePaths"
  | "optionalActivePaths"
  | "providerOverrides"
  | "targetIds" {
  // Return the offending top-level field only. Detailed validator output can
  // include paths and schema internals that are not useful for callers here.
  for (const issue of errors ?? []) {
    const instancePath = issue.instancePath ?? "";
    if (
      instancePath === "/commandName" ||
      (instancePath === "" &&
        (String(issue.params?.missingProperty) === "commandName" ||
          (Array.isArray(issue.params?.requiredProperties) &&
            issue.params.requiredProperties.includes("commandName"))))
    ) {
      return "commandName";
    }
    if (instancePath.startsWith("/allowedPaths")) {
      return "allowedPaths";
    }
    if (instancePath.startsWith("/forcedActivePaths")) {
      return "forcedActivePaths";
    }
    if (instancePath.startsWith("/optionalActivePaths")) {
      return "optionalActivePaths";
    }
    if (instancePath.startsWith("/providerOverrides")) {
      return "providerOverrides";
    }
  }
  return "targetIds";
}

export function createSecretsHandlers(params: {
  reloadSecrets: SecretStoreReload;
  storeWriteService: SecretStoreWriteService;
  /** Operator-config access for enforcement-mode administration. */
  configAccess: EnforcementConfigAccess;
  resolveSecrets: (params: {
    commandName: string;
    targetIds: string[];
    allowedPaths?: string[];
    forcedActivePaths?: string[];
    optionalActivePaths?: string[];
    providerOverrides?: {
      webSearch?: string;
      webFetch?: string;
    };
  }) => Promise<{
    assignments: Array<{
      path: string;
      pathSegments: string[];
      value: unknown;
    }>;
    diagnostics: string[];
    inactiveRefPaths: string[];
  }>;
  log?: SecretStoreLogger;
}): GatewayRequestHandlers {
  return {
    "secrets.reload": async ({ respond }) => {
      try {
        holdGatewayPolicyResponse(respond);
        const result = await params.reloadSecrets();
        respond(true, { ok: true, warningCount: result.warningCount });
      } catch (error) {
        params.log?.warn?.(`secrets.reload failed: ${errorMessage(error)}`);
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "secrets.reload failed"));
      }
    },
    "secrets.resolve": async ({ params: requestParams, respond }) => {
      if (!validateSecretsResolveParams(requestParams)) {
        const field = invalidSecretsResolveField(validateSecretsResolveParams.errors);
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `invalid secrets.resolve params: ${field}`),
        );
        return;
      }
      const commandName = requestParams.commandName.trim();
      if (!commandName) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "invalid secrets.resolve params: commandName"),
        );
        return;
      }
      const targetIds = requestParams.targetIds
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
      // Normalize allow/force/optional path lists before resolving so secrets
      // code receives policy paths, not UI whitespace artifacts.
      const allowedPaths = requestParams.allowedPaths
        ?.map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
      const forcedActivePaths = requestParams.forcedActivePaths
        ?.map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
      const optionalActivePaths = requestParams.optionalActivePaths
        ?.map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
      const providerOverrides = {
        ...(requestParams.providerOverrides?.webSearch?.trim()
          ? { webSearch: requestParams.providerOverrides.webSearch.trim() }
          : {}),
        ...(requestParams.providerOverrides?.webFetch?.trim()
          ? { webFetch: requestParams.providerOverrides.webFetch.trim() }
          : {}),
      };

      // Target ids are a closed registry. Reject unknown ids before resolving
      // so callers cannot probe arbitrary config paths through this method.
      for (const targetId of targetIds) {
        if (!isKnownCoreSecretTargetId(targetId) && !isKnownSecretTargetId(targetId)) {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              `invalid secrets.resolve params: unknown target id "${String(targetId)}"`,
            ),
          );
          return;
        }
      }

      try {
        const result = await params.resolveSecrets({
          commandName,
          targetIds,
          ...(allowedPaths ? { allowedPaths } : {}),
          ...(forcedActivePaths ? { forcedActivePaths } : {}),
          ...(optionalActivePaths ? { optionalActivePaths } : {}),
          ...(Object.keys(providerOverrides).length > 0 ? { providerOverrides } : {}),
        });
        const payload = {
          ok: true,
          assignments: result.assignments,
          diagnostics: result.diagnostics,
          inactiveRefPaths: result.inactiveRefPaths,
        };
        if (!validateSecretsResolveResult(payload)) {
          // Validate the returned shape as a final boundary check before any
          // secret assignment payload leaves the gateway.
          throw new Error("secrets.resolve returned invalid payload.");
        }
        respond(true, payload);
      } catch (error) {
        params.log?.warn?.(`secrets.resolve failed: ${errorMessage(error)}`);
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "secrets.resolve failed"));
      }
    },
    "secrets.store.list": ({ params: requestParams, respond }) => {
      if (
        !assertValidParams(
          requestParams,
          validateSecretsStoreListParams,
          "secrets.store.list",
          respond,
        )
      ) {
        return;
      }
      try {
        const result = {
          entries: listSecretStoreEntries({ scope: teamScope }).map(toProtocolStoreEntry),
        };
        if (!validateSecretsStoreListResult(result)) {
          throw new Error("secrets.store.list returned invalid payload.");
        }
        respond(true, result);
      } catch (error) {
        params.log?.warn?.(`secrets.store.list failed: ${errorMessage(error)}`);
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "secrets.store.list failed"));
      }
    },
    "secrets.assignments.list": ({ params: requestParams, respond, client, context }) => {
      if (
        !assertValidParams(
          requestParams,
          validateSecretsAssignmentsListParams,
          "secrets.assignments.list",
          respond,
        )
      ) {
        return;
      }
      const agentId = client?.internal?.agentRuntimeIdentity?.agentId;
      if (!agentId) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "agent runtime identity is required"),
        );
        return;
      }
      if (!createAgentRuntimeAuthorityGuard(client, context, respond).ensureActive()) {
        return;
      }
      try {
        // Effective access, not raw assignment rows: all-audience entries
        // keep legacy team-wide delivery, selected entries require an
        // explicit assignment for this runtime agent.
        const names = listEffectiveAgentSecretNames({ agentId });
        const total = names.length;
        // Presentation window: the full set is never silently hidden. `total`
        // plus `truncated` make incompleteness explicit; pagination is the
        // operator-admin method's concern, not a bound on authorization.
        const result = {
          names: names.slice(0, AGENT_SECRET_ASSIGNMENTS_WINDOW_MAX),
          total,
          truncated: total > AGENT_SECRET_ASSIGNMENTS_WINDOW_MAX,
        };
        if (!validateSecretsAssignmentsListResult(result)) {
          throw new Error("secrets.assignments.list returned invalid payload.");
        }
        respond(true, result);
      } catch (error) {
        params.log?.warn?.(`secrets.assignments.list failed: ${errorMessage(error)}`);
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, "secrets.assignments.list failed"),
        );
      }
    },
    "secrets.assignments.has": ({ params: requestParams, respond, client, context }) => {
      if (
        !assertValidParams(
          requestParams,
          validateSecretsAssignmentsHasParams,
          "secrets.assignments.has",
          respond,
        )
      ) {
        return;
      }
      const agentId = client?.internal?.agentRuntimeIdentity?.agentId;
      if (!agentId) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "agent runtime identity is required"),
        );
        return;
      }
      if (!createAgentRuntimeAuthorityGuard(client, context, respond).ensureActive()) {
        return;
      }
      try {
        // Effective access: all-audience entries are accessible to every
        // valid agent; selected entries require an explicit assignment row.
        const result = {
          assigned: hasEffectiveAgentSecretAccess({
            agentId,
            secretName: requestParams.name,
          }),
        };
        if (!validateSecretsAssignmentsHasResult(result)) {
          throw new Error("secrets.assignments.has returned invalid payload.");
        }
        respond(true, result);
      } catch (error) {
        params.log?.warn?.(`secrets.assignments.has failed: ${errorMessage(error)}`);
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, "secrets.assignments.has failed"),
        );
      }
    },
    // Name-scoped single-entry metadata read for the post-request tool flow.
    // Runtime-identity scoped server-side; one entry only, never the inventory.
    "secrets.assignments.entry": ({ params: requestParams, respond, client, context }) => {
      if (
        !assertValidParams(
          requestParams,
          validateSecretsAssignmentsEntryParams,
          "secrets.assignments.entry",
          respond,
        )
      ) {
        return;
      }
      const agentId = client?.internal?.agentRuntimeIdentity?.agentId;
      if (!agentId) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "agent runtime identity is required"),
        );
        return;
      }
      if (!createAgentRuntimeAuthorityGuard(client, context, respond).ensureActive()) {
        return;
      }
      try {
        const result = {
          entry: toValueFreeEntryMetadata(
            getSecretStoreEntryMetadata({
              scope: teamScope,
              name: requestParams.name,
            }),
          ),
        };
        if (!validateSecretsAssignmentsEntryResult(result)) {
          throw new Error("secrets.assignments.entry returned invalid payload.");
        }
        respond(true, result);
      } catch (error) {
        params.log?.warn?.(`secrets.assignments.entry failed: ${errorMessage(error)}`);
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, "secrets.assignments.entry failed"),
        );
      }
    },
    // Operator-admin assignment administration. Separate from the model-facing
    // self-only methods above: explicit agentId, operator.admin scope, no
    // runtime-identity derivation, no secret values.
    "secrets.assignments.admin.list": ({ params: requestParams, respond }) => {
      if (
        !assertValidParams(
          requestParams,
          validateSecretsAssignmentsAdminListParams,
          "secrets.assignments.admin.list",
          respond,
        )
      ) {
        return;
      }
      try {
        const result = listAgentSecretAssignmentsAdmin({
          cursor: requestParams.cursor,
        });
        if (!validateSecretsAssignmentsAdminListResult(result)) {
          throw new Error("secrets.assignments.admin.list returned invalid payload.");
        }
        respond(true, result);
      } catch (error) {
        if (error instanceof AgentSecretAssignmentValidationError) {
          respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, error.message));
          return;
        }
        params.log?.warn?.(`secrets.assignments.admin.list failed: ${errorMessage(error)}`);
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, "secrets.assignments.admin.list failed"),
        );
      }
    },
    "secrets.assignments.admin.assign": ({ params: requestParams, respond, client }) => {
      if (
        !assertValidParams(
          requestParams,
          validateSecretsAssignmentsAdminAssignParams,
          "secrets.assignments.admin.assign",
          respond,
        )
      ) {
        return;
      }
      try {
        writeAgentSecretAssignment({
          agentId: requestParams.agentId,
          secretName: requestParams.name,
          ...(requestParams.providerHint !== undefined
            ? { providerHint: requestParams.providerHint }
            : {}),
          assignedBy: storeUpdatedBy(client),
        });
        const result = { ok: true as const };
        if (!validateSecretsAssignmentsAdminMutationResult(result)) {
          throw new Error("secrets.assignments.admin.assign returned invalid payload.");
        }
        respond(true, result);
      } catch (error) {
        if (error instanceof AgentSecretAssignmentValidationError) {
          respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, error.message));
          return;
        }
        params.log?.warn?.(`secrets.assignments.admin.assign failed: ${errorMessage(error)}`);
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, "secrets.assignments.admin.assign failed"),
        );
      }
    },
    "secrets.assignments.admin.unassign": ({ params: requestParams, respond }) => {
      if (
        !assertValidParams(
          requestParams,
          validateSecretsAssignmentsAdminUnassignParams,
          "secrets.assignments.admin.unassign",
          respond,
        )
      ) {
        return;
      }
      try {
        deleteAgentSecretAssignment({
          agentId: requestParams.agentId,
          secretName: requestParams.name,
        });
        const result = { ok: true as const };
        if (!validateSecretsAssignmentsAdminMutationResult(result)) {
          throw new Error("secrets.assignments.admin.unassign returned invalid payload.");
        }
        respond(true, result);
      } catch (error) {
        if (error instanceof AgentSecretAssignmentValidationError) {
          respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, error.message));
          return;
        }
        params.log?.warn?.(`secrets.assignments.admin.unassign failed: ${errorMessage(error)}`);
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, "secrets.assignments.admin.unassign failed"),
        );
      }
    },
    ...createEnforcementHandlers({
      configAccess: params.configAccess,
      log: params.log,
    }),
    "secrets.store.set": async ({ params: requestParams, respond, client }) => {
      if (
        !assertValidParams(
          requestParams,
          validateSecretsStoreSetParams,
          "secrets.store.set",
          respond,
        )
      ) {
        return;
      }
      let saved = false;
      try {
        holdGatewayPolicyResponse(respond);
        if (
          requestParams.value === undefined &&
          requestParams.audience === undefined &&
          requestParams.allowedHosts === undefined
        ) {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              "secrets.store.set requires a value, or policy metadata for an existing entry.",
            ),
          );
          return;
        }
        params.storeWriteService.write({
          name: requestParams.name,
          kind: requestParams.kind,
          ...(requestParams.value !== undefined ? { value: requestParams.value } : {}),
          ...(requestParams.audience !== undefined ? { audience: requestParams.audience } : {}),
          ...(requestParams.allowedHosts !== undefined
            ? { allowedHosts: requestParams.allowedHosts }
            : {}),
          updatedBy: params.storeWriteService.resolveUpdatedBy(client),
        });
        saved = true;
        const reload = await params.storeWriteService.reloadReference(requestParams.name);
        const result = {
          ok: true as const,
          ...reload,
        };
        if (!validateSecretsStoreMutationResult(result)) {
          throw new Error("secrets.store.set returned invalid payload.");
        }
        respond(true, result);
      } catch (error) {
        if (!saved && error instanceof SecretStoreValidationError) {
          respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, error.message));
          return;
        }
        params.log?.warn?.(`secrets.store.set failed: ${errorMessage(error)}`);
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            saved
              ? "Secret store entry was saved, but post-write runtime refresh failed. Resolve provider errors and retry secrets.reload."
              : "secrets.store.set failed",
          ),
        );
      }
    },
    "secrets.store.delete": async ({ params: requestParams, respond, client, context }) => {
      if (
        !assertValidParams(
          requestParams,
          validateSecretsStoreDeleteParams,
          "secrets.store.delete",
          respond,
        )
      ) {
        return;
      }
      let deleted = false;
      try {
        const agentId = client?.internal?.agentRuntimeIdentity?.agentId;
        if (agentId) {
          params.log?.debug?.(`secrets.store.delete requested by agent:${agentId}`);
        }
        // Destructive control-plane mutations are operator work. The fence
        // reads the LIVE Gateway policy here, not a tool-construction-time
        // snapshot, so a model-facing tool created while enforcement was off
        // cannot delete after the operator enables any assignment mode.
        if (agentId && params.configAccess.readAgentAssignmentEnforcement() !== "off") {
          params.log?.debug?.(
            `secrets.store.delete refused for agent runtime while enforcement is active`,
          );
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              "delete is unavailable while agent assignment enforcement is enabled; ask the human operator to remove the store entry via CLI or Control UI.",
            ),
          );
          return;
        }
        if (!createAgentRuntimeAuthorityGuard(client, context, respond).ensureActive()) {
          return;
        }
        holdGatewayPolicyResponse(respond);
        deleteSecretStoreEntry({ scope: teamScope, name: requestParams.name });
        deleted = true;
        const reload = await params.storeWriteService.reloadReference(requestParams.name);
        const result = {
          ok: true as const,
          ...reload,
        };
        if (!validateSecretsStoreMutationResult(result)) {
          throw new Error("secrets.store.delete returned invalid payload.");
        }
        respond(true, result);
      } catch (error) {
        if (!deleted && error instanceof SecretStoreValidationError) {
          respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, error.message));
          return;
        }
        params.log?.warn?.(`secrets.store.delete failed: ${errorMessage(error)}`);
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            deleted
              ? "Secret store entry was deleted, but the active runtime could not refresh. Update the config reference or restore the entry, then retry secrets.reload."
              : "secrets.store.delete failed",
          ),
        );
      }
    },
  };
}
