import type { AgentSecretAssignmentEnforcement } from "../../secrets/store/secret-store.js";
// Bounded, condition-based confirmation that the live runtime config source
// observes a requested agent secret-assignment enforcement mode after a
// durable config persist.
//
// The durable write (`mutateConfigFileWithRetry` with `afterWrite: auto`)
// resolves when the config file is committed and the runtime refresh has been
// driven, but the runtime snapshot observer can apply slightly later (a real
// gateway run observed the refresh landing ~0.85s after persist). Callers
// must therefore wait — bounded, without a blind sleep — until the same live
// source `secrets.assignments.enforcement.get` reads reports the requested
// mode before confirming success, while still failing truthfully on
// timeout or a superseding change.
import { sleep } from "../../utils/sleep.js";

export type EnforcementObservationStatus = "observed" | "timeout" | "superseded";

export type EnforcementObservationResult = {
  status: EnforcementObservationStatus;
  /** Last mode observed from the live runtime source. */
  mode: AgentSecretAssignmentEnforcement;
};

const ENFORCEMENT_OBSERVATION_POLL_INTERVAL_MS = 25;

/** Default confirmation deadline for enforcement.set runtime observation. */
export const DEFAULT_ENFORCEMENT_OBSERVATION_TIMEOUT_MS = 5_000;

/** Resolves the confirmation deadline, allowing an explicit override (tests, narrow deployments). */
export function resolveEnforcementObservationTimeoutMs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Confirms a persisted enforcement mode against the live runtime source.
 * Throws a descriptive error on timeout or a superseding third mode; returns
 * the observed mode on success.
 */
export async function confirmEnforcementObservation(params: {
  requested: AgentSecretAssignmentEnforcement;
  preWrite: AgentSecretAssignmentEnforcement;
  read: () => AgentSecretAssignmentEnforcement;
  timeoutMs?: number;
}): Promise<AgentSecretAssignmentEnforcement> {
  const observation = await waitForEnforcementObservation(params);
  if (observation.status === "observed") {
    return observation.mode;
  }
  throw new Error(
    observation.status === "superseded"
      ? `runtime now reports "${observation.mode}" from a superseding change after persisting "${params.requested}".`
      : `runtime still reports "${observation.mode}" after the confirmation deadline for "${params.requested}".`,
  );
}

/**
 * Poll the live runtime enforcement source until it observes `requested`, the
 * pre-write mode is replaced by `requested`, or the deadline expires.
 *
 * - `observed`: the requested mode is live; safe to confirm.
 * - `timeout`: the mode never landed within the deadline; fail truthfully.
 * - `superseded`: the runtime moved to a third mode (neither the pre-write
 *   value nor the requested one); another writer won — fail immediately
 *   instead of waiting out the deadline against a lost race.
 */
export async function waitForEnforcementObservation(params: {
  requested: AgentSecretAssignmentEnforcement;
  /** Mode observed before the durable write; the expected "not yet applied" value. */
  preWrite: AgentSecretAssignmentEnforcement;
  /** Authoritative live read; the same primitive `enforcement.get` uses. */
  read: () => AgentSecretAssignmentEnforcement;
  timeoutMs?: number;
}): Promise<EnforcementObservationResult> {
  const timeoutMs = params.timeoutMs ?? DEFAULT_ENFORCEMENT_OBSERVATION_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const observed = params.read();
    if (observed === params.requested) {
      return { status: "observed", mode: observed };
    }
    if (observed !== params.preWrite) {
      // Neither the pre-write value nor the requested one: a superseding
      // mutation owns the runtime now. Waiting longer cannot help.
      return { status: "superseded", mode: observed };
    }
    if (Date.now() >= deadline) {
      return { status: "timeout", mode: observed };
    }
    await sleep(ENFORCEMENT_OBSERVATION_POLL_INTERVAL_MS);
  }
}
