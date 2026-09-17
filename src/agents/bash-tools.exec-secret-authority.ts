import type { OpenClawConfig } from "../config/types.openclaw.js";
import { revalidateSecretEgressBindingAtRequest } from "../secrets/exec-store-egress-authority.js";
import type { SecretStoreExecEnvironment } from "../secrets/store/secret-store-shared.js";
import type { ExecToolDetails } from "./bash-tools.exec-types.js";
import type { AgentToolResult } from "./runtime/index.js";

export type SecretAuthorityRevalidate = (params: {
  names: readonly string[];
  agentId?: string;
  config?: OpenClawConfig;
}) => { ok: true } | { ok: false; reason: string };

export type GatewayRevalidateBeforeExecution = () => Promise<
  AgentToolResult<ExecToolDetails> | undefined
>;

/**
 * Builds the pre-spawn hook composing gateway-approval revalidation with a
 * live secret-store authority recheck. Runs immediately before every process
 * spawn (including after an approval wait), so an assignment revoked while
 * the approval was pending denies the launch instead of arming a stale
 * permission snapshot. Returns undefined when neither revalidation applies.
 */
export function buildPreSpawnSecretAuthorityRecheck(params: {
  gatewayRevalidate: GatewayRevalidateBeforeExecution | undefined;
  secretEgressEnabled: boolean;
  resolveStoreEnv: () => Promise<SecretStoreExecEnvironment>;
  agentId?: string;
  config?: OpenClawConfig;
  cwd: string | undefined;
}): (() => Promise<AgentToolResult<ExecToolDetails> | undefined>) | undefined {
  const { gatewayRevalidate } = params;
  return async () => {
    const denied = await gatewayRevalidate?.();
    if (denied) {
      return denied;
    }
    const storeEnv = await params.resolveStoreEnv();
    const { revalidateAssignedSecretNames } = await import("../secrets/exec-store-snapshot.js");
    try {
      await assertSecretAuthorityForLaunch({
        storeEnv,
        agentId: params.agentId,
        config: params.config,
        cwd: params.cwd,
        revalidate: revalidateAssignedSecretNames,
      });
      return undefined;
    } catch (error) {
      return (await import("./bash-tools.exec-runtime.js")).ExecProcessPreflightError.unwrap(error);
    }
  };
}

/** Generic safe denial text: no store shape, no assignment existence, no names. */
export function buildSecretAuthorityDeniedResult(
  reason: string,
  cwd: string | undefined,
): AgentToolResult<ExecToolDetails> {
  const text = `Exec denied (${reason}).`;
  return {
    content: [{ type: "text", text }],
    details: {
      status: "failed",
      exitCode: null,
      durationMs: 0,
      aggregated: text,
      timedOut: false,
      cwd,
    },
  } as never;
}

/**
 * Revalidates current secret-store authority for the projected binding names
 * right before arming protected egress or spawning a process. The run-start
 * snapshot is a value snapshot, never a durable permission grant: a binding
 * whose entry was unassigned or narrowed after the snapshot is refused here,
 * so the subprocess can never substitute or launch with stale authorization.
 */
export async function assertSecretAuthorityForLaunch(params: {
  storeEnv: SecretStoreExecEnvironment;
  agentId?: string;
  config?: OpenClawConfig;
  cwd: string | undefined;
  revalidate: SecretAuthorityRevalidate;
}): Promise<void> {
  const bindingNames = [
    ...new Set([
      ...Object.keys(params.storeEnv.env ?? {}),
      ...(params.storeEnv.secretEgressBindings ?? []).map((binding) => binding.name),
    ]),
  ];
  if (bindingNames.length === 0) {
    return;
  }
  const authority = params.revalidate({
    names: bindingNames,
    agentId: params.agentId,
    config: params.config,
  });
  if (!authority.ok) {
    throw new (await import("./bash-tools.exec-runtime.js")).ExecProcessPreflightError(
      buildSecretAuthorityDeniedResult(authority.reason, params.cwd),
    );
  }
}
/**
 * Arms protected egress for one launch: re-validates current audience and
 * assignment authority for the projected bindings, then registers them with
 * the run-scoped egress proxy. Returns the proxy environment, or undefined
 * when egress is not in play for this host.
 */
export async function armSecretEgressForLaunch(params: {
  enabled: boolean;
  storeEnv: SecretStoreExecEnvironment;
  operationalRunInstance: Readonly<{ instanceId: string; runId: string }> | undefined;
  agentId?: string;
  config?: OpenClawConfig;
  cwd: string | undefined;
  registerRun: (
    run: Readonly<{ instanceId: string; runId: string }>,
    bindings: ReadonlyArray<{
      name: string;
      sentinel: string;
      allowedHosts: string[];
    }>,
    liveAuthority: (params: { name: string; host: string }) => boolean,
  ) => Record<string, string>;
  revalidate: SecretAuthorityRevalidate;
}): Promise<Record<string, string> | undefined> {
  if (!params.enabled) {
    return undefined;
  }
  if (!params.operationalRunInstance) {
    throw new Error("Secret egress proxy requires an admitted agent run instance");
  }
  // Snapshot is a value snapshot, not a durable grant: re-check
  // audience/assignment each launch before arming protected egress.
  await assertSecretAuthorityForLaunch({
    storeEnv: params.storeEnv,
    agentId: params.agentId,
    config: params.config,
    cwd: params.cwd,
    revalidate: params.revalidate,
  });
  return params.registerRun(
    params.operationalRunInstance,
    params.storeEnv.secretEgressBindings ?? [],
    ({ name, host }) =>
      revalidateSecretEgressBindingAtRequest({
        name,
        host,
        agentId: params.agentId,
        config: params.config,
      }),
  );
}
