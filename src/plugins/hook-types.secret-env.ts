import type { PluginHookAgentContext } from "./hook-types.js";

/** One resolved store entry in the projection, identified by name and kind only. */
type PluginHookSecretEnvCandidate = { name: string; kind: "secret" | "env" };

export type PluginHookSecretEnvAuthorizeEvent = {
  toolName: "exec";
  host: "gateway" | "sandbox" | "node";
  sessionKey?: string;
  /** Resolved store-entry names for this run; never carries values. */
  candidates: readonly PluginHookSecretEnvCandidate[];
};

export type PluginHookSecretEnvAuthorizeContext = PluginHookAgentContext;

/**
 * Result for secret_env_authorize. `allowedNames` narrows the projection to the
 * intersection of every handler's set, and handlers can only ever restrict the
 * projection, never widen it. Every participating handler MUST return a valid
 * decision: a handler that returns nothing (or a malformed value), throws, or
 * times out denies the whole projection, so one non-deciding policy can never be
 * masked by another handler's allow.
 */
export type PluginHookSecretEnvAuthorizeResult = { allowedNames: readonly string[] };
