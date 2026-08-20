import { describe, expect, it } from "vitest";
import { conversationRouteContextFromMsgContext } from "./conversation-route-context.js";

describe("conversationRouteContextFromMsgContext", () => {
  it("captures Discord guild, role, and parent facts deterministically", () => {
    expect(
      conversationRouteContextFromMsgContext({
        OriginatingChannel: "Discord",
        GroupSpace: "guild-a",
        ThreadParentId: "parent-a",
        MemberRoleIds: ["support", "admin", "support"],
      }),
    ).toEqual({
      guildId: "guild-a",
      parentPeerId: "parent-a",
      memberRoleIds: ["admin", "support"],
    });
  });

  it.each(["slack", "mattermost", "msteams"])(
    "captures %s workspace identity as a team route fact",
    (channel) => {
      expect(
        conversationRouteContextFromMsgContext({
          OriginatingChannel: channel,
          GroupSpace: "team-a",
        }),
      ).toEqual({ teamId: "team-a" });
    },
  );

  it("does not invent a scope dialect for channels without one", () => {
    expect(
      conversationRouteContextFromMsgContext({
        OriginatingChannel: "reef",
        GroupSpace: "space-a",
      }),
    ).toBeUndefined();
  });
});
