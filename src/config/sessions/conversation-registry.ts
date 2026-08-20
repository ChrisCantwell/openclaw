import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { sql } from "kysely";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import type { ConversationIdentity, ConversationKind } from "./conversation-identity.js";
import {
  parseConversationRouteContext,
  type ConversationRouteContext,
} from "./conversation-route-context.js";
import { resolveSessionStorePathCore } from "./paths.js";
import { upsertConversationIdentity } from "./session-accessor.sqlite-conversation.js";
import {
  getSessionKysely,
  resolveSqliteReadScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { parseSessionEntryJson } from "./session-accessor.sqlite-status.js";

const CONVERSATION_REF_PATTERN = /^conv_[a-f0-9]{32}$/u;

export type ConversationRecord = {
  conversationRef: string;
  channel: string;
  accountId: string;
  kind: ConversationKind;
  peerId: string;
  target: string;
  parentConversationRef?: string;
  threadId?: string;
  nativeChannelId?: string;
  nativeDirectUserId?: string;
  label?: string;
  sessionId?: string;
  sessionKey?: string;
  role?: "participant" | "primary" | "related";
  /** True when this address has been linked to a session in this agent's store. */
  observedFromSession?: true;
  /** Exact contextual facts from the inbound route that admitted this address. */
  routeContext?: ConversationRouteContext;
  firstSeenAt: number;
  lastSeenAt: number;
};

export type ConversationRegistryScope = {
  agentId: string;
  env?: NodeJS.ProcessEnv;
  storePath?: string;
};

type ConversationListOptions = {
  channel?: string;
  limit?: number;
};

export type ConversationScanPage = {
  conversations: ConversationRecord[];
  cursor?: number;
};

export function resolveConversationRegistryScope(params: {
  agentId: string;
  config: OpenClawConfig;
}): ConversationRegistryScope {
  const configuredStore = params.config.session?.store;
  return {
    agentId: params.agentId,
    ...(configuredStore
      ? { storePath: resolveSessionStorePathCore(configuredStore, { agentId: params.agentId }) }
      : {}),
  };
}

function normalizeConversationRef(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!CONVERSATION_REF_PATTERN.test(normalized)) {
    throw new Error(`Invalid conversationRef: ${value}`);
  }
  return normalized;
}

function openConversationRegistry(scope: ConversationRegistryScope) {
  const resolved = resolveSqliteReadScope({
    agentId: scope.agentId,
    ...(scope.env ? { env: scope.env } : {}),
    ...(scope.storePath ? { storePath: scope.storePath } : {}),
  });
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  return { database, db: getSessionKysely(database.db) };
}

function conversationRowId() {
  return /* kysely-allow-raw: SQLite rowid is the immutable insertion cursor for a stable bounded scan. */ sql<number>`c.rowid`;
}

function maxConversationRowId() {
  return /* kysely-allow-raw: Freeze the highest immutable rowid before yielding between bounded pages. */ sql<
    number | null
  >`MAX(c.rowid)`;
}

type MappedConversationRow = {
  record: ConversationRecord;
  ownedAssociation: boolean;
};

