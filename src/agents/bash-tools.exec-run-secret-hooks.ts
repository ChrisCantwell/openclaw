import type { OpenClawConfig } from "../config/types.openclaw.js";
import { registerSecretEgressProxyRun } from "../secrets/egress-proxy/registry.js";
import { revalidateAssignedSecretNames } from "../secrets/exec-store-snapshot.js";
import type { SecretStoreExecEnvironment } from "../secrets/store/secret-store-shared.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import {
  armSecretEgressForLaunch,
  buildPreSpawnSecretAuthorityRecheck,
  type GatewayRevalidateBeforeExecution,
} from "./bash-tools.exec-secret-authority.js";
import type { ExecToolDetails } from "./bash-tools.exec-types.js";
import type { AgentToolResult } from "./runtime/index.js";

export type ExecRunSecretAuthority = {
  agentId?: string;
  config?: OpenClawConfig;
  database?: OpenClawStateDatabaseOptions;
};

/** Shared secret-authority context + pre-spawn recheck builder for createExecTool. */
export function createExecRunSecretHooks(params: {
  agentId?: string;
  config?: OpenClawConfig;
  database?: OpenClawStateDatabaseOptions;
  cwd: string | undefined;
  secretEgressEnabled: boolean;
  resolveStoreEnv: () => Promise<SecretStoreExecEnvironment>;
}): {
  authority: ExecRunSecretAuthority;
  buildRecheck: (
    gatewayRevalidate?: GatewayRevalidateBeforeExecution,
  ) => (() => Promise<AgentToolResult<ExecToolDetails> | undefined>) | undefined;
} {
  const authority: ExecRunSecretAuthority = {
    agentId: params.agentId,
    config: params.config,
    database: params.database,
  };
  return {
    authority,
    buildRecheck: (gatewayRevalidate) =>
      buildPreSpawnSecretAuthorityRecheck({
        gatewayRevalidate,
        secretEgressEnabled: params.secretEgressEnabled,
        resolveStoreEnv: params.resolveStoreEnv,
        ...authority,
        cwd: params.cwd,
      }),
  };
}

/**
 * Resolves the store snapshot and arms protected egress for one gateway launch.
 * Extracted from createExecTool so bash-tools.exec-run.ts stays under its line cap.
 */
export async function armSecretEgressForLaunchFromHooks(params: {
  secretEgressEnabled: boolean;
  host: string;
  resolveStoreEnv: () => Promise<SecretStoreExecEnvironment>;
  operationalRunInstance: Readonly<{ instanceId: string; runId: string }> | undefined;
  authority: ExecRunSecretAuthority;
  cwd: string | undefined;
}): Promise<{
  storeEnv: SecretStoreExecEnvironment;
  useSecretEgress: boolean;
  secretEgressEnv: Record<string, string> | undefined;
}> {
  const storeEnv = await params.resolveStoreEnv();
  // Egress proxy is loopback-owned; sandbox/node hosts get no sentinels.
  const useSecretEgress = params.secretEgressEnabled && params.host === "gateway";
  const secretEgressEnv = await armSecretEgressForLaunch({
    enabled: useSecretEgress,
    storeEnv,
    operationalRunInstance: params.operationalRunInstance,
    ...params.authority,
    cwd: params.cwd,
    registerRun: registerSecretEgressProxyRun,
    revalidate: revalidateAssignedSecretNames,
  });
  return { storeEnv, useSecretEgress, secretEgressEnv };
}
