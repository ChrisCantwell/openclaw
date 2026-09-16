/**
 * Tests for gateway secret resolution and redacted secret method responses.
 */

import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const storeMocks = vi.hoisted(() => ({
  deleteEntry: vi.fn(),
  listEntries: vi.fn(() => [] as Array<Record<string, unknown>>),
  purgeEntries: vi.fn(() => 0),
  writeEntry: vi.fn(),
  getSnapshot: vi.fn(() => ({ sourceConfig: {} })),
  collectRefKeys: vi.fn((_config: unknown, _name: string) => new Set<string>()),
  listAssignments: vi.fn(() => [] as string[]),
  hasAssignment: vi.fn(() => false),
  countAssignments: vi.fn(() => 0),
  listEffectiveNames: vi.fn(() => [] as string[]),
  hasEffectiveAccess: vi.fn(() => false),
  listAssignmentsAdmin: vi.fn(() => ({
    assignments: [] as Array<{ agentId: string; names: string[] }>,
    nextCursor: undefined as string | undefined,
  })),
  writeAssignment: vi.fn(),
  deleteAssignment: vi.fn(),
  getEntryMetadata: vi.fn(
    () =>
      null as {
        name: string;
        kind: string;
        scopeKind: string;
        scopeId: string;
        createdAtMs: number;
        updatedAtMs: number;
        valuePreview?: string;
        audience?: string;
        allowedHosts?: string[];
      } | null,
  ),
}));

vi.mock("../../secrets/assignment-store.js", () => ({
  AgentSecretAssignmentValidationError: class AgentSecretAssignmentValidationError extends Error {},
  countAgentSecretAssignments: storeMocks.countAssignments,
  deleteAgentSecretAssignment: storeMocks.deleteAssignment,
  listAgentSecretAssignments: storeMocks.listAssignments,
  listAgentSecretAssignmentsAdmin: storeMocks.listAssignmentsAdmin,
  hasAgentSecretAssignment: storeMocks.hasAssignment,
  writeAgentSecretAssignment: storeMocks.writeAssignment,
}));

vi.mock("../../secrets/runtime-state.js", () => ({
  collectSecretStoreRefKeysInSnapshot: storeMocks.collectRefKeys,
  getActiveSecretsRuntimeSnapshotState: storeMocks.getSnapshot,
}));

vi.mock("../../secrets/store/secret-store.js", () => {
  class SecretStoreValidationError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message);
      this.name = "SecretStoreValidationError";
    }
  }
  return {
    deleteSecretStoreEntry: storeMocks.deleteEntry,
    getSecretStoreEntryMetadata: storeMocks.getEntryMetadata,
    hasEffectiveAgentSecretAccess: storeMocks.hasEffectiveAccess,
    listEffectiveAgentSecretNames: storeMocks.listEffectiveNames,
    listSecretStoreEntries: storeMocks.listEntries,
    purgeExpiredSecretStoreEntries: storeMocks.purgeEntries,
    SecretStoreValidationError,
    writeSecretStoreEntry: storeMocks.writeEntry,
  };
});

// Assignment-scope lookups live in their own module; mock the same path the
// handler imports so the interception applies.
vi.mock("../../secrets/store/secret-store-agent-access.js", () => ({
  hasEffectiveAgentSecretAccess: storeMocks.hasEffectiveAccess,
  listEffectiveAgentSecretNames: storeMocks.listEffectiveNames,
}));

// Handler tests only need the registry verdicts they exercise. Dedicated
// target-registry tests own bundled plugin discovery and compilation.
vi.mock("../../secrets/target-registry.js", () => ({
  isKnownCoreSecretTargetId: (value: unknown) => value === "talk.providers.*.apiKey",
  isKnownSecretTargetId: () => false,
}));

import { isSecretValueRegisteredForRedaction } from "../../logging/secret-redaction-registry.js";
import {
  TALK_TEST_PROVIDER_API_KEY_PATH,
  TALK_TEST_PROVIDER_API_KEY_PATH_SEGMENTS,
} from "../../test-utils/talk-test-provider.js";
import { createSecretsHandlers, createSecretStoreWriteService } from "./secrets.js";

async function invokeSecretsReload(params: {
  handlers: ReturnType<typeof createSecretsHandlers>;
  respond: ReturnType<typeof vi.fn>;
}) {
  await expectDefined(
    params.handlers["secrets.reload"],
    'params.handlers["secrets.reload"] test invariant',
  )({
    req: { type: "req", id: "1", method: "secrets.reload" },
    params: {},
    client: null,
    isWebchatConnect: () => false,
    respond: params.respond as unknown as Parameters<
      ReturnType<typeof createSecretsHandlers>["secrets.reload"]
    >[0]["respond"],
    context: {} as never,
  });
}

