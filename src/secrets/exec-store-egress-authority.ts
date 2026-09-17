import { resolveAgentConfig } from "../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeExactAllowedHost } from "./exact-hostname.js";
import { revalidateAssignedSecretNames } from "./exec-store-snapshot.js";
import type { readSecretStoreExecEnvironment } from "./store/secret-store-exec-environment.js";
import { getSecretStoreEntryMetadata } from "./store/secret-store.js";

/**
 * Re-reads the live authority and host policy for one registered sentinel.
 * A proxy registration carries process routing state only; it never retains
 * authorization after assignment, audience, agent-roster, or host-policy drift.
 */
export function revalidateSecretEgressBindingAtRequest(params: {
  name: string;
  host: string;
  agentId?: string;
  config?: OpenClawConfig;
  database?: Parameters<typeof readSecretStoreExecEnvironment>[0]["database"];
}): boolean {
  if (!params.agentId || (params.config && !resolveAgentConfig(params.config, params.agentId))) {
    return false;
  }
  if (!revalidateAssignedSecretNames({ ...params, names: [params.name] }).ok) {
    return false;
  }
  try {
    const entry = getSecretStoreEntryMetadata({
      scope: { kind: "team" },
      name: params.name,
      database: params.database,
    });
    return (
      entry?.kind === "secret" &&
      entry.allowedHosts?.includes(normalizeExactAllowedHost(params.host)) === true
    );
  } catch {
    return false;
  }
}
