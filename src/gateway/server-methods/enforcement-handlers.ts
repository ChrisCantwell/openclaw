// Operator-admin enforcement-mode gateway methods.
//
// `secrets.assignments.enforcement.get` reads the live runtime enforcement
// source. `secrets.assignments.enforcement.set` awaits a durable config
// persist and then confirms the mode against that same live source with a
// bounded, condition-based wait: the runtime snapshot observer can land
// shortly after the awaited mutation resolves (observed ~0.85s after persist
// in a live gateway), so confirmation never trusts an immediate read that
// races the observer, and never sleeps blindly.
import {
  ErrorCodes,
  errorShape,
  validateSecretsAssignmentsEnforcementGetParams,
  validateSecretsAssignmentsEnforcementGetResult,
  validateSecretsAssignmentsEnforcementSetParams,
  validateSecretsAssignmentsEnforcementSetResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { formatErrorMessage as errorMessage } from "../../infra/errors.js";
import { confirmEnforcementObservation } from "./enforcement-observation.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export type EnforcementConfigAccess = {
  readAgentAssignmentEnforcement: () => "off" | "advisory" | "enforce";
  /** Persists the enforcement mode durably; must await the config write. */
  writeAgentAssignmentEnforcement: (mode: "off" | "advisory" | "enforce") => Promise<void>;
  /** Optional bounded-confirmation deadline override (ms) for tests/narrow deployments. */
  enforcementObservationTimeoutMs?: number;
};

/** Enforcement-mode operator RPCs; share the caller's configAccess and log. */
export function createEnforcementHandlers(params: {
  configAccess: EnforcementConfigAccess;
  log?: { warn?: (message: string) => void };
}): Pick<
  GatewayRequestHandlers,
  "secrets.assignments.enforcement.get" | "secrets.assignments.enforcement.set"
> {
  return {
    "secrets.assignments.enforcement.get": ({ params: requestParams, respond }) => {
      if (
        !assertValidParams(
          requestParams,
          validateSecretsAssignmentsEnforcementGetParams,
          "secrets.assignments.enforcement.get",
          respond,
        )
      ) {
        return;
      }
      try {
        const result = { mode: params.configAccess.readAgentAssignmentEnforcement() };
        if (!validateSecretsAssignmentsEnforcementGetResult(result)) {
          throw new Error("secrets.assignments.enforcement.get returned invalid payload.");
        }
        respond(true, result);
      } catch (error) {
        params.log?.warn?.(`secrets.assignments.enforcement.get failed: ${errorMessage(error)}`);
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, "secrets.assignments.enforcement.get failed"),
        );
      }
    },
    "secrets.assignments.enforcement.set": async ({ params: requestParams, respond }) => {
      if (
        !assertValidParams(
          requestParams,
          validateSecretsAssignmentsEnforcementSetParams,
          "secrets.assignments.enforcement.set",
          respond,
        )
      ) {
        return;
      }
      try {
        // Capture the pre-write mode so the bounded confirmation can
        // distinguish "not yet applied" from a superseding third mode.
        const preWriteMode = params.configAccess.readAgentAssignmentEnforcement();
        await params.configAccess.writeAgentAssignmentEnforcement(requestParams.mode);
        const observedMode = await confirmEnforcementObservation({
          requested: requestParams.mode,
          preWrite: preWriteMode,
          read: () => params.configAccess.readAgentAssignmentEnforcement(),
          ...(params.configAccess.enforcementObservationTimeoutMs !== undefined
            ? { timeoutMs: params.configAccess.enforcementObservationTimeoutMs }
            : {}),
        });
        const result = { ok: true as const, mode: observedMode };
        if (!validateSecretsAssignmentsEnforcementSetResult(result)) {
          throw new Error("secrets.assignments.enforcement.set returned invalid payload.");
        }
        respond(true, result);
      } catch (error) {
        params.log?.warn?.(`secrets.assignments.enforcement.set failed: ${errorMessage(error)}`);
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, "secrets.assignments.enforcement.set failed"),
        );
      }
    },
  };
}
