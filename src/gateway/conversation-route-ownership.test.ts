import { describe, expect, it } from "vitest";
import type { AgentBindingMatch } from "../config/types.agents.js";
import { isConversationRouteEligibleForAgent } from "./conversation-route-ownership.js";

const fallbackBinding = {
  type: "route" as const,
  agentId: "main",
  match: { channel: "reef", accountId: "default" },
};

describe("isConversationRouteEligibleForAgent", () => {
  it.each([
    {
      name: "guild and roles",
      match: {
        channel: "reef",
        accountId: "default",
        guildId: "support-guild",
        roles: ["support"],
      },
      peer: { kind: "channel" as const, id: "support-room" },
      hasThreadContext: false,
    },
    {
      name: "team",
      match: { channel: "reef", accountId: "default", teamId: "support-team" },
      peer: { kind: "channel" as const, id: "support-room" },
      hasThreadContext: false,
    },
    {
      name: "parent peer",
      match: {
        channel: "reef",
        accountId: "default",
        peer: { kind: "channel" as const, id: "support-parent" },
      },
      peer: { kind: "channel" as const, id: "support-thread" },
      hasThreadContext: true,
    },
  ])("requires session provenance for unresolved $name context", (testCase) => {
    const params = {
      config: {
        agents: { entries: { main: {}, finance: {} } },
        bindings: [
          {
            type: "route" as const,
            agentId: "finance",
            match: testCase.match as AgentBindingMatch,
          },
          fallbackBinding,
        ],
      },
      agentId: "finance",
      conversation: {
        channel: "reef",
        accountId: "default",
        kind: testCase.peer.kind,
        peerId: testCase.peer.id,
        ...(testCase.hasThreadContext ? { threadId: "thread-1" } : {}),
      },
    };

    expect(isConversationRouteEligibleForAgent(params)).toBe(false);
    expect(
      isConversationRouteEligibleForAgent({
        ...params,
        conversation: { ...params.conversation, observedFromSession: true },
      }),
    ).toBe(true);
  });

  it("revokes provenance when no current binding can select the agent", () => {
    expect(
      isConversationRouteEligibleForAgent({
        config: {
          agents: { entries: { main: {}, finance: {} } },
          bindings: [
            {
              type: "route",
              agentId: "finance",
              match: { channel: "reef", accountId: "default" },
            },
          ],
        },
        agentId: "main",
        conversation: {
          channel: "reef",
          accountId: "default",
          kind: "direct",
          peerId: "molty",
          observedFromSession: true,
        },
      }),
    ).toBe(false);
  });
});
