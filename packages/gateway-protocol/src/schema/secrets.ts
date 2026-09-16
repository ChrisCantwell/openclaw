// Gateway Protocol schema module defines protocol validation shapes.
import { Type, type Static } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";
import { withSince } from "./since.js";

/**
 * Secret-provider protocol schemas.
 *
 * These payloads request secret materialization from the gateway while keeping
 * caller scope, allowed paths, and provider overrides explicit.
 */
/** Empty request payload for reloading configured secret providers. */
export const SecretsReloadParamsSchema = closedObject({});

export const SecretStoreNameSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Z][A-Z0-9_]{0,127}$",
});

export const GitHubSetupHandleSchema = Type.String({
  pattern: "^github-setup-[a-f0-9]{32}$",
});

const SecretStoreMutationNameSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^(?:[A-Z][A-Z0-9_]{0,127}|github-setup-[a-f0-9]{32})$",
});

/** Audience axis: independent from value protection (kind). */
const SecretStoreAudienceSchema = Type.Union([Type.Literal("all"), Type.Literal("selected")]);

const SecretStoreEntryMetadataProperties = {
  name: SecretStoreNameSchema,
  scopeKind: Type.Literal("team"),
  scopeId: Type.Literal(""),
  audience: Type.Optional(withSince("2026.9", SecretStoreAudienceSchema)),
  createdAtMs: Type.Integer({ minimum: 0 }),
  updatedAtMs: Type.Integer({ minimum: 0 }),
  updatedBy: Type.Optional(Type.String()),
} as const;

const SecretStoreAllowedHostsSchema = Type.Array(Type.String({ minLength: 1, maxLength: 253 }), {
  maxItems: 128,
  uniqueItems: true,
});

/** Secret metadata never structurally carries the stored value. */
export const SecretStoreSecretEntrySchema = closedObject({
  ...SecretStoreEntryMetadataProperties,
  kind: Type.Literal("secret"),
  audience: withSince("2026.9", SecretStoreAudienceSchema),
  allowedHosts: Type.Optional(withSince("2026.8", SecretStoreAllowedHostsSchema)),
});

/** Environment entries include their value because they are intentionally visible. */
export const SecretStoreEnvEntrySchema = closedObject({
  ...SecretStoreEntryMetadataProperties,
  kind: Type.Literal("env"),
  audience: withSince("2026.9", SecretStoreAudienceSchema),
  value: Type.String({ maxLength: 64 * 1024 }),
});

/** Team secret-store list entry, discriminated by disclosure behavior. */
export const SecretStoreEntrySchema = Type.Union([
  SecretStoreSecretEntrySchema,
  SecretStoreEnvEntrySchema,
]);

/** Empty request payload for listing the team secret store. */
export const SecretsStoreListParamsSchema = closedObject({});

/** Team secret-store inventory. */
export const SecretsStoreListResultSchema = closedObject({
  entries: Type.Array(SecretStoreEntrySchema),
});

/** Create or replace one team secret-store entry. */
export const SecretsStoreSetParamsSchema = closedObject({
  name: SecretStoreMutationNameSchema,
  value: Type.String({ maxLength: 64 * 1024 }),
  kind: Type.Union([Type.Literal("secret"), Type.Literal("env")]),
  audience: Type.Optional(withSince("2026.9", SecretStoreAudienceSchema)),
  allowedHosts: Type.Optional(withSince("2026.8", SecretStoreAllowedHostsSchema)),
});

/** Soft-delete one team secret-store entry. */
export const SecretsStoreDeleteParamsSchema = closedObject({
  name: SecretStoreMutationNameSchema,
});

/** Mutation acknowledgement including whether the active runtime was refreshed. */
export const SecretsStoreMutationResultSchema = closedObject({
  ok: Type.Literal(true),
  reloaded: Type.Boolean(),
  warningCount: Type.Optional(Type.Integer({ minimum: 0 })),
});

/** Empty request payload; the Gateway derives the agent from runtime identity. */
export const SecretsAssignmentsListParamsSchema = closedObject({});

/** Names assigned to only the authenticated runtime agent. */
export const SecretsAssignmentsListResultSchema = closedObject({
  // Presentation-bounded window of the full assignment set; `total` and
  // `truncated` make incompleteness explicit instead of silently hiding names.
  names: Type.Array(SecretStoreNameSchema, { maxItems: 512 }),
  total: Type.Integer({ minimum: 0 }),
  truncated: Type.Boolean(),
});

/** Check one name for only the authenticated runtime agent. */
export const SecretsAssignmentsHasParamsSchema = closedObject({
  name: SecretStoreNameSchema,
});

/** Assignment existence only; provider metadata and values are intentionally absent. */
export const SecretsAssignmentsHasResultSchema = closedObject({
  assigned: Type.Boolean(),
});

/** Request one named entry's current metadata; the Gateway derives the agent scope. */
export const SecretsAssignmentsEntryParamsSchema = closedObject({
  name: SecretStoreNameSchema,
});

/** Metadata-only store entry: structurally value-free. */
export const SecretsAssignmentsEntrySchema = Type.Union([
  closedObject({
    ...SecretStoreEntryMetadataProperties,
    kind: Type.Literal("secret"),
    allowedHosts: Type.Optional(withSince("2026.8", SecretStoreAllowedHostsSchema)),
  }),
  closedObject({
    ...SecretStoreEntryMetadataProperties,
    kind: Type.Literal("env"),
  }),
]);

/**
 * Single-entry metadata result: absent entry stays `null` with no inventory.
 * Env-kind entries carry no value: this read exists for post-write host
 * policy, and no plaintext crosses the agent tool boundary through it.
 */
export const SecretsAssignmentsEntryResultSchema = closedObject({
  entry: Type.Union([SecretsAssignmentsEntrySchema, Type.Null()]),
});