function mapConversationRow(
  row: {
    account_id: string;
    channel: string;
    conversation_id: string;
    conversation_created_at: number;
    conversation_updated_at: number;
    first_seen_at: number | null;
    kind: string;
    associated_session_key: string | null;
    label: string | null;
    last_seen_at: number | null;
    delivery_target: string;
    native_channel_id: string | null;
    native_direct_user_id: string | null;
    parent_conversation_id: string | null;
    peer_id: string;
    role: string | null;
    route_context_json: string | null;
    current_session_id: string | null;
    current_entry_json: string | null;
    current_session_key: string | null;
    thread_id: string | null;
  },
  agentId: string,
): MappedConversationRow | null {
  if (row.kind !== "direct" && row.kind !== "group" && row.kind !== "channel") {
    return null;
  }
  const role =
    row.role === "primary" || row.role === "participant" || row.role === "related"
      ? row.role
      : undefined;
  const associatedAgentId = row.associated_session_key
    ? parseAgentSessionKey(row.associated_session_key)?.agentId
    : undefined;
  const ownedAssociation = Boolean(
    row.associated_session_key === "global" ||
    (associatedAgentId && normalizeAgentId(associatedAgentId) === normalizeAgentId(agentId)),
  );
  const currentEntry =
    ownedAssociation && row.current_entry_json
      ? parseSessionEntryJson({ entry_json: row.current_entry_json })
      : null;
  const hasCurrentBinding = currentEntry?.sessionId === row.current_session_id;
  const routeContext = ownedAssociation
    ? parseConversationRouteContext(
        row.route_context_json ? safeParseJsonRecord(row.route_context_json) : undefined,
      )
    : undefined;
  return {
    ownedAssociation,
    record: {
      conversationRef: row.conversation_id,
      channel: row.channel,
      accountId: row.account_id,
      kind: row.kind,
      peerId: row.peer_id,
      target: row.delivery_target,
      ...(row.parent_conversation_id ? { parentConversationRef: row.parent_conversation_id } : {}),
      ...(row.thread_id ? { threadId: row.thread_id } : {}),
      ...(row.native_channel_id ? { nativeChannelId: row.native_channel_id } : {}),
      ...(row.native_direct_user_id ? { nativeDirectUserId: row.native_direct_user_id } : {}),
      ...(row.label ? { label: row.label } : {}),
      // Only the current session_nodes row can bind an address. The joined
      // window row may be historical after reset, rebind, or deletion.
      ...(ownedAssociation &&
      role &&
      hasCurrentBinding &&
      row.current_session_id &&
      row.current_session_key
        ? {
            sessionId: row.current_session_id,
            sessionKey: row.current_session_key,
            role,
          }
        : {}),
      ...(ownedAssociation && role ? { observedFromSession: true as const } : {}),
      ...(routeContext ? { routeContext } : {}),
      firstSeenAt:
        ownedAssociation && row.first_seen_at !== null
          ? row.first_seen_at
          : row.conversation_created_at,
      lastSeenAt:
        ownedAssociation && row.last_seen_at !== null
          ? row.last_seen_at
          : row.conversation_updated_at,
    },
  };
}

function selectConversationRows(
  scope: ConversationRegistryScope,
  options: ConversationListOptions & {
    conversationRef?: string;
    afterRowId?: number;
    throughRowId?: number;
  } = {},
): ConversationScanPage {
  const { database, db } = openConversationRegistry(scope);
  let pageQuery = db
    .selectFrom("conversations as c")
    .select(["c.conversation_id", conversationRowId().as("conversation_rowid")]);
  const channel = normalizeOptionalLowercaseString(options.channel);
  if (channel) {
    pageQuery = pageQuery.where("c.channel", "=", channel);
  }
  if (options.conversationRef) {
    pageQuery = pageQuery.where(
      "c.conversation_id",
      "=",
      normalizeConversationRef(options.conversationRef),
    );
  }
  const stableScan = options.throughRowId !== undefined;
  if (options.afterRowId !== undefined) {
    pageQuery = pageQuery.where(conversationRowId(), ">", options.afterRowId);
  }
  if (options.throughRowId !== undefined) {
    pageQuery = pageQuery.where(conversationRowId(), "<=", options.throughRowId);
  }
  pageQuery = stableScan
    ? pageQuery.orderBy(conversationRowId(), "asc")
    : pageQuery.orderBy("c.updated_at", "desc").orderBy("c.conversation_id", "asc");
  if (options.limit !== undefined) {
    pageQuery = pageQuery.limit(Math.max(0, Math.trunc(options.limit)));
  }
  const pageRows = executeSqliteQuerySync(database.db, pageQuery).rows;
  const conversationIds = pageRows.map((row) => row.conversation_id);
  if (conversationIds.length === 0) {
    return { conversations: [] };
  }
  const query = db
    .selectFrom("conversations as c")
    .leftJoin("session_conversations as sc", "sc.conversation_id", "c.conversation_id")
    .leftJoin("session_windows as s", "s.session_id", "sc.session_id")
    // Historical windows retain address activity, while session_nodes owns
    // the current session binding after reset/rebind.
    .leftJoin("session_nodes as sn", "sn.session_key", "s.session_key")
    .select([
      "c.conversation_id",
      "c.channel",
      "c.account_id",
      "c.kind",
      "c.peer_id",
      "c.delivery_target",
      "c.parent_conversation_id",
      "c.thread_id",
      "c.native_channel_id",
      "c.native_direct_user_id",
      "c.label",
      "c.created_at as conversation_created_at",
      "c.updated_at as conversation_updated_at",
      "sc.role",
      "sc.route_context_json",
      "sc.first_seen_at",
      "sc.last_seen_at",
      "s.session_key as associated_session_key",
      "sn.current_session_id as current_session_id",
      "sn.entry_json as current_entry_json",
      "sn.session_key as current_session_key",
    ])
    .where("c.conversation_id", "in", conversationIds);
  const orderedQuery = stableScan
    ? query.orderBy(conversationRowId(), "asc")
    : query.orderBy("c.updated_at", "desc").orderBy("c.conversation_id", "asc");
  const rows = executeSqliteQuerySync(
    database.db,
    orderedQuery.orderBy("sc.last_seen_at", "desc").orderBy("sn.updated_at", "desc"),
  ).rows;
  const unique = new Map<string, MappedConversationRow>();
  for (const row of rows) {
    const mapped = mapConversationRow(row, scope.agentId);
    if (!mapped) {
      continue;
    }
    const existing = unique.get(mapped.record.conversationRef);
    if (!existing) {
      unique.set(mapped.record.conversationRef, mapped);
      continue;
    }
    if (!existing.ownedAssociation && mapped.ownedAssociation) {
      unique.set(mapped.record.conversationRef, mapped);
      continue;
    }
    if (
      existing.ownedAssociation === mapped.ownedAssociation &&
      !existing.record.sessionId &&
      mapped.record.sessionId &&
      mapped.record.sessionKey &&
      mapped.record.role
    ) {
      // Keep the newest address activity while carrying forward the live binding
      // when a newer historical association has no current session entry.
      unique.set(mapped.record.conversationRef, {
        ...existing,
        record: {
          ...existing.record,
          sessionId: mapped.record.sessionId,
          sessionKey: mapped.record.sessionKey,
          role: mapped.record.role,
        },
      });
    }
  }
  const cursor = stableScan ? pageRows.at(-1)?.conversation_rowid : undefined;
  return {
    conversations: [...unique.values()].map((entry) => entry.record),
    ...(cursor !== undefined ? { cursor } : {}),
  };
}

