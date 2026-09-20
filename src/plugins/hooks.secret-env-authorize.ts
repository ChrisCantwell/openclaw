import type { HookRunnerRegistry } from "./hook-registry.types.js";
import type {
  PluginHookName,
  PluginHookRegistration,
  PluginHookSecretEnvAuthorizeContext,
  PluginHookSecretEnvAuthorizeEvent,
  PluginHookSecretEnvAuthorizeResult,
} from "./hook-types.js";

type Logger = { debug?: (message: string) => void; warn: (message: string) => void };
type HookErrorHandler = (params: {
  hookName: PluginHookName;
  pluginId: string;
  error: unknown;
}) => never | void;

function readDecision(
  value: PluginHookSecretEnvAuthorizeResult | void | null,
): Set<string> | undefined {
  if (!value || typeof value !== "object" || !Array.isArray(value.allowedNames)) {
    return undefined;
  }
  const names = new Set<string>();
  for (const name of value.allowedNames) {
    if (typeof name !== "string") {
      return undefined;
    }
    names.add(name);
  }
  return names;
}

export function createSecretEnvAuthorizeRunner(deps: {
  registry: HookRunnerRegistry;
  logger?: Logger;
  getHooksForName: (
    registry: HookRunnerRegistry,
    hookName: "secret_env_authorize",
    ctx?: unknown,
  ) => PluginHookRegistration<"secret_env_authorize">[];
  getModifyingHookTimeoutMs: (
    hookName: PluginHookName,
    hook: PluginHookRegistration,
  ) => number | undefined;
  withHookTimeout: <T>(promise: Promise<T>, timeoutMs: number) => Promise<T>;
  handleHookError: HookErrorHandler;
}) {
  return async function runSecretEnvAuthorize(
    event: PluginHookSecretEnvAuthorizeEvent,
    ctx: PluginHookSecretEnvAuthorizeContext,
  ): Promise<PluginHookSecretEnvAuthorizeResult | undefined> {
    const hooks = deps.getHooksForName(deps.registry, "secret_env_authorize", ctx);
    if (hooks.length === 0) {
      return undefined;
    }
    deps.logger?.debug?.(
      `[hooks] running secret_env_authorize (${hooks.length} handlers, fail-closed per handler)`,
    );
    let allowed: Set<string> | undefined;
    for (const hook of hooks) {
      let handlerResult: PluginHookSecretEnvAuthorizeResult | void;
      try {
        const handler = hook.handler as (
          event: PluginHookSecretEnvAuthorizeEvent,
          ctx: PluginHookSecretEnvAuthorizeContext,
        ) => Promise<PluginHookSecretEnvAuthorizeResult | void>;
        const promise = Promise.resolve(handler(event, ctx));
        const timeoutMs = deps.getModifyingHookTimeoutMs(hook.hookName, hook);
        handlerResult = timeoutMs ? await deps.withHookTimeout(promise, timeoutMs) : await promise;
      } catch (err) {
        deps.handleHookError({
          hookName: "secret_env_authorize",
          pluginId: hook.pluginId,
          error: err,
        });
        return undefined;
      }
      const decision = readDecision(handlerResult);
      if (!decision) {
        deps.logger?.warn(
          `[hooks] secret_env_authorize handler from ${hook.pluginId} returned no valid decision; denying projection`,
        );
        return undefined;
      }
      allowed = allowed ? new Set([...allowed].filter((name) => decision.has(name))) : decision;
      if (allowed.size === 0) {
        return { allowedNames: [] };
      }
    }
    return { allowedNames: [...(allowed ?? [])] };
  };
}
