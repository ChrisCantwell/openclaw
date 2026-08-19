import { AgentSelectionRequiredError } from "../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAgentRoute, type RoutePeer } from "../routing/resolve-route.js";
import { normalizeAgentId } from "../routing/session-key.js";

/** Revalidates a persisted or discovered address against canonical inbound routing. */
export function isConversationRouteOwnedByAgent(params: {
  config: OpenClawConfig;
  agentId: string;
  channel: string;
  accountId: string;
  peer: RoutePeer;
}): boolean {
  try {
    const route = resolveAgentRoute({
      cfg: params.config,
      channel: params.channel,
      accountId: params.accountId,
      peer: params.peer,
    });
    return normalizeAgentId(route.agentId) === normalizeAgentId(params.agentId);
  } catch (error) {
    if (error instanceof AgentSelectionRequiredError) {
      return false;
    }
    throw error;
  }
}
