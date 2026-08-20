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
        channel: "discord",
        accountId: "default",
        guildId: "support-guild",
        roles: ["support"],
      },
      routeContext: { guildId: "support-guild", memberRoleIds: ["support"] },
      peer: { kind: "channel" as const, id: "support-room" },
    },
    {
      name: "team",
      match: { channel: "slack", accountId: "default", teamId: "support-team" },
      routeContext: { teamId: "support-team" },
      peer: { kind: "channel" as const, id: "support-room" },
    },
    {
      name: "parent peer",
      match: {
        channel: "reef",
        accountId: "default",
        peer: { kind: "channel" as const, id: "support-parent" },
      },
      routeContext: { parentPeerId: "support-parent" },
      peer: { kind: "channel" as const, id: "support-thread" },
    },
  ])("requires session provenance for unresolved $name context", (testCase) => {
    const channel = testCase.match.channel;
    const params = {
      config: {
        agents: { entries: { main: {}, finance: {} } },
        bindings: [
          {
            type: "route" as const,
            agentId: "finance",
            match: testCase.match as AgentBindingMatch,
          },
          { ...fallbackBinding, match: { ...fallbackBinding.match, channel } },
        ],
      },
      agentId: "finance",
      conversation: {
        channel,
        accountId: "default",
        kind: testCase.peer.kind,
        peerId: testCase.peer.id,
      },
    };

    expect(isConversationRouteEligibleForAgent(params)).toBe(false);
    expect(
      isConversationRouteEligibleForAgent({
        ...params,
        conversation: {
          ...params.conversation,
          observedFromSession: true,
          routeContext: testCase.routeContext,
        },
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

  it("does not let an unrelated contextual binding revive a reassigned route", () => {
    expect(
      isConversationRouteEligibleForAgent({
        config: {
          agents: { entries: { main: {}, finance: {}, support: {} } },
          bindings: [
            {
              type: "route",
              agentId: "support",
              match: { channel: "discord", accountId: "default", guildId: "guild-a" },
            },
            {
              type: "route",
              agentId: "finance",
              match: { channel: "discord", accountId: "default", guildId: "guild-b" },
            },
          ],
        },
        agentId: "finance",
        conversation: {
          channel: "discord",
          accountId: "default",
          kind: "channel",
          peerId: "ops-room",
          observedFromSession: true,
          routeContext: { guildId: "guild-a" },
        },
      }),
    ).toBe(false);
  });

  it("does not let a context-free fallback share an exact contextual route", () => {
    const config = {
      agents: { entries: { main: {}, finance: {} } },
      bindings: [
        {
          type: "route" as const,
          agentId: "finance",
          match: { channel: "discord", accountId: "default", guildId: "guild-a" },
        },
        {
          type: "route" as const,
          agentId: "main",
          match: { channel: "discord", accountId: "default" },
        },
      ],
    };
    const conversation = {
      channel: "discord",
      accountId: "default",
      kind: "channel" as const,
      peerId: "ops-room",
      observedFromSession: true as const,
      routeContext: { guildId: "guild-a" },
    };

    expect(isConversationRouteEligibleForAgent({ config, agentId: "finance", conversation })).toBe(
      true,
    );
    expect(isConversationRouteEligibleForAgent({ config, agentId: "main", conversation })).toBe(
      false,
    );
  });
});