/** Catalogs routable addresses without creating model-context sessions. */
export function registerConversationAddresses(
  scope: ConversationRegistryScope,
  identities: readonly ConversationIdentity[],
  discoveredAt = Date.now(),
): void {
  if (identities.length === 0) {
    return;
  }
  const { database } = openConversationRegistry(scope);
  for (const identity of identities) {
    upsertConversationIdentity(database, identity, discoveredAt);
  }
}

/** Lists stable external addresses for one agent, newest activity first. */
export function listConversations(
  scope: ConversationRegistryScope,
  options: ConversationListOptions = {},
): ConversationRecord[] {
  return selectConversationRows(scope, options).conversations;
}

/** Freezes the current insertion sequence for a paged registry scan. */
export function resolveConversationScanBoundary(
  scope: ConversationRegistryScope,
  options: Pick<ConversationListOptions, "channel"> = {},
): number | undefined {
  const { database, db } = openConversationRegistry(scope);
  let query = db
    .selectFrom("conversations as c")
    .select(maxConversationRowId().as("conversation_rowid"));
  const channel = normalizeOptionalLowercaseString(options.channel);
  if (channel) {
    query = query.where("c.channel", "=", channel);
  }
  return executeSqliteQuerySync(database.db, query).rows[0]?.conversation_rowid ?? undefined;
}

/** Reads one immutable insertion-order page within a frozen registry boundary. */
export function scanConversations(
  scope: ConversationRegistryScope,
  options: Pick<ConversationListOptions, "channel" | "limit"> & {
    afterCursor?: number;
    throughCursor: number;
  },
): ConversationScanPage {
  return selectConversationRows(scope, {
    ...(options.channel ? { channel: options.channel } : {}),
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
    ...(options.afterCursor !== undefined ? { afterRowId: options.afterCursor } : {}),
    throughRowId: options.throughCursor,
  });
}

/** Resolves an opaque address to one exact channel target and its context binding, when present. */
export function resolveConversation(
  scope: ConversationRegistryScope,
  conversationRef: string,
): ConversationRecord | undefined {
  return selectConversationRows(scope, {
    conversationRef: normalizeConversationRef(conversationRef),
    limit: 1,
  }).conversations[0];
}
