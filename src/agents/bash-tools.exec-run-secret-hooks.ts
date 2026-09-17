import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SecretStoreExecEnvironment } from "../secrets/store/secret-store-shared.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import {
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
