import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { AgentSelectionRequiredError } from "../agents/agent-scope-config.js";
import { listRouteBindings } from "../config/bindings.js";
import type { ConversationRecord } from "../config/sessions/conversation-registry.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAccountId } from "../routing/account-id.js";
import { normalizeRouteBindingId } from "../routing/binding-scope.js";
import { resolveAgentRoute } from "../routing/resolve-route.js";
import { normalizeAgentId } from "../routing/session-key.js";

type ConversationRouteCandidate = Pick<
  ConversationRecord,
  | "accountId"
  | "channel"
  | "kind"
  | "observedFromSession"
  | "parentConversationRef"
  | "peerId"
  | "routeContext"
  | "threadId"
>;

function resolveRouteAgentId(
  config: OpenClawConfig,
  conversation: ConversationRouteCandidate,
  context?: NonNullable<ConversationRouteCandidate["routeContext"]>,
): string | undefined {
  try {
    return normalizeAgentId(
      resolveAgentRoute({
        cfg: config,
        channel: conversation.channel,
        accountId: conversation.accountId,
        peer: { kind: conversation.kind, id: conversation.peerId },
        ...(context?.parentPeerId && conversation.kind !== "direct"
          ? { parentPeer: { kind: conversation.kind, id: context.parentPeerId } }
          : {}),
        ...(context?.guildId ? { guildId: context.guildId } : {}),
        ...(context?.teamId ? { teamId: context.teamId } : {}),
        ...(context?.memberRoleIds ? { memberRoleIds: context.memberRoleIds } : {}),
      }).agentId,
    );
  } catch (error) {
    if (error instanceof AgentSelectionRequiredError) {
      return undefined;
    }
    throw error;
  }
}

function hasUnrecordedContextualBinding(
  config: OpenClawConfig,
  conversation: ConversationRouteCandidate,
): boolean {
  const channel = normalizeLowercaseStringOrEmpty(conversation.channel);
  const accountId = normalizeAccountId(conversation.accountId);
  const hasThreadContext = Boolean(conversation.parentConversationRef || conversation.threadId);
  return listRouteBindings(config).some((binding) => {
    const pattern = binding.match.accountId?.trim() ?? "";
    const contextualScope = Boolean(
      normalizeRouteBindingId(binding.match.guildId) ||
      normalizeRouteBindingId(binding.match.teamId) ||
      binding.match.roles?.length ||
      (hasThreadContext &&
        binding.match.peer?.kind !== "direct" &&
        normalizeRouteBindingId(binding.match.peer?.id)),
    );
    return (
      contextualScope &&
      normalizeLowercaseStringOrEmpty(binding.match.channel) === channel &&
      (pattern === "*" || normalizeAccountId(pattern) === accountId)
    );
  });
}

/** Checks detached outbound eligibility without treating inbound context as a reusable grant. */
export function isConversationRouteEligibleForAgent(params: {
  config: OpenClawConfig;
  agentId: string;
  conversation: ConversationRouteCandidate;
}): boolean {
  const agentId = normalizeAgentId(params.agentId);
  const conversation = params.conversation;
  if (conversation.observedFromSession && conversation.routeContext) {
    return resolveRouteAgentId(params.config, conversation, conversation.routeContext) === agentId;
  }
  if (resolveRouteAgentId(params.config, conversation) !== agentId) {
    return false;
  }
  return (
    !conversation.observedFromSession ||
    !hasUnrecordedContextualBinding(params.config, conversation)
  );
}
