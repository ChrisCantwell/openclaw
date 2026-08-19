import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { AgentSelectionRequiredError } from "../agents/agent-scope-config.js";
import { normalizeChatType } from "../channels/chat-type.js";
import { listRouteBindings } from "../config/bindings.js";
import type { ConversationRecord } from "../config/sessions/conversation-registry.js";
import type { AgentBindingMatch } from "../config/types.agents.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAccountId } from "../routing/account-id.js";
import { normalizeRouteBindingId } from "../routing/binding-scope.js";
import { resolveAgentRoute, type RoutePeer } from "../routing/resolve-route.js";
import { normalizeAgentId } from "../routing/session-key.js";

type ConversationRouteCandidate = Pick<
  ConversationRecord,
  | "accountId"
  | "channel"
  | "kind"
  | "observedFromSession"
  | "parentConversationRef"
  | "peerId"
  | "threadId"
>;

function peerKindsMatch(left: RoutePeer["kind"], right: RoutePeer["kind"]): boolean {
  return (
    left === right ||
    ((left === "group" || left === "channel") && (right === "group" || right === "channel"))
  );
}

function accountPatternMatches(pattern: string | undefined, accountId: string): boolean {
  const trimmed = pattern?.trim() ?? "";
  return trimmed === "*" || normalizeAccountId(trimmed) === accountId;
}

function bindingCouldUseMissingContext(params: {
  match: AgentBindingMatch;
  peer: RoutePeer;
  hasThreadContext: boolean;
}): boolean {
  const bindingPeer = params.match.peer;
  const bindingPeerKind = normalizeChatType(bindingPeer?.kind);
  const bindingPeerId = normalizeRouteBindingId(bindingPeer?.id);
  const normalizedPeerId = normalizeRouteBindingId(params.peer.id);
  const currentPeerMatches = Boolean(
    bindingPeerKind &&
    bindingPeerId &&
    peerKindsMatch(bindingPeerKind, params.peer.kind) &&
    (bindingPeerId === "*" || bindingPeerId === normalizedPeerId),
  );
  const parentPeerCouldMatch = Boolean(
    params.hasThreadContext &&
    params.peer.kind !== "direct" &&
    !currentPeerMatches &&
    bindingPeerKind &&
    bindingPeerId &&
    bindingPeerId !== "*" &&
    bindingPeerKind !== "direct",
  );
  const hasContextualScope = Boolean(
    normalizeRouteBindingId(params.match.guildId) ||
    normalizeRouteBindingId(params.match.teamId) ||
    params.match.roles?.length,
  );

  // Account/channel and unscoped peer bindings were already resolved above.
  // Only absent inbound-only facts can make an observed route select another agent.
  return (
    (hasContextualScope && (!bindingPeer || currentPeerMatches || parentPeerCouldMatch)) ||
    parentPeerCouldMatch
  );
}

/** Checks detached outbound eligibility without treating inbound context as a reusable grant. */
export function isConversationRouteEligibleForAgent(params: {
  config: OpenClawConfig;
  agentId: string;
  conversation: ConversationRouteCandidate;
}): boolean {
  const agentId = normalizeAgentId(params.agentId);
  const conversation = params.conversation;
  const peer: RoutePeer = { kind: conversation.kind, id: conversation.peerId };
  try {
    const route = resolveAgentRoute({
      cfg: params.config,
      channel: conversation.channel,
      accountId: conversation.accountId,
      peer,
    });
    if (normalizeAgentId(route.agentId) === agentId) {
      return true;
    }
  } catch (error) {
    if (!(error instanceof AgentSelectionRequiredError)) {
      throw error;
    }
  }
  if (!conversation.observedFromSession) {
    return false;
  }

  const channel = normalizeLowercaseStringOrEmpty(conversation.channel);
  const accountId = normalizeAccountId(conversation.accountId);
  return listRouteBindings(params.config).some((binding) => {
    return (
      normalizeAgentId(binding.agentId) === agentId &&
      normalizeLowercaseStringOrEmpty(binding.match.channel) === channel &&
      accountPatternMatches(binding.match.accountId, accountId) &&
      bindingCouldUseMissingContext({
        match: binding.match,
        peer,
        hasThreadContext: Boolean(conversation.parentConversationRef || conversation.threadId),
      })
    );
  });
}
