import type { DiagnosticTraceContext } from "../infra/diagnostic-trace-context.js";
import type { InputProvenance } from "../sessions/input-provenance.js";
import type { PluginHookChannelContext } from "./hook-channel-context.types.js";

export type PluginHookToolAuthority = {
  /** Opaque host fingerprint for the exact turn, route, policy, and active tool surface. */
  readonly fingerprint: string;
  /** Checks whether the finalized turn surface contains this exact tool. */
  allows(toolName: string): boolean;
  /** Rejects retained or timed-out capabilities after the host dispatch closes. */
  assertActive(): void;
};

export type PluginHookAgentContext = {
  runId?: string;
  jobId?: string;
  trace?: DiagnosticTraceContext;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  workspaceDir?: string;
  /** Run-prepared repository identities; empty when the turn is outside a repository. */
  activeProjectKeys?: string[];
  modelProviderId?: string;
  modelId?: string;
  messageProvider?: string;
  /** Channel/plugin id for channel-originated runs, e.g. `discord`. */
  channel?: string;
  /** Channel account used by the agent when multiple accounts are configured. */
  accountId?: string;
  /** Conversation target id for channel-originated runs. Mirrors `channelId` for compatibility. */
  chatId?: string;
  /** Sender identity for channel-originated runs when available. */
  senderId?: string;
  trigger?: string;
  channelId?: string;
  /**
   * Typed origin of the turn's user-role input. Absent when the producer did not
   * supply a classification; absence does not establish human origin.
   */
  inputProvenance?: InputProvenance;
  /** Resolved effective context-token budget after model/config/agent caps. */
  contextTokenBudget?: number;
  /** Source that supplied the resolved context-token budget. */
  contextWindowSource?: PluginHookContextWindowSource;
  /** Native/configured reference window when a lower cap wins. */
  contextWindowReferenceTokens?: number;
  /**
   * @deprecated Core does not populate cross-app sender ids. Channel plugins
   * should expose channel-specific identities by augmenting `channelContext.sender`.
   */
  senderExternalId?: string;
  /** Channel-owned sender/chat details. Plugins may augment the nested interfaces. */
  channelContext?: PluginHookChannelContext;
  /** Present only for post-policy prompt enrichment hooks that requested tool authority. */
  toolAuthority?: PluginHookToolAuthority;
  /**
   * Present for before_prompt_build only. Checks this handler's result-acceptance lifetime,
   * not tool authorization or eventual model consumption. Underlying work is not cancelled.
   */
  readonly hookInvocation?: Readonly<{ assertActive(): void }>;
};

export type PluginHookContextWindowSource =
  | "model"
  | "modelsConfig"
  | "agentContextTokens"
  | "default";
