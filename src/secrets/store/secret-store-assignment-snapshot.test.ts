import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { writeAgentSecretAssignment } from "../assignment-store.js";
import {
  readAssignedSecretStoreExecEnvironment,
  revalidateAssignedSecretNames,
  resolveExecSnapshotAssignmentEnforcement,
} from "../exec-store-snapshot.js";
import { writeSecretStoreEntry } from "./secret-store.js";

const roots: string[] = [];
const team = { kind: "team" } as const;

function createDatabaseOptions() {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-assignment-snapshot-")),
  );
  roots.push(root);
  return { path: path.join(root, "state.sqlite") };
}

function configWith(mode: "off" | "advisory" | "enforce"): OpenClawConfig {
  return { secrets: { agentAssignmentEnforcement: mode } } as OpenClawConfig;
}

/**
 * Seeds both audience axes across both value kinds:
 * - GLOBAL_* entries are audience "all" (legacy team-wide delivery).
 * - ASSIGNED_* entries are audience "selected" and explicitly assigned to agent-a.
 * - UNASSIGNED_* entries are audience "selected" with no assignment for agent-a.
 */
function seed(database: ReturnType<typeof createDatabaseOptions>) {
  writeSecretStoreEntry({
    scope: team,
    name: "GLOBAL_ENV_VAR",
    value: "global-env-value-1",
    kind: "env",
    updatedBy: "test",
    database,
  });
  writeSecretStoreEntry({
    scope: team,
    name: "ASSIGNED_ENV_VAR",
    value: "assigned-env-value-1",
    kind: "env",
    audience: "selected",
    updatedBy: "test",
    database,
  });
  writeSecretStoreEntry({
    scope: team,
    name: "UNASSIGNED_ENV_VAR",
    value: "unassigned-env-value-1",
    kind: "env",
    audience: "selected",
    updatedBy: "test",
    database,
  });
  writeSecretStoreEntry({
    scope: team,
    name: "GLOBAL_SECRET",
    value: "global-secret-value-1",
    kind: "secret",
    updatedBy: "test",
    database,
  });
  writeSecretStoreEntry({
    scope: team,
    name: "ASSIGNED_SECRET",
    value: "assigned-secret-value-1",
    kind: "secret",
    audience: "selected",
    allowedHosts: ["api.example.test"],
    updatedBy: "test",
    database,
  });
  writeSecretStoreEntry({
    scope: team,
    name: "UNASSIGNED_SECRET",
    value: "unassigned-secret-value-1",
    kind: "secret",
    audience: "selected",
    updatedBy: "test",
    database,
  });
  writeAgentSecretAssignment({
    agentId: "agent-a",
    secretName: "ASSIGNED_ENV_VAR",
    assignedBy: "test",
    database,
  });
  writeAgentSecretAssignment({
    agentId: "agent-a",
    secretName: "ASSIGNED_SECRET",
    assignedBy: "test",
    database,
  });
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("audience-scoped exec store snapshots", () => {
  it("audience all keeps legacy behavior in every mode: all-audience entries project to any agent", () => {
    const database = createDatabaseOptions();
    seed(database);
    for (const mode of ["off", "advisory", "enforce"] as const) {
      const environment = readAssignedSecretStoreExecEnvironment({
        includeSecretSentinels: true,
        agentId: "agent-b",
        config: configWith(mode),
        database,
      });
      expect(environment.env?.GLOBAL_ENV_VAR).toBe("global-env-value-1");
      expect(Object.keys(environment.secretSentinels ?? {})).toContain("GLOBAL_SECRET");
    }
  });

  it("enforce projects all-audience entries plus only explicitly assigned selected entries", () => {
    const database = createDatabaseOptions();
    seed(database);
    const environment = readAssignedSecretStoreExecEnvironment({
      includeSecretSentinels: true,
      agentId: "agent-a",
      config: configWith("enforce"),
      database,
    });
    expect(environment.env).toEqual({
      GLOBAL_ENV_VAR: "global-env-value-1",
      ASSIGNED_ENV_VAR: "assigned-env-value-1",
    });
    expect(Object.keys(environment.secretSentinels ?? {}).toSorted()).toEqual([
      "ASSIGNED_SECRET",
      "GLOBAL_SECRET",
    ]);
    expect(JSON.stringify(environment)).not.toContain("unassigned-env-value-1");
    expect(JSON.stringify(environment)).not.toContain("unassigned-secret-value-1");
  });

  it("selected entries are withheld even with enforcement off (audience is persisted, not policy)", () => {
    const database = createDatabaseOptions();
    seed(database);
    const environment = readAssignedSecretStoreExecEnvironment({
      includeSecretSentinels: true,
      agentId: "agent-a",
      config: configWith("off"),
      database,
    });
    expect(environment.env?.ASSIGNED_ENV_VAR).toBe("assigned-env-value-1");
    expect(environment.env?.UNASSIGNED_ENV_VAR).toBeUndefined();
    expect(Object.keys(environment.secretSentinels ?? {})).not.toContain("UNASSIGNED_SECRET");
  });

  it("enforce fails closed for selected entries when the assignment table is empty, while all-audience entries still project", () => {
    const database = createDatabaseOptions();
    seed(database);
    const db = openOpenClawStateDatabase(database).db;
    db.prepare("DELETE FROM agent_secret_assignments").run();
    const environment = readAssignedSecretStoreExecEnvironment({
      includeSecretSentinels: true,
      agentId: "agent-a",
      config: configWith("enforce"),
      database,
    });
    // An empty assignment set never implies global access for selected
    // entries; all-audience entries keep legacy delivery.
    expect(environment.env).toEqual({ GLOBAL_ENV_VAR: "global-env-value-1" });
    expect(Object.keys(environment.secretSentinels ?? {})).toEqual(["GLOBAL_SECRET"]);
  });

  it("enforce fails closed for selected entries when the assignment table is missing; all-audience entries still project", () => {
    const database = createDatabaseOptions();
    seed(database);
    const db = openOpenClawStateDatabase(database).db;
    db.prepare("DROP TABLE agent_secret_assignments").run();
    const environment = readAssignedSecretStoreExecEnvironment({
      includeSecretSentinels: true,
      agentId: "agent-a",
      config: configWith("enforce"),
      database,
    });
    expect(environment.env).toEqual({ GLOBAL_ENV_VAR: "global-env-value-1" });
    expect(Object.keys(environment.secretSentinels ?? {})).toEqual(["GLOBAL_SECRET"]);
  });

  it("legacy rows predating the audience column behave as all-audience for every agent", () => {
    const database = createDatabaseOptions();
    seed(database);
    const db = openOpenClawStateDatabase(database).db;
    // Simulate migration: legacy rows carry no explicit audience value.
    db.prepare("UPDATE secret_store_entries SET audience = 'all'").run();
    const environment = readAssignedSecretStoreExecEnvironment({
      includeSecretSentinels: true,
      agentId: "agent-future",
      config: configWith("enforce"),
      database,
    });
    // Every entry is all-audience now, so a brand-new configured agent
    // receives all of them through the same legacy delivery path.
    expect(Object.keys(environment.env ?? {}).toSorted()).toEqual([
      "ASSIGNED_ENV_VAR",
      "GLOBAL_ENV_VAR",
      "UNASSIGNED_ENV_VAR",
    ]);
    expect(Object.keys(environment.secretSentinels ?? {}).toSorted()).toEqual([
      "ASSIGNED_SECRET",
      "GLOBAL_SECRET",
      "UNASSIGNED_SECRET",
    ]);
  });

  it("one agent cannot use another agent's selected assignments", () => {
    const database = createDatabaseOptions();
    seed(database);
    const other = readAssignedSecretStoreExecEnvironment({
      includeSecretSentinels: true,
      agentId: "agent-b",
      config: configWith("enforce"),
      database,
    });
    expect(other.env).toEqual({ GLOBAL_ENV_VAR: "global-env-value-1" });
    expect(Object.keys(other.secretSentinels ?? {})).toEqual(["GLOBAL_SECRET"]);
    const a = readAssignedSecretStoreExecEnvironment({
      includeSecretSentinels: true,
      agentId: "agent-a",
      config: configWith("enforce"),
      database,
    });
    expect(a.env).toEqual({
      GLOBAL_ENV_VAR: "global-env-value-1",
      ASSIGNED_ENV_VAR: "assigned-env-value-1",
    });
    expect(Object.keys(a.secretSentinels ?? {}).toSorted()).toEqual([
      "ASSIGNED_SECRET",
      "GLOBAL_SECRET",
    ]);
  });

  it("advisory withholds unassigned selected entries and only warns (warn-and-withhold soak)", () => {
    const database = createDatabaseOptions();
    seed(database);
    const environment = readAssignedSecretStoreExecEnvironment({
      includeSecretSentinels: true,
      agentId: "agent-b",
      config: configWith("advisory"),
      database,
    });
    // Advisory never broadens delivery: selected entries stay withheld from
    // unassigned agents exactly as in off/enforce; only the warning differs.
    expect(environment.env).toEqual({ GLOBAL_ENV_VAR: "global-env-value-1" });
    expect(Object.keys(environment.secretSentinels ?? {})).toEqual(["GLOBAL_SECRET"]);
    expect(JSON.stringify(environment)).not.toContain("unassigned-env-value-1");
    expect(JSON.stringify(environment)).not.toContain("unassigned-secret-value-1");
  });

  it("advisory keeps assigned selected delivery and withholds unassigned selected when the assignment table is missing", () => {
    const database = createDatabaseOptions();
    seed(database);
    const db = openOpenClawStateDatabase(database).db;
    db.prepare("DROP TABLE agent_secret_assignments").run();
    const environment = readAssignedSecretStoreExecEnvironment({
      includeSecretSentinels: true,
      agentId: "agent-a",
      config: configWith("advisory"),
      database,
    });
    expect(environment.env).toEqual({ GLOBAL_ENV_VAR: "global-env-value-1" });
    expect(Object.keys(environment.secretSentinels ?? {})).toEqual(["GLOBAL_SECRET"]);
  });

  it("enforce fails closed with a generic denial when agentId is absent", () => {
    const database = createDatabaseOptions();
    seed(database);
    expect(() =>
      readAssignedSecretStoreExecEnvironment({
        includeSecretSentinels: true,
        config: configWith("enforce"),
        database,
      }),
    ).toThrow(/no valid agent identity/);
  });

  it("enforce fails closed for an invalid agentId (generic denial, no projection)", () => {
    const database = createDatabaseOptions();
    seed(database);
    for (const invalid of ["", "   ", "bad id!", "../escape"]) {
      expect(() =>
        readAssignedSecretStoreExecEnvironment({
          includeSecretSentinels: true,
          agentId: invalid,
          config: configWith("enforce"),
          database,
        }),
      ).toThrow(/no valid agent identity/);
    }
  });

  it("absent agentId under off/advisory delivers all-audience entries and withholds selected entries", () => {
    const database = createDatabaseOptions();
    seed(database);
    for (const mode of ["off", "advisory"] as const) {
      const environment = readAssignedSecretStoreExecEnvironment({
        includeSecretSentinels: true,
        config: configWith(mode),
        database,
      });
      // No identity: all-audience entries keep legacy delivery; selected
      // entries cannot be bound to an agent and fail closed individually.
      expect(environment.env).toEqual({ GLOBAL_ENV_VAR: "global-env-value-1" });
      expect(Object.keys(environment.secretSentinels ?? {})).toEqual(["GLOBAL_SECRET"]);
    }
  });

  it("enforcement mode resolution is strict", () => {
    expect(resolveExecSnapshotAssignmentEnforcement(undefined)).toBe("off");
    expect(resolveExecSnapshotAssignmentEnforcement({} as OpenClawConfig)).toBe("off");
    expect(resolveExecSnapshotAssignmentEnforcement(configWith("off"))).toBe("off");
    expect(resolveExecSnapshotAssignmentEnforcement(configWith("advisory"))).toBe("advisory");
    expect(resolveExecSnapshotAssignmentEnforcement(configWith("enforce"))).toBe("enforce");
    expect(
      resolveExecSnapshotAssignmentEnforcement({
        secrets: { agentAssignmentEnforcement: "yes" },
      } as unknown as OpenClawConfig),
    ).toBe("off");
  });

  it("mixed-case runtime identity normalizes to the stored lowercase agent id", () => {
    const database = createDatabaseOptions();
    seed(database);
    // "Agent-A" represents the same valid agent id as "agent-a"; it must not
    // fail closed to an empty snapshot.
    const mixed = readAssignedSecretStoreExecEnvironment({
      includeSecretSentinels: true,
      agentId: "Agent-A",
      config: configWith("enforce"),
      database,
    });
    expect(mixed.env).toEqual({
      GLOBAL_ENV_VAR: "global-env-value-1",
      ASSIGNED_ENV_VAR: "assigned-env-value-1",
    });
    expect(Object.keys(mixed.secretSentinels ?? {}).toSorted()).toEqual([
      "ASSIGNED_SECRET",
      "GLOBAL_SECRET",
    ]);
  });

  it("beyond 512 assignments: enforce projects every assigned entry with no authorization truncation", () => {
    const database = createDatabaseOptions();
    const names = Array.from({ length: 600 }, (_, index) => {
      const name = `BULK_VAR_${String(index).padStart(4, "0")}`;
      writeSecretStoreEntry({
        scope: team,
        name,
        value: `bulk-value-${index}`,
        kind: "env",
        updatedBy: "test",
        database,
      });
      writeAgentSecretAssignment({
        agentId: "bulk-agent",
        secretName: name,
        database,
      });
      return name;
    });
    const environment = readAssignedSecretStoreExecEnvironment({
      includeSecretSentinels: true,
      agentId: "bulk-agent",
      config: configWith("enforce"),
      database,
    });
    // Authorization honors the full finite store snapshot: all 600 assigned
    // entries project, including every name beyond the legacy 512 bound.
    const projected = Object.keys(environment.env ?? {}).toSorted();
    expect(projected).toEqual(names);
  });

  it("secret sentinels are opaque and bindings keep allowedHosts for selected and all-audience entries", () => {
    const database = createDatabaseOptions();
    seed(database);
    const environment = readAssignedSecretStoreExecEnvironment({
      includeSecretSentinels: true,
      agentId: "agent-a",
      config: configWith("enforce"),
      database,
    });
    const sentinel = environment.secretSentinels?.ASSIGNED_SECRET ?? "";
    expect(sentinel).not.toBe("assigned-secret-value-1");
    expect(JSON.stringify(environment)).not.toContain("assigned-secret-value-1");
    expect(JSON.stringify(environment)).not.toContain("global-secret-value-1");
    expect(environment.secretEgressBindings).toEqual([
      {
        name: "ASSIGNED_SECRET",
        sentinel,
        allowedHosts: ["api.example.test"],
      },
      {
        name: "GLOBAL_SECRET",
        sentinel: environment.secretSentinels?.GLOBAL_SECRET ?? "",
        allowedHosts: [],
      },
    ]);
  });
});

describe("pre-effect authority revalidation", () => {
  it("revalidation approves all-audience names and currently assigned selected names", () => {
    const database = createDatabaseOptions();
    seed(database);
    const result = revalidateAssignedSecretNames({
      names: ["GLOBAL_SECRET", "ASSIGNED_SECRET"],
      agentId: "agent-a",
      config: configWith("enforce"),
      database,
    });
    expect(result).toEqual({ ok: true });
  });

  it("revalidation denies a selected name whose assignment was revoked, in enforce and advisory", () => {
    const database = createDatabaseOptions();
    seed(database);
    // First prove the grant is live, then revoke it exactly as an operator
    // unassign flow would, and confirm the next pre-effect check denies.
    expect(
      revalidateAssignedSecretNames({
        names: ["ASSIGNED_SECRET"],
        agentId: "agent-a",
        config: configWith("enforce"),
        database,
      }),
    ).toEqual({ ok: true });
    const db = openOpenClawStateDatabase(database).db;
    db.prepare("DELETE FROM agent_secret_assignments WHERE secret_name = 'ASSIGNED_SECRET'").run();
    for (const mode of ["enforce", "advisory"] as const) {
      const result = revalidateAssignedSecretNames({
        names: ["ASSIGNED_SECRET", "GLOBAL_SECRET"],
        agentId: "agent-a",
        config: configWith(mode),
        database,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toMatch(/no longer authorized/);
      }
    }
  });

  it("revalidation denies when the entry itself was deleted or narrowed after the snapshot", () => {
    const database = createDatabaseOptions();
    seed(database);
    const db = openOpenClawStateDatabase(database).db;
    db.prepare("DELETE FROM secret_store_entries WHERE name = 'ASSIGNED_SECRET'").run();
    expect(
      revalidateAssignedSecretNames({
        names: ["ASSIGNED_SECRET"],
        agentId: "agent-a",
        config: configWith("enforce"),
        database,
      }).ok,
    ).toBe(false);
    // Narrowing a former all-audience entry to selected without assignment
    // also revokes the retained grant.
    db.prepare(
      "UPDATE secret_store_entries SET audience = 'selected' WHERE name = 'GLOBAL_SECRET'",
    ).run();
    expect(
      revalidateAssignedSecretNames({
        names: ["GLOBAL_SECRET"],
        agentId: "agent-a",
        config: configWith("enforce"),
        database,
      }).ok,
    ).toBe(false);
  });

  it("revalidation keeps selected-audience revocation effective when enforcement is off", () => {
    const database = createDatabaseOptions();
    seed(database);
    const db = openOpenClawStateDatabase(database).db;
    db.prepare("DELETE FROM agent_secret_assignments WHERE secret_name = 'ASSIGNED_SECRET'").run();
    expect(
      revalidateAssignedSecretNames({
        names: ["ASSIGNED_SECRET"],
        agentId: "agent-a",
        config: configWith("off"),
        database,
      }).ok,
    ).toBe(false);
    expect(
      revalidateAssignedSecretNames({
        names: ["GLOBAL_SECRET"],
        agentId: "agent-a",
        config: configWith("off"),
        database,
      }),
    ).toEqual({ ok: true });
    expect(
      revalidateAssignedSecretNames({
        names: [],
        agentId: undefined,
        config: configWith("enforce"),
        database,
      }),
    ).toEqual({ ok: true });
  });
});