/** Operator-admin: list every agent's assignment names, one page at a time. */
export const SecretsAssignmentsAdminListParamsSchema = closedObject({
  cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
});

export const SecretsAssignmentsAdminListResultSchema = closedObject({
  assignments: Type.Array(
    closedObject({
      agentId: NonEmptyString,
      names: Type.Array(SecretStoreNameSchema),
    }),
  ),
  nextCursor: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
});

/** Operator-admin: create or replace one assignment (metadata only, no values). */
export const SecretsAssignmentsAdminAssignParamsSchema = closedObject({
  agentId: NonEmptyString,
  name: SecretStoreNameSchema,
  providerHint: Type.Optional(Type.String({ maxLength: 128 })),
});

/** Operator-admin: remove one assignment. */
export const SecretsAssignmentsAdminUnassignParamsSchema = closedObject({
  agentId: NonEmptyString,
  name: SecretStoreNameSchema,
});

/** Operator-admin mutation acknowledgement. */
export const SecretsAssignmentsAdminMutationResultSchema = closedObject({
  ok: Type.Literal(true),
});

/** Operator-admin: read the current agent-assignment enforcement mode. */
export const SecretsAssignmentsEnforcementGetParamsSchema = closedObject({});

export const SecretsAssignmentsEnforcementGetResultSchema = closedObject({
  mode: Type.Union([Type.Literal("off"), Type.Literal("advisory"), Type.Literal("enforce")]),
});

/** Operator-admin: set the agent-assignment enforcement mode (persisted config). */
export const SecretsAssignmentsEnforcementSetParamsSchema = closedObject({
  mode: Type.Union([Type.Literal("off"), Type.Literal("advisory"), Type.Literal("enforce")]),
});

export const SecretsAssignmentsEnforcementSetResultSchema = closedObject({
  ok: Type.Literal(true),
  mode: Type.Union([Type.Literal("off"), Type.Literal("advisory"), Type.Literal("enforce")]),
});

export type SecretStoreEntry = Static<typeof SecretStoreEntrySchema>;
export type SecretsStoreListResult = Static<typeof SecretsStoreListResultSchema>;
export type SecretsStoreSetParams = Static<typeof SecretsStoreSetParamsSchema>;
export type SecretsStoreDeleteParams = Static<typeof SecretsStoreDeleteParamsSchema>;
export type SecretsStoreMutationResult = Static<typeof SecretsStoreMutationResultSchema>;
export type SecretsAssignmentsListResult = Static<typeof SecretsAssignmentsListResultSchema>;
export type SecretsAssignmentsHasParams = Static<typeof SecretsAssignmentsHasParamsSchema>;
export type SecretsAssignmentsHasResult = Static<typeof SecretsAssignmentsHasResultSchema>;
export type SecretsAssignmentsEntryParams = Static<typeof SecretsAssignmentsEntryParamsSchema>;
export type SecretsAssignmentsEntryResult = Static<typeof SecretsAssignmentsEntryResultSchema>;
export type SecretsAssignmentsEntry = Static<typeof SecretsAssignmentsEntrySchema>;
export type SecretsAssignmentsAdminListParams = Static<
  typeof SecretsAssignmentsAdminListParamsSchema
>;
export type SecretsAssignmentsAdminListResult = Static<
  typeof SecretsAssignmentsAdminListResultSchema
>;
export type SecretsAssignmentsAdminAssignParams = Static<
  typeof SecretsAssignmentsAdminAssignParamsSchema
>;
export type SecretsAssignmentsAdminUnassignParams = Static<
  typeof SecretsAssignmentsAdminUnassignParamsSchema
>;
export type SecretsAssignmentsAdminMutationResult = Static<
  typeof SecretsAssignmentsAdminMutationResultSchema
>;
export type SecretsAssignmentsEnforcementGetResult = Static<
  typeof SecretsAssignmentsEnforcementGetResultSchema
>;
export type SecretsAssignmentsEnforcementSetParams = Static<
  typeof SecretsAssignmentsEnforcementSetParamsSchema
>;
export type SecretsAssignmentsEnforcementSetResult = Static<
  typeof SecretsAssignmentsEnforcementSetResultSchema
>;

/** Request payload for resolving the secrets needed by one command invocation. */
export const SecretsResolveParamsSchema = closedObject({
  commandName: NonEmptyString,
  targetIds: Type.Array(NonEmptyString),
  allowedPaths: Type.Optional(Type.Array(NonEmptyString)),
  forcedActivePaths: Type.Optional(Type.Array(NonEmptyString)),
  optionalActivePaths: Type.Optional(Type.Array(NonEmptyString)),
  providerOverrides: Type.Optional(
    closedObject({
      webSearch: Type.Optional(NonEmptyString),
      webFetch: Type.Optional(NonEmptyString),
    }),
  ),
});

/** Static type for secret resolution requests. */
export type SecretsResolveParams = Static<typeof SecretsResolveParamsSchema>;

/** One resolved secret assignment path plus its provider-owned value. */
export const SecretsResolveAssignmentSchema = closedObject({
  path: Type.Optional(NonEmptyString),
  pathSegments: Type.Array(NonEmptyString),
  value: Type.Unknown(),
});

/** Secret resolution response with assignments and safe diagnostics. */
export const SecretsResolveResultSchema = closedObject({
  ok: Type.Optional(Type.Boolean()),
  assignments: Type.Optional(Type.Array(SecretsResolveAssignmentSchema)),
  diagnostics: Type.Optional(Type.Array(NonEmptyString)),
  inactiveRefPaths: Type.Optional(Type.Array(NonEmptyString)),
});

/** Static type for secret resolution responses. */
export type SecretsResolveResult = Static<typeof SecretsResolveResultSchema>;
