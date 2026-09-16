/**
 * Cross-agent inventory scoping for the model-facing secrets tool.
 *
 * Under enforcement the model-facing `list` must reveal nothing about entries
 * assigned only to another agent — no names, hosts, timestamps, or existence
 * signal. Identity is the tool's runtime agentId (constructor-derived), never
 * an action argument.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resetPendingAskUserQuestionsForTest } from "./ask-user-tool.test-support.js";
import { createSecretsTool } from "./secrets-tool.js";

type GatewayCall = NonNullable<Parameters<typeof createSecretsTool>[0]["gatewayCall"]>;

function gatewayStub(
  implementation: (
    method: string,
    opts: Record<string, unknown>,
    params: Record<string, unknown>,
    extra?: { signal?: AbortSignal; requireAgentRuntimeIdentity?: boolean },
  ) => Promise<unknown>,
) {
  const mock = vi.fn(implementation);
  return { mock, call: mock as unknown as GatewayCall };
}

const inventoryMetadata = {
  createdAtMs: 1_700_000_000_000,
  updatedAtMs: 1_700_000_001_000,
  scopeKind: "team",
  scopeId: "",
};
const otherEnv = {
  ...inventoryMetadata,
  name: "OTHER_AGENT_ENV",
  kind: "env" as const,
  audience: "selected",
  value: "other-env-plaintext",
  updatedAtMs: 1_700_000_001_000,
};
const otherSecret = {
  ...inventoryMetadata,
  name: "OTHER_AGENT_SECRET",
  kind: "secret" as const,
  audience: "selected",
  allowedHosts: ["api.other-agent.test"],
  updatedAtMs: 1_700_000_001_000,
};
const ownEntry = {
  ...inventoryMetadata,
  name: "OWN_SECRET",
  kind: "secret" as const,
  audience: "selected",
  allowedHosts: ["api.own.test"],
  updatedAtMs: 1_700_000_002_000,
};
const ownEnv = {
  ...inventoryMetadata,
  name: "OWN_ENV",
  kind: "env" as const,
  audience: "all",
  value: "own-env-plaintext",
  updatedAtMs: 1_700_000_002_000,
};
const enforcedConfig = {
  secrets: { agentAssignmentEnforcement: "enforce" },
} as unknown as OpenClawConfig;

function listGateway() {
  return gatewayStub(async (method) => {
    if (method === "secrets.store.list") {
      return { entries: [otherEnv, otherSecret, ownEntry, ownEnv] };
    }
    if (method === "secrets.assignments.list") {
      return { names: ["OWN_SECRET", "OWN_ENV"], total: 2, truncated: false };
    }
    throw new Error(`unexpected method ${method}`);
  });
}

afterEach(() => {
  resetPendingAskUserQuestionsForTest();
});

describe("secrets tool agent inventory scoping", () => {
  it("active-policy list is assignment-names-only and never calls the unscoped store listing", async () => {
    const gateway = gatewayStub(async (method) => {
      if (method === "secrets.store.list") {
        return { entries: [otherEnv, otherSecret, ownEntry, ownEnv] };
      }
      if (method === "secrets.assignments.list") {
        return { names: ["OWN_SECRET", "OWN_ENV"], total: 2, truncated: false };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const tool = createSecretsTool({
      config: enforcedConfig,
      agentId: "main",
      gatewayCall: gateway.call,
    });
    const result = await tool.execute("call-list", { action: "list" });
    const serialized = JSON.stringify(result);
    // Assigned names remain discoverable.
    expect(serialized).toContain("OWN_SECRET");
    expect(serialized).toContain("OWN_ENV");
    // Nothing from any other agent crosses: no names, hosts, timestamps,
    // existence signal, or plaintext.
    expect(serialized).not.toContain("OTHER_AGENT_ENV");
    expect(serialized).not.toContain("OTHER_AGENT_SECRET");
    expect(serialized).not.toContain("api.other-agent.test");
    expect(serialized).not.toContain("other-env-plaintext");
    expect(serialized).not.toContain("1700000001000");
    expect(serialized).not.toContain("api.own.test");
    // Regression guard: the identity-blind full-store listing is never called
    // under an active assignment policy, so its payload is never received.
    expect(gateway.mock.mock.calls.map(([method]) => method)).toEqual(["secrets.assignments.list"]);
    expect(gateway.mock).toHaveBeenCalledWith(
      "secrets.assignments.list",
      {},
      {},
      expect.objectContaining({ requireAgentRuntimeIdentity: true }),
    );
  });

  it("model list surfaces an explicit truncation signal when the inventory window is exceeded", async () => {
    const windowNames = Array.from({ length: 512 }, (_, index) => `OWN_SECRET_${index}`);
    const gateway = gatewayStub(async (method) => {
      if (method === "secrets.store.list") {
        return { entries: [otherEnv, otherSecret, ownEntry, ownEnv] };
      }
      if (method === "secrets.assignments.list") {
        return { names: windowNames, total: 600, truncated: true };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const tool = createSecretsTool({
      config: enforcedConfig,
      agentId: "main",
      gatewayCall: gateway.call,
    });
    const result = await tool.execute("call-list-truncated", { action: "list" });
    const serialized = JSON.stringify(result);
    // Incompleteness is explicit and actionable, never silent.
    expect(serialized).toContain('"truncated":true');
    expect(serialized).toContain('"total":600');
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining("first 512 of 600"),
    });
  });

  it("successful request under active policy uses the name-scoped entry read and never the unscoped store listing, even when that RPC would return foreign plaintext", async () => {
    const foreignEnv = {
      ...inventoryMetadata,
      name: "FOREIGN_AGENT_ENV",
      kind: "env" as const,
      audience: "selected",
      value: "foreign-env-plaintext",
    };
    let entryCalls = 0;
    const gateway = gatewayStub(async (method, _options, params) => {
      if (method === "question.request") {
        return { id: params.id };
      }
      if (method === "question.waitAnswer") {
        return { status: "answered", answers: { answers: { secret_value: ["stored"] } } };
      }
      if (method === "secrets.assignments.entry") {
        entryCalls += 1;
        expect(params).toEqual({ name: "OWN_SECRET" });
        return { entry: ownEntry };
      }
      // The identity-blind listing would hand the tool process the entire
      // team store, including foreign env plaintext. It must never be called
      // under an active policy, regardless of what it would return.
      if (method === "secrets.store.list") {
        throw new Error(
          `unscoped store listing must not be called under active policy: ${JSON.stringify([
            foreignEnv,
            otherSecret,
          ])}`,
        );
      }
      throw new Error(`unexpected method ${method}`);
    });
    const tool = createSecretsTool({
      config: enforcedConfig,
      agentId: "main",
      sessionKey: "agent:main:secrets",
      gatewayCall: gateway.call,
    });
    const result = await tool.execute("call-request-scoped", {
      action: "request",
      name: "OWN_SECRET",
      kind: "secret",
    });
    expect(entryCalls).toBe(1);
    expect(result.details).toMatchObject({
      status: "stored",
      name: "OWN_SECRET",
      currentPolicy: { status: "available", allowedHosts: ["api.own.test"] },
    });
    const methods = gateway.mock.mock.calls.map(([method]) => method);
    expect(methods).not.toContain("secrets.store.list");
    expect(methods).toEqual([
      "question.request",
      "question.waitAnswer",
      "secrets.assignments.entry",
    ]);
  });

  it("list never returns env values in text or structured output (all modes)", async () => {
    for (const config of [undefined, enforcedConfig]) {
      const gateway = listGateway();
      const tool = createSecretsTool({ config, agentId: "main", gatewayCall: gateway.call });
      const result = await tool.execute("call-list-redaction", { action: "list" });
      expect(JSON.stringify(result)).not.toContain("other-env-plaintext");
      expect(JSON.stringify(result)).not.toContain("own-env-plaintext");
      if (config === undefined) {
        expect(JSON.stringify(result)).toContain("<redacted");
      }
    }
  });

  it("off mode keeps the legacy full store listing with env redaction (not byte-identical legacy)", async () => {
    const gateway = listGateway();
    const tool = createSecretsTool({
      config: undefined,
      agentId: "main",
      gatewayCall: gateway.call,
    });
    const result = await tool.execute("call-list-off", { action: "list" });
    const serialized = JSON.stringify(result);
    expect(serialized).toContain("OTHER_AGENT_ENV");
    expect(serialized).toContain("OWN_SECRET");
    expect(gateway.mock.mock.calls.map(([method]) => method)).toEqual(["secrets.store.list"]);
  });

  it("advisory mode also scopes the model-facing list to assignment names only", async () => {
    const gateway = gatewayStub(async (method) => {
      if (method === "secrets.store.list") {
        return { entries: [otherEnv, otherSecret, ownEntry, ownEnv] };
      }
      if (method === "secrets.assignments.list") {
        return { names: ["OWN_SECRET", "OWN_ENV"], total: 2, truncated: false };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const tool = createSecretsTool({
      config: { secrets: { agentAssignmentEnforcement: "advisory" } } as unknown as OpenClawConfig,
      agentId: "main",
      gatewayCall: gateway.call,
    });
    const result = await tool.execute("call-list-advisory", { action: "list" });
    const serialized = JSON.stringify(result);
    expect(serialized).toContain("OWN_SECRET");
    expect(serialized).not.toContain("OTHER_AGENT_SECRET");
    expect(serialized).not.toContain("other-env-plaintext");
    expect(gateway.mock.mock.calls.map(([method]) => method)).toEqual(["secrets.assignments.list"]);
  });

  it("identity is runtime-derived: action arguments cannot select another agent", async () => {
    const gateway = listGateway();
    const tool = createSecretsTool({
      config: enforcedConfig,
      agentId: "main",
      gatewayCall: gateway.call,
    });
    // The schema has no agentId param: an attempted spoof argument is ignored,
    // and scoping still follows the runtime-derived identity ("main").
    const spoofed = await tool.execute("call-list-spoof", {
      action: "list",
      agentId: "other-agent",
    } as unknown as Record<string, unknown>);
    const spoofedSerialized = JSON.stringify(spoofed);
    expect(spoofedSerialized).not.toContain("OTHER_AGENT_SECRET");
    expect(spoofedSerialized).not.toContain("api.other-agent.test");
    expect(spoofedSerialized).toContain("OWN_SECRET");
    // The gateway identity call carries no caller-supplied agent selector.
    const identityCalls = gateway.mock.mock.calls.filter(
      ([method]) => method === "secrets.assignments.list",
    );
    expect(identityCalls.length).toBeGreaterThanOrEqual(1);
    for (const call of identityCalls) {
      expect(JSON.stringify(call[2])).not.toContain("other-agent");
    }
  });

  it("delete is refused generically under enforce (no cross-agent destructive mutation)", async () => {
    const gateway = gatewayStub(async (method) => {
      if (method === "secrets.store.list") {
        return { entries: [ownEntry] };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const tool = createSecretsTool({
      config: enforcedConfig,
      agentId: "main",
      gatewayCall: gateway.call,
    });
    const result = await tool.execute("call-delete", { action: "delete", name: "OWN_SECRET" });
    expect(JSON.stringify(result)).toContain("unavailable while agent assignment enforcement");
    expect(gateway.mock.mock.calls.map(([method]) => method)).toEqual([]);
  });

  it("delete is refused under advisory too (soak cannot delete another agent's entry)", async () => {
    const gateway = gatewayStub(async (method) => {
      throw new Error(`unexpected method ${method}`);
    });
    const tool = createSecretsTool({
      config: { secrets: { agentAssignmentEnforcement: "advisory" } } as unknown as OpenClawConfig,
      agentId: "main",
      gatewayCall: gateway.call,
    });
    const result = await tool.execute("call-delete-advisory", {
      action: "delete",
      name: "OTHER_AGENT_SECRET",
    });
    expect(JSON.stringify(result)).toContain("unavailable while agent assignment enforcement");
    expect(gateway.mock.mock.calls.map(([method]) => method)).toEqual([]);
  });

  it("delete remains available when enforcement is off (legacy behavior)", async () => {
    const gateway = gatewayStub(async (method) => {
      if (method === "secrets.store.delete") {
        return { ok: true };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const tool = createSecretsTool({
      config: undefined,
      agentId: "main",
      gatewayCall: gateway.call,
    });
    const result = await tool.execute("call-delete-off", {
      action: "delete",
      name: "OWN_SECRET",
    });
    expect(JSON.stringify(result)).toContain('"ok":true');
    expect(gateway.mock).toHaveBeenCalledWith(
      "secrets.store.delete",
      {},
      { name: "OWN_SECRET" },
      expect.objectContaining({ requireAgentRuntimeIdentity: true }),
    );
  });

  it("successful request with enforcement off still uses the name-scoped entry read and never the unscoped store listing", async () => {
    // The production request path is mode-agnostic. This regression pins that
    // a future `if (enforcement !== "off")` cannot revive `secrets.store.list`
    // on the post-request policy read.
    let entryCalls = 0;
    const gateway = gatewayStub(async (method, _options, params) => {
      if (method === "question.request") {
        return { id: params.id };
      }
      if (method === "question.waitAnswer") {
        return { status: "answered", answers: { answers: { secret_value: ["stored"] } } };
      }
      if (method === "secrets.assignments.entry") {
        entryCalls += 1;
        expect(params).toEqual({ name: "OWN_SECRET" });
        return { entry: ownEntry };
      }
      if (method === "secrets.store.list") {
        throw new Error(
          `unscoped store listing must not be called on the request path in any mode`,
        );
      }
      throw new Error(`unexpected method ${method}`);
    });
    const tool = createSecretsTool({
      config: undefined,
      agentId: "main",
      sessionKey: "agent:main:secrets",
      gatewayCall: gateway.call,
    });
    const result = await tool.execute("call-request-off", {
      action: "request",
      name: "OWN_SECRET",
      kind: "secret",
    });
    expect(entryCalls).toBe(1);
    expect(result.details).toMatchObject({
      status: "stored",
      name: "OWN_SECRET",
    });
    const methods = gateway.mock.mock.calls.map(([method]) => method);
    expect(methods).not.toContain("secrets.store.list");
    expect(methods).toEqual([
      "question.request",
      "question.waitAnswer",
      "secrets.assignments.entry",
    ]);
  });

  it("list_assigned_secret_names surfaces total and truncated when assignments exceed the presentation window", async () => {
    const windowNames = Array.from({ length: 512 }, (_, index) => `OWN_SECRET_${index}`);
    const gateway = gatewayStub(async (method) => {
      if (method === "secrets.assignments.list") {
        return { names: windowNames, total: 600, truncated: true };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const tool = createSecretsTool({
      config: enforcedConfig,
      agentId: "main",
      gatewayCall: gateway.call,
    });
    const result = await tool.execute("call-assigned-names-truncated", {
      action: "list_assigned_secret_names",
    });
    const structured = JSON.stringify(result);
    // Truthful accounting: count reflects the full total, and the 512-name
    // presentation window is explicitly disclosed — never a silent cap.
    expect(structured).toContain('"total":600');
    expect(structured).toContain('"truncated":true');
    expect(structured).toContain('"count":600');
    const parsed = JSON.parse(result.content[0].text) as {
      names: string[];
      count: number;
      total: number;
      truncated: boolean;
    };
    expect(parsed.names).toHaveLength(512);
    expect(parsed.count).toBe(600);
    expect(parsed.total).toBe(600);
    expect(parsed.truncated).toBe(true);
    expect(gateway.mock).toHaveBeenCalledWith(
      "secrets.assignments.list",
      {},
      {},
      expect.objectContaining({ requireAgentRuntimeIdentity: true }),
    );
  });

  it("list_assigned_secret_names reports an untruncated total within the window", async () => {
    const gateway = gatewayStub(async (method) => {
      if (method === "secrets.assignments.list") {
        return { names: ["OWN_SECRET", "OWN_ENV"], total: 2, truncated: false };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const tool = createSecretsTool({
      config: enforcedConfig,
      agentId: "main",
      gatewayCall: gateway.call,
    });
    const result = await tool.execute("call-assigned-names-small", {
      action: "list_assigned_secret_names",
    });
    const parsed = JSON.parse(result.content[0].text) as {
      names: string[];
      count: number;
      total: number;
      truncated: boolean;
    };
    expect(parsed.names).toHaveLength(2);
    expect(parsed.count).toBe(2);
    expect(parsed.total).toBe(2);
    expect(parsed.truncated).toBe(false);
  });
});