async function invokeSecretsResolve(params: {
  handlers: ReturnType<typeof createSecretsHandlers>;
  respond: ReturnType<typeof vi.fn>;
  commandName: unknown;
  targetIds: unknown;
  allowedPaths?: unknown;
  forcedActivePaths?: unknown;
}) {
  await expectDefined(
    params.handlers["secrets.resolve"],
    'params.handlers["secrets.resolve"] test invariant',
  )({
    req: { type: "req", id: "1", method: "secrets.resolve" },
    params: {
      commandName: params.commandName,
      targetIds: params.targetIds,
      ...(params.allowedPaths !== undefined ? { allowedPaths: params.allowedPaths } : {}),
      ...(params.forcedActivePaths !== undefined
        ? { forcedActivePaths: params.forcedActivePaths }
        : {}),
    },
    client: null,
    isWebchatConnect: () => false,
    respond: params.respond as unknown as Parameters<
      ReturnType<typeof createSecretsHandlers>["secrets.resolve"]
    >[0]["respond"],
    context: {} as never,
  });
}

async function invokeStoreMethod(params: {
  handlers: ReturnType<typeof createSecretsHandlers>;
  method: "secrets.store.list" | "secrets.store.set" | "secrets.store.delete";
  requestParams: Record<string, unknown>;
  respond: ReturnType<typeof vi.fn>;
}) {
  await expectDefined(
    params.handlers[params.method],
    `handler ${params.method}`,
  )({
    req: { type: "req", id: "store-1", method: params.method },
    params: params.requestParams,
    client: {
      connect: {
        minProtocol: 1,
        maxProtocol: 1,
        client: {
          id: "control-ui",
          version: "test",
          platform: "web",
          mode: "webchat",
          displayName: "Control UI",
        },
        role: "operator",
        scopes: ["operator.admin"],
      },
    } as never,
    isWebchatConnect: () => false,
    respond: params.respond as never,
    context: {} as never,
  });
}

async function invokeAssignmentMethod(params: {
  handlers: ReturnType<typeof createSecretsHandlers>;
  method: "secrets.assignments.list" | "secrets.assignments.has" | "secrets.assignments.entry";
  requestParams: Record<string, unknown>;
  respond: ReturnType<typeof vi.fn>;
  agentId?: string;
  validateAuthority?: () => boolean;
}) {
  await expectDefined(
    params.handlers[params.method],
    `handler ${params.method}`,
  )({
    req: { type: "req", id: "assignment-1", method: params.method },
    params: params.requestParams,
    client: params.agentId
      ? ({ internal: { agentRuntimeIdentity: { agentId: params.agentId } } } as never)
      : null,
    isWebchatConnect: () => false,
    respond: params.respond as never,
    context: (params.validateAuthority
      ? { validateAgentRuntimeApprovalAuthority: params.validateAuthority }
      : {}) as never,
  });
}

function expectRespondError(
  respond: ReturnType<typeof vi.fn>,
  expected: { code: string; message?: string },
): void {
  const call = respond.mock.calls.at(0);
  expect(call?.[0]).toBe(false);
  expect(call?.[1]).toBeUndefined();
  const error = call?.[2];
  if (!error || typeof error !== "object" || Array.isArray(error)) {
    throw new Error("Expected a non-array error record");
  }
  const errorRecord = error as Record<string, unknown>;
  expect(errorRecord.code).toBe(expected.code);
  if (expected.message !== undefined) {
    expect(errorRecord.message).toBe(expected.message);
  }
}

function expectWarnMessageWith(warn: ReturnType<typeof vi.fn>, text: string): void {
  expect(warn.mock.calls.map(([message]) => String(message)).join("\n")).toContain(text);
}

async function expectMemoryStatusResolveUnavailable(params: {
  handlers: ReturnType<typeof createSecretsHandlers>;
  warn: ReturnType<typeof vi.fn>;
  warningText: string;
}) {
  const respond = vi.fn();
  await invokeSecretsResolve({
    handlers: params.handlers,
    respond,
    commandName: "memory status",
    targetIds: ["talk.providers.*.apiKey"],
  });
  expectRespondError(respond, {
    code: "UNAVAILABLE",
    message: "secrets.resolve failed",
  });
  expectWarnMessageWith(params.warn, params.warningText);
}

