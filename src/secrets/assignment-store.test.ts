import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  countAgentSecretAssignments,
  deleteAgentSecretAssignment,
  hasAgentSecretAssignment,
  listAgentSecretAssignmentsAdmin,
  listAgentSecretAssignments,
  writeAgentSecretAssignment,
} from "./assignment-store.js";

const roots: string[] = [];

function createDatabaseOptions() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-assignment-")));
  roots.push(root);
  return { path: path.join(root, "state.sqlite") };
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("agent secret assignment store", () => {
  it("isolates sorted names by strictly validated agent ID", () => {
    const database = createDatabaseOptions();
    writeAgentSecretAssignment({
      agentId: "Agent-One",
      secretName: "DUMMY_TOKEN_B",
      providerHint: "dummy-provider",
      assignedBy: "test",
      database,
    });
    writeAgentSecretAssignment({
      agentId: "agent-one",
      secretName: "DUMMY_TOKEN_A",
      assignedBy: "test",
      database,
    });
    writeAgentSecretAssignment({
      agentId: "agent-two",
      secretName: "OTHER_DUMMY_TOKEN",
      assignedBy: "test",
      database,
    });

    expect(listAgentSecretAssignments({ agentId: "AGENT-ONE", database })).toEqual([
      "DUMMY_TOKEN_A",
      "DUMMY_TOKEN_B",
    ]);
    expect(
      hasAgentSecretAssignment({ agentId: "agent-one", secretName: "DUMMY_TOKEN_A", database }),
    ).toBe(true);
    expect(
      hasAgentSecretAssignment({ agentId: "agent-one", secretName: "OTHER_DUMMY_TOKEN", database }),
    ).toBe(false);
  });

  it("upserts metadata, deletes idempotently, and never stores a value column", () => {
    const database = createDatabaseOptions();
    writeAgentSecretAssignment({
      agentId: "dummy-agent",
      secretName: "DUMMY_API_KEY",
      providerHint: "first-provider",
      database,
    });
    writeAgentSecretAssignment({
      agentId: "dummy-agent",
      secretName: "DUMMY_API_KEY",
      providerHint: "second-provider",
      database,
    });

    const db = openOpenClawStateDatabase(database).db;
    const columns = db.prepare("PRAGMA table_info(agent_secret_assignments)").all() as Array<{
      name: string;
    }>;
    expect(columns.map((column) => column.name)).toEqual([
      "agent_id",
      "secret_name",
      "provider_hint",
      "created_at_ms",
      "assigned_by",
    ]);
    expect(db.prepare("SELECT provider_hint FROM agent_secret_assignments").get()).toEqual({
      provider_hint: "second-provider",
    });

    deleteAgentSecretAssignment({ agentId: "dummy-agent", secretName: "DUMMY_API_KEY", database });
    deleteAgentSecretAssignment({ agentId: "dummy-agent", secretName: "DUMMY_API_KEY", database });
    expect(listAgentSecretAssignments({ agentId: "dummy-agent", database })).toEqual([]);
  });

  it.each([
    { agentId: "../other", secretName: "DUMMY_TOKEN" },
    { agentId: "agent%2Fother", secretName: "DUMMY_TOKEN" },
    { agentId: "agent-α", secretName: "DUMMY_TOKEN" },
    { agentId: "dummy-agent", secretName: "../DUMMY_TOKEN" },
    { agentId: "dummy-agent", secretName: "dummy_token" },
    { agentId: "dummy-agent", secretName: "DUMMY%2FTOKEN" },
  ])("rejects traversal, encoded separators, Unicode, and invalid names: %o", (input) => {
    const database = createDatabaseOptions();
    expect(() => writeAgentSecretAssignment({ ...input, database })).toThrow();
  });

  it("lazily restores the additive table on the first write", () => {
    const database = createDatabaseOptions();
    openOpenClawStateDatabase(database).db.exec("DROP TABLE agent_secret_assignments");

    writeAgentSecretAssignment({
      agentId: "dummy-agent",
      secretName: "DUMMY_TOKEN",
      database,
    });
    expect(listAgentSecretAssignments({ agentId: "dummy-agent", database })).toEqual([
      "DUMMY_TOKEN",
    ]);
  });

  it("beyond 512 assignments: exact lookup, full listing, and counts stay internally consistent", () => {
    const database = createDatabaseOptions();
    const total = 600;
    const assigned = Array.from({ length: total }, (_, index) => {
      const name = `DUMMY_TOKEN_${String(index).padStart(4, "0")}`;
      writeAgentSecretAssignment({ agentId: "bulk-agent", secretName: name, database });
      return name;
    });
    // Authorization never truncates: an exact lookup past the legacy 512 bound
    // still resolves, because presence is answered against the store, not a
    // presentation window.
    expect(
      hasAgentSecretAssignment({
        agentId: "bulk-agent",
        secretName: assigned[total - 1],
        database,
      }),
    ).toBe(true);
    expect(
      hasAgentSecretAssignment({
        agentId: "bulk-agent",
        secretName: "NOT_ASSIGNED_DUMMY",
        database,
      }),
    ).toBe(false);
    // Count reflects the full set without transferring names.
    expect(countAgentSecretAssignments({ agentId: "bulk-agent", database })).toBe(total);
    // Model inventory is explicitly windowed: total/truncated disclose the
    // remainder instead of silently hiding names beyond the window.
    const names = listAgentSecretAssignments({ agentId: "bulk-agent", database });
    expect(names.length).toBe(total);
    // Operator/admin pagination walks the whole set with a stable cursor.
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const page = listAgentSecretAssignmentsAdmin({ cursor, database });
      pages += 1;
      for (const group of page.assignments) {
        seen.push(...group.names);
      }
      if (!page.nextCursor) {
        break;
      }
      cursor = page.nextCursor;
    }
    expect(pages).toBeGreaterThan(1);
    expect(seen).toEqual(assigned);
    // Rejected cursors fail explicitly rather than silently restarting.
    expect(() => listAgentSecretAssignmentsAdmin({ cursor: "bogus", database })).toThrow();
    // A syntactically well-split cursor whose secret-name half fails the store
    // grammar is also rejected, not silently treated as a keyset bound.
    expect(() =>
      listAgentSecretAssignmentsAdmin({ cursor: "agent-a|not-a-valid-name", database }),
    ).toThrow();
  });
});
