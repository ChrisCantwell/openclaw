import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { MsgContext } from "../../auto-reply/templating.js";
import type { ConversationRouteContext } from "./conversation-route-context.types.js";

export type { ConversationRouteContext } from "./conversation-route-context.types.js";

function normalizeRoleIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const roleIds = [
    ...new Set(
      value.flatMap((roleId) => {
        const normalized = normalizeOptionalString(roleId);
        return normalized ? [normalized] : [];
      }),
    ),
  ].toSorted();
  return roleIds.length > 0 ? roleIds : undefined;
}

export function parseConversationRouteContext(
  value: unknown,
): ConversationRouteContext | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const guildId = normalizeOptionalString(value.guildId);
  const teamId = normalizeOptionalString(value.teamId);
  const parentPeerId = normalizeOptionalString(value.parentPeerId);
  const memberRoleIds = normalizeRoleIds(value.memberRoleIds);
  if (!guildId && !teamId && !parentPeerId && !memberRoleIds) {
    return undefined;
  }
  return {
    ...(guildId ? { guildId } : {}),
    ...(teamId ? { teamId } : {}),
    ...(parentPeerId ? { parentPeerId } : {}),
    ...(memberRoleIds ? { memberRoleIds } : {}),
  };
}

/** Captures only the authoritative inbound facts needed to replay current route precedence. */
export function conversationRouteContextFromMsgContext(
  ctx: MsgContext,
): ConversationRouteContext | undefined {
  const channel = normalizeOptionalLowercaseString(ctx.OriginatingChannel ?? ctx.Provider);
  const spaceId = normalizeOptionalString(ctx.GroupSpace);
  return parseConversationRouteContext({
    ...(channel === "discord" && spaceId ? { guildId: spaceId } : {}),
    ...((channel === "slack" || channel === "mattermost" || channel === "msteams") && spaceId
      ? { teamId: spaceId }
      : {}),
    parentPeerId: ctx.ThreadParentId,
    memberRoleIds: ctx.MemberRoleIds,
  });
}
