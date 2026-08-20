import { AgentSelectionRequiredError } from "../agents/agent-scope-config.js";
import type { ConversationRecord } from "../config/sessions/conversation-registry.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
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
  | "routeContext"
  | "threadId"
>;

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
  if (!conversation.observedFromSession || !conversation.routeContext) {
    return false;
  }
  const context = conversation.routeContext;
  try {
    const route = resolveAgentRoute({
      cfg: params.config,
      channel: conversation.channel,
      accountId: conversation.accountId,
      peer,
      ...(context.parentPeerId && conversation.kind !== "direct"
        ? { parentPeer: { kind: conversation.kind, id: context.parentPeerId } }
        : {}),
      ...(context.guildId ? { guildId: context.guildId } : {}),
      ...(context.teamId ? { teamId: context.teamId } : {}),
      ...(context.memberRoleIds ? { memberRoleIds: context.memberRoleIds } : {}),
    });
    return normalizeAgentId(route.agentId) === agentId;
  } catch (error) {
    if (error instanceof AgentSelectionRequiredError) {
      return false;
    }
    throw error;
  }
}
