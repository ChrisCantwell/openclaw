import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  SecretsAssignmentsAdminAssignParamsSchema,
  SecretsAssignmentsAdminListResultSchema,
  SecretsAssignmentsEnforcementGetResultSchema,
  SecretsAssignmentsEnforcementSetParamsSchema,
  SecretsAssignmentsEntryParamsSchema,
  SecretsAssignmentsEntryResultSchema,
  SecretsAssignmentsHasParamsSchema,
  SecretsAssignmentsHasResultSchema,
  SecretsAssignmentsListParamsSchema,
  SecretsAssignmentsListResultSchema,
  SecretsStoreDeleteParamsSchema,
  SecretsStoreListResultSchema,
  SecretsStoreMutationResultSchema,
  SecretsStoreSetParamsSchema,
} from "./secrets.js";

const metadata = {
  name: "SERVICE_API_KEY",
  scopeKind: "team",
  scopeId: "",
  audience: "all",
  createdAtMs: 1,
  updatedAtMs: 2,
  updatedBy: "Operator",
};

describe("secret store protocol schemas", () => {
  it("keeps assignment discovery self-scoped and metadata-only", () => {
    expect(Value.Check(SecretsAssignmentsListParamsSchema, {})).toBe(true);
    expect(Value.Check(SecretsAssignmentsListParamsSchema, { agentId: "other-agent" })).toBe(false);
    expect(
      Value.Check(SecretsAssignmentsListResultSchema, {
        names: ["DUMMY_API_KEY"],
        total: 1,
        truncated: false,
      }),
    ).toBe(true);
    expect(Value.Check(SecretsAssignmentsListResultSchema, { names: ["DUMMY_API_KEY"] })).toBe(
      false,
    );
    expect(Value.Check(SecretsAssignmentsEntryParamsSchema, { name: "DUMMY_API_KEY" })).toBe(true);
    expect(
      Value.Check(SecretsAssignmentsEntryParamsSchema, { name: "DUMMY_API_KEY", agentId: "x" }),
    ).toBe(false);
    expect(
      Value.Check(SecretsAssignmentsEntryResultSchema, {
        entry: { ...metadata, kind: "secret", allowedHosts: ["api.example.com"] },
      }),
    ).toBe(true);
    expect(Value.Check(SecretsAssignmentsEntryResultSchema, { entry: null })).toBe(true);
    // Env-kind entries are structurally value-free on this read.
    expect(
      Value.Check(SecretsAssignmentsEntryResultSchema, {
        entry: { ...metadata, name: "SERVICE_URL", kind: "env", value: "must-not-cross" },
      }),
    ).toBe(false);
    expect(
      Value.Check(SecretsAssignmentsEntryResultSchema, {
        entry: { ...metadata, name: "SERVICE_URL", kind: "env", valuePreview: "no-preview" },
      }),
    ).toBe(false);
    expect(
      Value.Check(SecretsAssignmentsAdminListResultSchema, {
        assignments: [{ agentId: "dummy-agent", names: ["DUMMY_API_KEY"] }],
      }),
    ).toBe(true);
    expect(
      Value.Check(SecretsAssignmentsAdminListResultSchema, {
        assignments: [],
        nextCursor: "dummy-agent|DUMMY_API_KEY",
      }),
    ).toBe(true);
    expect(
      Value.Check(SecretsAssignmentsAdminAssignParamsSchema, {
        agentId: "dummy-agent",
        name: "DUMMY_API_KEY",
      }),
    ).toBe(true);
    expect(
      Value.Check(SecretsAssignmentsAdminAssignParamsSchema, {
        agentId: "dummy-agent",
        name: "DUMMY_API_KEY",
        value: "must-not-cross",
      }),
    ).toBe(false);
    expect(Value.Check(SecretsAssignmentsEnforcementGetResultSchema, { mode: "enforce" })).toBe(
      true,
    );
    expect(Value.Check(SecretsAssignmentsEnforcementSetParamsSchema, { mode: "soak" })).toBe(false);
    expect(
      Value.Check(SecretsAssignmentsListResultSchema, {
        names: ["DUMMY_API_KEY"],
        provider: "dummy-provider",
      }),
    ).toBe(false);
    expect(Value.Check(SecretsAssignmentsHasParamsSchema, { name: "DUMMY_API_KEY" })).toBe(true);
    expect(
      Value.Check(SecretsAssignmentsHasParamsSchema, {
        name: "DUMMY_API_KEY",
        agentId: "other-agent",
      }),
    ).toBe(false);
    expect(Value.Check(SecretsAssignmentsHasParamsSchema, { name: "../DUMMY_API_KEY" })).toBe(
      false,
    );
    expect(Value.Check(SecretsAssignmentsHasResultSchema, { assigned: false })).toBe(true);
    expect(
      Value.Check(SecretsAssignmentsHasResultSchema, {
        assigned: true,
        value: "dummy-value-must-not-cross",
      }),
    ).toBe(false);
  });

  it("makes secret values structurally unrepresentable while requiring env values", () => {
    expect(
      Value.Check(SecretsStoreListResultSchema, {
        entries: [
          { ...metadata, kind: "secret", allowedHosts: ["api.example.com"] },
          { ...metadata, name: "SERVICE_URL", kind: "env", value: "https://service.test" },
        ],
      }),
    ).toBe(true);
    expect(
      Value.Check(SecretsStoreListResultSchema, {
        entries: [{ ...metadata, kind: "secret", value: "must-not-cross-boundary" }],
      }),
    ).toBe(false);
    expect(
      Value.Check(SecretsStoreListResultSchema, {
        entries: [{ ...metadata, name: "SERVICE_URL", kind: "env" }],
      }),
    ).toBe(false);
  });

  it("validates store mutations and their reload status", () => {
    expect(
      Value.Check(SecretsStoreSetParamsSchema, {
        name: "SERVICE_API_KEY",
        value: "value",
        kind: "secret",
        allowedHosts: ["api.example.com"],
      }),
    ).toBe(true);
    expect(
      Value.Check(SecretsStoreSetParamsSchema, {
        name: "SERVICE_API_KEY",
        value: "value",
        kind: "secret",
        allowedHosts: ["api.example.com", "api.example.com"],
      }),
    ).toBe(false);
    expect(
      Value.Check(SecretsStoreSetParamsSchema, {
        name: "github-setup-11111111111111111111111111111111",
        value: "value",
        kind: "secret",
      }),
    ).toBe(true);
    expect(
      Value.Check(SecretsStoreDeleteParamsSchema, {
        name: "github-setup-11111111111111111111111111111111",
      }),
    ).toBe(true);
    expect(
      Value.Check(SecretsStoreSetParamsSchema, {
        name: "lowercase",
        value: "value",
        kind: "secret",
      }),
    ).toBe(false);
    expect(Value.Check(SecretsStoreDeleteParamsSchema, { name: "github-setup-token" })).toBe(false);
    expect(
      Value.Check(SecretsStoreMutationResultSchema, {
        ok: true,
        reloaded: true,
        warningCount: 1,
      }),
    ).toBe(true);
  });
});