describe("secrets handlers", () => {
  beforeEach(() => {
    storeMocks.deleteEntry.mockReset();
    storeMocks.listEntries.mockReset().mockReturnValue([]);
    storeMocks.purgeEntries.mockReset().mockReturnValue(0);
    storeMocks.writeEntry.mockReset();
    storeMocks.getSnapshot.mockReset().mockReturnValue({ sourceConfig: {} });
    storeMocks.collectRefKeys.mockReset().mockReturnValue(new Set());
    storeMocks.listEffectiveNames.mockReset().mockReturnValue([]);
    storeMocks.hasEffectiveAccess.mockReset().mockReturnValue(false);
  });

  function createHandlers(overrides?: {
    reloadSecrets?: (options?: {
      forceColdRefKeys?: ReadonlySet<string>;
      joinInFlight?: boolean;
    }) => Promise<{ warningCount: number }>;
    resolveSecrets?: (params: {
      commandName: string;
      targetIds: string[];
      allowedPaths?: string[];
      forcedActivePaths?: string[];
    }) => Promise<{
      assignments: Array<{ path: string; pathSegments: string[]; value: unknown }>;
      diagnostics: string[];
      inactiveRefPaths: string[];
    }>;
    log?: { warn?: (message: string) => void };
    configAccess?: {
      readAgentAssignmentEnforcement: () => "off" | "advisory" | "enforce";
      writeAgentAssignmentEnforcement: (mode: "off" | "advisory" | "enforce") => Promise<void>;
      enforcementObservationTimeoutMs?: number;
    };
  }) {
    const reloadSecrets = overrides?.reloadSecrets ?? (async () => ({ warningCount: 0 }));
    const resolveSecrets =
      overrides?.resolveSecrets ??
      (async () => ({
        assignments: [],
        diagnostics: [],
        inactiveRefPaths: [],
      }));
    return createSecretsHandlers({
      reloadSecrets,
      storeWriteService: createSecretStoreWriteService({ reloadSecrets, log: overrides?.log }),
      configAccess:
        overrides?.configAccess ??
        ({
          readAgentAssignmentEnforcement: () => "off",
          writeAgentAssignmentEnforcement: async () => {},
        } as const),
      resolveSecrets,
      log: overrides?.log,
    });
  }

  it("responds with warning count on successful reload", async () => {
    const handlers = createHandlers({
      reloadSecrets: vi.fn().mockResolvedValue({ warningCount: 2 }),
    });
    const respond = vi.fn();
    await invokeSecretsReload({ handlers, respond });
    expect(respond).toHaveBeenCalledWith(true, { ok: true, warningCount: 2 });
  });

  it("returns unavailable when reload fails", async () => {
    const warn = vi.fn();
    const handlers = createHandlers({
      reloadSecrets: vi.fn().mockRejectedValue(new Error("disk full")),
      log: { warn },
    });
    const respond = vi.fn();
    await invokeSecretsReload({ handlers, respond });
    expectRespondError(respond, {
      code: "UNAVAILABLE",
      message: "secrets.reload failed",
    });
    expectWarnMessageWith(warn, "disk full");
  });

  it("resolves requested command secret assignments from the active snapshot", async () => {
    const resolveSecrets = vi.fn().mockResolvedValue({
      assignments: [
        {
          path: TALK_TEST_PROVIDER_API_KEY_PATH,
          pathSegments: [...TALK_TEST_PROVIDER_API_KEY_PATH_SEGMENTS],
          value: "sk",
        },
      ],
      diagnostics: ["note"],
      inactiveRefPaths: [TALK_TEST_PROVIDER_API_KEY_PATH],
    });
    const handlers = createHandlers({ resolveSecrets });
    const respond = vi.fn();
    await invokeSecretsResolve({
      handlers,
      respond,
      commandName: "memory status",
      targetIds: ["talk.providers.*.apiKey"],
      allowedPaths: [TALK_TEST_PROVIDER_API_KEY_PATH],
      forcedActivePaths: [TALK_TEST_PROVIDER_API_KEY_PATH],
    });
    expect(resolveSecrets).toHaveBeenCalledWith({
      commandName: "memory status",
      targetIds: ["talk.providers.*.apiKey"],
      allowedPaths: [TALK_TEST_PROVIDER_API_KEY_PATH],
      forcedActivePaths: [TALK_TEST_PROVIDER_API_KEY_PATH],
    });
    expect(respond).toHaveBeenCalledWith(true, {
      ok: true,
      assignments: [
        {
          path: TALK_TEST_PROVIDER_API_KEY_PATH,
          pathSegments: [...TALK_TEST_PROVIDER_API_KEY_PATH_SEGMENTS],
          value: "sk",
        },
      ],
      diagnostics: ["note"],
      inactiveRefPaths: [TALK_TEST_PROVIDER_API_KEY_PATH],
    });
  });

  it("rejects invalid secrets.resolve params", async () => {
    const handlers = createHandlers();
    const respond = vi.fn();
    await invokeSecretsResolve({
      handlers,
      respond,
      commandName: "",
      targetIds: "bad",
    });
    expectRespondError(respond, { code: "INVALID_REQUEST" });
  });

  it("rejects secrets.resolve params when targetIds entries are not strings", async () => {
    const resolveSecrets = vi.fn();
    const handlers = createHandlers({ resolveSecrets });
    const respond = vi.fn();
    await invokeSecretsResolve({
      handlers,
      respond,
      commandName: "memory status",
      targetIds: ["talk.providers.*.apiKey", 12],
    });
    expect(resolveSecrets).not.toHaveBeenCalled();
    expectRespondError(respond, {
      code: "INVALID_REQUEST",
      message: "invalid secrets.resolve params: targetIds",
    });
  });

  it("rejects unknown secrets.resolve target ids", async () => {
    const resolveSecrets = vi.fn();
    const handlers = createHandlers({ resolveSecrets });
    const respond = vi.fn();
    await invokeSecretsResolve({
      handlers,
      respond,
      commandName: "memory status",
      targetIds: ["unknown.target"],
    });
    expect(resolveSecrets).not.toHaveBeenCalled();
    expectRespondError(respond, {
      code: "INVALID_REQUEST",
      message: 'invalid secrets.resolve params: unknown target id "unknown.target"',
    });
  });

  it("returns unavailable when secrets.resolve handler returns an invalid payload shape", async () => {
    const warn = vi.fn();
    const resolveSecrets = vi.fn().mockResolvedValue({
      assignments: [{ path: TALK_TEST_PROVIDER_API_KEY_PATH, pathSegments: [""], value: "sk" }],
      diagnostics: [],
      inactiveRefPaths: [],
    });
    const handlers = createHandlers({ resolveSecrets, log: { warn } });
    await expectMemoryStatusResolveUnavailable({
      handlers,
      warn,
      warningText: "secrets.resolve returned invalid payload.",
    });
  });

  it("logs error details when secrets.resolve throws", async () => {
    const warn = vi.fn();
    const handlers = createHandlers({
      resolveSecrets: vi.fn().mockRejectedValue(new Error("EACCES: permission denied")),
      log: { warn },
    });
    await expectMemoryStatusResolveUnavailable({
      handlers,
      warn,
      warningText: "EACCES: permission denied",
    });
  });

  it("lists env values without structurally disclosing secret values", async () => {
    storeMocks.listEntries.mockReturnValueOnce([
      {
        name: "SERVICE_API_KEY",
        kind: "secret",
        scopeKind: "team",
        scopeId: "",
        audience: "selected",
        createdAtMs: 1,
        updatedAtMs: 2,
        updatedBy: "Operator",
        allowedHosts: ["api.example.com"],
        valuePreview: "malicious-leak",
      },
      {
        name: "SERVICE_URL",
        kind: "env",
        scopeKind: "team",
        scopeId: "",
        audience: "all",
        createdAtMs: 1,
        updatedAtMs: 2,
        updatedBy: "Operator",
        valuePreview: "https://service.test",
      },
    ]);
    const respond = vi.fn();
    await invokeStoreMethod({
      handlers: createHandlers(),
      method: "secrets.store.list",
      requestParams: {},
      respond,
    });
    expect(respond.mock.calls[0]?.[1]).toMatchObject({
      entries: [
        {
          name: "SERVICE_API_KEY",
          kind: "secret",
          audience: "selected",
          allowedHosts: ["api.example.com"],
        },
        { name: "SERVICE_URL", kind: "env", audience: "all", value: "https://service.test" },
      ],
    });
    expect(JSON.stringify(respond.mock.calls[0]?.[1])).not.toContain("malicious-leak");
  });

  it("refreshes the runtime only after mutations of referenced store names", async () => {
    storeMocks.collectRefKeys.mockImplementation((_config, name) =>
      name === "SERVICE_API_KEY" ? new Set(["store:default:SERVICE_API_KEY"]) : new Set(),
    );
    const reloadSecrets = vi.fn().mockResolvedValue({ warningCount: 2 });
    storeMocks.getSnapshot.mockReturnValue({
      sourceConfig: {
        models: {
          providers: {
            test: {
              apiKey: { source: "store", provider: "default", id: "SERVICE_API_KEY" },
            },
          },
        },
      },
    });
    const handlers = createHandlers({ reloadSecrets });

    const setRespond = vi.fn();
    await invokeStoreMethod({
      handlers,
      method: "secrets.store.set",
      requestParams: {
        name: "SERVICE_API_KEY",
        value: "new-value",
        kind: "secret",
        allowedHosts: ["api.example.com"],
      },
      respond: setRespond,
    });
    expect(storeMocks.writeEntry).toHaveBeenCalledWith({
      scope: { kind: "team" },
      name: "SERVICE_API_KEY",
      value: "new-value",
      kind: "secret",
      allowedHosts: ["api.example.com"],
      updatedBy: "Control UI",
    });
    expect(setRespond).toHaveBeenCalledWith(true, {
      ok: true,
      reloaded: true,
      warningCount: 2,
    });

    const deleteRespond = vi.fn();
    await invokeStoreMethod({
      handlers,
      method: "secrets.store.delete",
      requestParams: { name: "SERVICE_URL" },
      respond: deleteRespond,
    });
    expect(deleteRespond).toHaveBeenCalledWith(true, { ok: true, reloaded: false });
    expect(reloadSecrets).toHaveBeenCalledTimes(1);
    expect(reloadSecrets).toHaveBeenCalledWith({
      forceColdRefKeys: new Set(["store:default:SERVICE_API_KEY"]),
      joinInFlight: false,
    });
  });

  it("registers submitted store values for redaction before a failing write", async () => {
    const value = "test-secret-value-redaction-before-write-123";
    storeMocks.writeEntry.mockImplementationOnce(() => {
      expect(isSecretValueRegisteredForRedaction(value)).toBe(true);
      throw new Error("database unavailable");
    });
    const respond = vi.fn();

    await invokeStoreMethod({
      handlers: createHandlers(),
      method: "secrets.store.set",
      requestParams: { name: "SERVICE_API_KEY", value, kind: "secret" },
      respond,
    });

    expectRespondError(respond, { code: "UNAVAILABLE", message: "secrets.store.set failed" });
    expect(isSecretValueRegisteredForRedaction(value)).toBe(true);
  });

  it("rejects invalid store params before writing", async () => {
    const respond = vi.fn();
    await invokeStoreMethod({
      handlers: createHandlers(),
      method: "secrets.store.set",
      requestParams: { name: "lowercase", value: "value", kind: "secret" },
      respond,
    });
    expect(storeMocks.writeEntry).not.toHaveBeenCalled();
    expectRespondError(respond, { code: "INVALID_REQUEST" });
  });

  it("reports a saved entry when its required runtime refresh fails", async () => {
    storeMocks.collectRefKeys.mockReturnValue(new Set(["store:default:SERVICE_API_KEY"]));
    const handlers = createHandlers({
      reloadSecrets: vi.fn().mockRejectedValue(new Error("provider unavailable")),
    });
    const respond = vi.fn();

    await invokeStoreMethod({
      handlers,
      method: "secrets.store.set",
      requestParams: { name: "SERVICE_API_KEY", value: "new-value", kind: "secret" },
      respond,
    });

    expect(storeMocks.writeEntry).toHaveBeenCalledOnce();
    expectRespondError(respond, {
      code: "UNAVAILABLE",
      message:
        "Secret store entry was saved, but post-write runtime refresh failed. Resolve provider errors and retry secrets.reload.",
    });
  });

  it("derives assignment-list scope only from live runtime identity", async () => {
    storeMocks.listEffectiveNames.mockReturnValueOnce(["DUMMY_API_KEY"]);
    const respond = vi.fn();
    await invokeAssignmentMethod({
      handlers: createHandlers(),
      method: "secrets.assignments.list",
      requestParams: {},
      respond,
      agentId: "dummy-agent",
      validateAuthority: () => true,
    });

    expect(storeMocks.listEffectiveNames).toHaveBeenCalledWith({ agentId: "dummy-agent" });
    expect(respond).toHaveBeenCalledWith(true, {
      names: ["DUMMY_API_KEY"],
      total: 1,
      truncated: false,
    });
    expect(JSON.stringify(respond.mock.calls[0]?.[1])).not.toContain("provider");
  });

  it("rejects assignment lookup without identity, stale authority, or valid name", async () => {
    const handlers = createHandlers();
    const noIdentity = vi.fn();
    await invokeAssignmentMethod({
      handlers,
      method: "secrets.assignments.list",
      requestParams: {},
      respond: noIdentity,
    });
    expectRespondError(noIdentity, { code: "INVALID_REQUEST" });

    const stale = vi.fn();
    await invokeAssignmentMethod({
      handlers,
      method: "secrets.assignments.has",
      requestParams: { name: "DUMMY_API_KEY" },
      respond: stale,
      agentId: "dummy-agent",
      validateAuthority: () => false,
    });
    expectRespondError(stale, {
      code: "INVALID_REQUEST",
      message: "agent runtime authority is no longer active",
    });

    const malformed = vi.fn();
    await invokeAssignmentMethod({
      handlers,
      method: "secrets.assignments.has",
      requestParams: { name: "../DUMMY_API_KEY", agentId: "other-agent" },
      respond: malformed,
      agentId: "dummy-agent",
    });
    expectRespondError(malformed, { code: "INVALID_REQUEST" });
    expect(storeMocks.hasAssignment).not.toHaveBeenCalled();
  });

  it("secrets.assignments.entry returns one value-free entry derived from runtime identity", async () => {
    storeMocks.getEntryMetadata.mockReturnValueOnce({
      name: "SERVICE_URL",
      kind: "env",
      scopeKind: "team",
      scopeId: "",
      createdAtMs: 1,
      updatedAtMs: 2,
      valuePreview: "https://service.test",
    });
    const respond = vi.fn();
    await invokeAssignmentMethod({
      handlers: createHandlers(),
      method: "secrets.assignments.entry",
      requestParams: { name: "SERVICE_URL" },
      respond,
      agentId: "dummy-agent",
      validateAuthority: () => true,
    });
    expect(storeMocks.getEntryMetadata).toHaveBeenCalledWith({
      scope: { kind: "team" },
      name: "SERVICE_URL",
    });
    expect(respond).toHaveBeenCalledWith(true, {
      entry: {
        name: "SERVICE_URL",
        kind: "env",
        scopeKind: "team",
        scopeId: "",
        createdAtMs: 1,
        updatedAtMs: 2,
      },
    });
    expect(JSON.stringify(respond.mock.calls[0]?.[1])).not.toContain("https://service.test");
    expect(JSON.stringify(respond.mock.calls[0]?.[1])).not.toContain("valuePreview");
  });

  it("secrets.assignments.entry reports a missing entry as null without inventory", async () => {
    storeMocks.getEntryMetadata.mockReturnValueOnce(null);
    const respond = vi.fn();
    await invokeAssignmentMethod({
      handlers: createHandlers(),
      method: "secrets.assignments.entry",
      requestParams: { name: "GONE_API_KEY" },
      respond,
      agentId: "dummy-agent",
      validateAuthority: () => true,
    });
    expect(respond).toHaveBeenCalledWith(true, { entry: null });
  });

  it("admin assignment methods use explicit agent ids and never accept values", async () => {
    const handlers = createHandlers();
    const listRespond = vi.fn();
    storeMocks.listAssignmentsAdmin.mockReturnValueOnce({
      assignments: [{ agentId: "agent-a", names: ["DUMMY_API_KEY"] }],
      nextCursor: "agent-a|DUMMY_API_KEY",
    });
    await handlers["secrets.assignments.admin.list"]({
      req: { type: "req", id: "admin-1", method: "secrets.assignments.admin.list" },
      params: {},
      client: null,
      isWebchatConnect: () => false,
      respond: listRespond as never,
      context: {} as never,
    });
    expect(storeMocks.listAssignmentsAdmin).toHaveBeenCalledWith({ cursor: undefined });
    expect(listRespond).toHaveBeenCalledWith(true, {
      assignments: [{ agentId: "agent-a", names: ["DUMMY_API_KEY"] }],
      nextCursor: "agent-a|DUMMY_API_KEY",
    });

    const assignRespond = vi.fn();
    await handlers["secrets.assignments.admin.assign"]({
      req: { type: "req", id: "admin-2", method: "secrets.assignments.admin.assign" },
      params: { agentId: "Agent-B", name: "DUMMY_API_KEY", providerHint: " dummy " },
      client: { authenticatedUserProfile: { displayName: " Operator " } } as never,
      isWebchatConnect: () => false,
      respond: assignRespond as never,
      context: {} as never,
    });
    expect(storeMocks.writeAssignment).toHaveBeenCalledWith({
      agentId: "Agent-B",
      secretName: "DUMMY_API_KEY",
      // The handler passes the hint through raw; the store normalizes it.
      providerHint: " dummy ",
      assignedBy: "Operator",
    });
    expect(assignRespond).toHaveBeenCalledWith(true, { ok: true });

    const unassignRespond = vi.fn();
    await handlers["secrets.assignments.admin.unassign"]({
      req: { type: "req", id: "admin-3", method: "secrets.assignments.admin.unassign" },
      params: { agentId: "agent-b", name: "DUMMY_API_KEY" },
      client: null,
      isWebchatConnect: () => false,
      respond: unassignRespond as never,
      context: {} as never,
    });
    expect(storeMocks.deleteAssignment).toHaveBeenCalledWith({
      agentId: "agent-b",
      secretName: "DUMMY_API_KEY",
    });
    expect(unassignRespond).toHaveBeenCalledWith(true, { ok: true });
  });

  it("enforcement get/set read and write operator config", async () => {
    let mode: "off" | "advisory" | "enforce" = "off";
    const handlers = createHandlers({
      configAccess: {
        readAgentAssignmentEnforcement: () => mode,
        writeAgentAssignmentEnforcement: async (next) => {
          await Promise.resolve();
          mode = next;
        },
      },
    });
    const getRespond = vi.fn();
    await handlers["secrets.assignments.enforcement.get"]({
      req: { type: "req", id: "enf-1", method: "secrets.assignments.enforcement.get" },
      params: {},
      client: null,
      isWebchatConnect: () => false,
      respond: getRespond as never,
      context: {} as never,
    });
    expect(getRespond).toHaveBeenCalledWith(true, { mode: "off" });

    const setRespond = vi.fn();
    await handlers["secrets.assignments.enforcement.set"]({
      req: { type: "req", id: "enf-2", method: "secrets.assignments.enforcement.set" },
      params: { mode: "advisory" },
      client: null,
      isWebchatConnect: () => false,
      respond: setRespond as never,
      context: {} as never,
    });
    await vi.waitFor(() => {
      expect(setRespond).toHaveBeenCalled();
    });
    expect(mode).toBe("advisory");
    expect(setRespond).toHaveBeenCalledWith(true, { ok: true, mode: "advisory" });
  });

  it("enforcement set confirms against the live runtime source, not the request echo", async () => {
    // Simulates the real configAccess contract: an async durable write whose
    // runtime refresh lands inside the awaited mutation. The handler must
    // observe the mode via readAgentAssignmentEnforcement — the same source
    // enforcement.get uses — before reporting success.
    let mode: "off" | "advisory" | "enforce" = "off";
    const handlers = createHandlers({
      configAccess: {
        readAgentAssignmentEnforcement: () => mode,
        writeAgentAssignmentEnforcement: async (next) => {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 5);
          });
          mode = next;
        },
      },
    });
    const setRespond = vi.fn();
    await handlers["secrets.assignments.enforcement.set"]({
      req: { type: "req", id: "enf-3", method: "secrets.assignments.enforcement.set" },
      params: { mode: "enforce" },
      client: null,
      isWebchatConnect: () => false,
      respond: setRespond as never,
      context: {} as never,
    });
    await vi.waitFor(() => {
      expect(setRespond).toHaveBeenCalled();
    });
    expect(setRespond).toHaveBeenCalledWith(true, { ok: true, mode: "enforce" });
  });

  it("enforcement set rejects when the durable write fails (never ok:true on failure)", async () => {
    const handlers = createHandlers({
      configAccess: {
        readAgentAssignmentEnforcement: () => "off",
        writeAgentAssignmentEnforcement: async () => {
          throw new Error("config write failed after retries");
        },
      },
    });
    const setRespond = vi.fn();
    await handlers["secrets.assignments.enforcement.set"]({
      req: { type: "req", id: "enf-4", method: "secrets.assignments.enforcement.set" },
      params: { mode: "enforce" },
      client: null,
      isWebchatConnect: () => false,
      respond: setRespond as never,
      context: {} as never,
    });
    await vi.waitFor(() => {
      expect(setRespond).toHaveBeenCalled();
    });
    const [ok, payload] = setRespond.mock.calls[0] as unknown as [
      boolean,
      { ok?: boolean } | undefined,
      unknown,
    ];
    expect(ok).toBe(false);
    expect(payload?.ok).toBeUndefined();
  });

  it("enforcement set rejects when the runtime does not observe the requested mode after persist", async () => {
    // A durable write that succeeds but whose runtime refresh has not landed
    // must not be reported as success: the requested mode is never echoed.
    const handlers = createHandlers({
      configAccess: {
        readAgentAssignmentEnforcement: () => "off",
        writeAgentAssignmentEnforcement: async () => {},
        enforcementObservationTimeoutMs: 100,
      },
    });
    const setRespond = vi.fn();
    await handlers["secrets.assignments.enforcement.set"]({
      req: { type: "req", id: "enf-5", method: "secrets.assignments.enforcement.set" },
      params: { mode: "enforce" },
      client: null,
      isWebchatConnect: () => false,
      respond: setRespond as never,
      context: {} as never,
    });
    await vi.waitFor(() => {
      expect(setRespond).toHaveBeenCalled();
    });
    const [ok, payload] = setRespond.mock.calls[0] as unknown as [
      boolean,
      { ok?: boolean; mode?: string } | undefined,
      unknown,
    ];
    expect(ok).toBe(false);
    expect(payload?.ok).toBeUndefined();
    expect(payload?.mode).toBeUndefined();
  });

  it("enforcement set succeeds when the runtime observer applies shortly after persist (persist first, observer later)", async () => {
    // Reproduces the live defect: the awaited durable write resolves before
    // the runtime snapshot observer lands (~0.85s in the live preview). The
    // handler must wait, bounded and condition-based, for the live source —
    // not fail on an immediate read, and not sleep blindly.
    let mode: "off" | "advisory" | "enforce" = "off";
    const handlers = createHandlers({
      configAccess: {
        readAgentAssignmentEnforcement: () => mode,
        writeAgentAssignmentEnforcement: async (next) => {
          // Durable persist completes immediately; the runtime observer
          // applies only after a delay longer than one poll interval.
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 5);
          });
          setTimeout(() => {
            mode = next;
          }, 80);
        },
      },
    });
    const setRespond = vi.fn();
    const startedAt = Date.now();
    await handlers["secrets.assignments.enforcement.set"]({
      req: { type: "req", id: "enf-6", method: "secrets.assignments.enforcement.set" },
      params: { mode: "enforce" },
      client: null,
      isWebchatConnect: () => false,
      respond: setRespond as never,
      context: {} as never,
    });
    await vi.waitFor(() => {
      expect(setRespond).toHaveBeenCalled();
    });
    expect(setRespond).toHaveBeenCalledWith(true, { ok: true, mode: "enforce" });
    // The success waited for the observer instead of returning instantly.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(75);
  });

  it("enforcement set fails after the bounded deadline when the runtime never observes the mode", async () => {
    // Persist succeeds but the observer never applies; the handler must fail
    // truthfully within the bounded deadline rather than hanging forever.
    const mode: "off" | "advisory" | "enforce" = "off";
    const handlers = createHandlers({
      configAccess: {
        readAgentAssignmentEnforcement: () => mode,
        writeAgentAssignmentEnforcement: async () => {
          // Persist lands; runtime observation never does.
        },
        enforcementObservationTimeoutMs: 300,
      },
    });
    const setRespond = vi.fn();
    const startedAt = Date.now();
    await handlers["secrets.assignments.enforcement.set"]({
      req: { type: "req", id: "enf-7", method: "secrets.assignments.enforcement.set" },
      params: { mode: "enforce" },
      client: null,
      isWebchatConnect: () => false,
      respond: setRespond as never,
      context: {} as never,
    });
    await vi.waitFor(() => {
      expect(setRespond).toHaveBeenCalled();
    });
    const [ok, payload] = setRespond.mock.calls[0] as unknown as [
      boolean,
      { ok?: boolean; mode?: string } | undefined,
      unknown,
    ];
    expect(ok).toBe(false);
    expect(payload?.ok).toBeUndefined();
    expect(payload?.mode).toBeUndefined();
    // The failure respected the bounded deadline (not an unbounded hang).
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(50);
    expect(elapsed).toBeLessThan(2_000);
  }, 5_000);

  it("enforcement set fails immediately when the runtime reports a superseding third mode", async () => {
    // Another writer moved the runtime to a third mode after our pre-write
    // read; waiting out the deadline against a lost race is pointless. Fail
    // fast, truthfully.
    const handlers = createHandlers({
      configAccess: {
        // Pre-write read sees "off" (via preWriteMode), but by the time the
        // confirmation polls, a superseding writer has set "advisory".
        readAgentAssignmentEnforcement: (() => {
          let reads = 0;
          return () => {
            reads += 1;
            return reads === 1 ? "off" : "advisory";
          };
        })(),
        writeAgentAssignmentEnforcement: async () => {},
      },
    });
    const setRespond = vi.fn();
    await handlers["secrets.assignments.enforcement.set"]({
      req: { type: "req", id: "enf-8", method: "secrets.assignments.enforcement.set" },
      params: { mode: "enforce" },
      client: null,
      isWebchatConnect: () => false,
      respond: setRespond as never,
      context: {} as never,
    });
    await vi.waitFor(() => {
      expect(setRespond).toHaveBeenCalled();
    });
    const [ok, payload] = setRespond.mock.calls[0] as unknown as [
      boolean,
      { ok?: boolean; mode?: string } | undefined,
      unknown,
    ];
    expect(ok).toBe(false);
    expect(payload?.ok).toBeUndefined();
    expect(payload?.mode).toBeUndefined();
  });

  it("admin list maps invalid cursor store errors to INVALID_REQUEST", async () => {
    const assignmentStore = await import("../../secrets/assignment-store.js");
    const { AgentSecretAssignmentValidationError } = assignmentStore;
    const listSpy = vi
      .spyOn(assignmentStore, "listAgentSecretAssignmentsAdmin")
      .mockImplementation(() => {
        throw new AgentSecretAssignmentValidationError(
          "AGENT_SECRET_ASSIGNMENT_INVALID_AGENT_ID",
          'Assignment inventory cursor must be "<agentId>|<secretName>".',
        );
      });
    try {
      const handlers = createHandlers({});
      const respond = vi.fn();
      await handlers["secrets.assignments.admin.list"]({
        req: { type: "req", id: "admin-cur", method: "secrets.assignments.admin.list" },
        params: { cursor: "bad-cursor" },
        client: null,
        isWebchatConnect: () => false,
        respond: respond as never,
        context: {} as never,
      });
      expect(respond).toHaveBeenCalled();
      const [ok, , error] = respond.mock.calls[0] as unknown as [
        boolean,
        unknown,
        { code: number; message: string },
      ];
      expect(ok).toBe(false);
      const { ErrorCodes } = await import("../../../packages/gateway-protocol/src/index.js");
      expect(error.code).toBe(ErrorCodes.INVALID_REQUEST);
      expect(typeof error.message).toBe("string");
      expect(error.message.length).toBeGreaterThan(0);
    } finally {
      listSpy.mockRestore();
    }
  });
});
