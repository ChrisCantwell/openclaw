import { afterEach, describe, expect, it, vi } from "vitest";
// Unit tests for the operator-admin assignments/enforcement state actions.
// Mocks are genuinely async so failure paths exercise the awaited call paths.
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  assignSecretName,
  createInitialAssignmentsAdminState,
  createInitialEnforcementState,
  loadAllAssignmentsAdmin,
  loadAssignmentsAdmin,
  setEnforcementMode,
  unassignSecretName,
} from "./index.ts";

function clientWithResponses(responses: Array<unknown>) {
  const request = vi.fn(async (_method: string, _params?: unknown) => responses.shift());
  const client = { request } as unknown as GatewayBrowserClient;
  return { client, request, snapshot: { client, connected: true } };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("assignments admin state", () => {
  it("load merges appended pages by agentId instead of duplicating groups", async () => {
    const { request, snapshot } = clientWithResponses([
      { assignments: [{ agentId: "agent-a", names: ["ONE"] }], nextCursor: "agent-a|ONE" },
      { assignments: [{ agentId: "agent-a", names: ["TWO"] }] },
    ]);
    const state = createInitialAssignmentsAdminState(snapshot);
    expect(await loadAssignmentsAdmin(state)).toBe(true);
    expect(await loadAssignmentsAdmin(state, { append: true, cursor: "agent-a|ONE" })).toBe(true);
    expect(state.assignments).toEqual([{ agentId: "agent-a", names: ["ONE", "TWO"] }]);
    expect(state.nextCursor).toBeNull();
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "secrets.assignments.admin.list",
      "secrets.assignments.admin.list",
    ]);
  });

  it("loadAllAssignmentsAdmin exhausts the cursor so legacy agent ids surface without Load more", async () => {
    // Three pages; page three carries an agent id that exists only in
    // assignment history (deleted/legacy agent), beyond the first page.
    const { request, snapshot } = clientWithResponses([
      { assignments: [{ agentId: "agent-a", names: ["ONE"] }], nextCursor: "c1" },
      { assignments: [{ agentId: "agent-b", names: ["TWO"] }], nextCursor: "c2" },
      { assignments: [{ agentId: "agent-gone", names: ["THREE"] }] },
    ]);
    const state = createInitialAssignmentsAdminState(snapshot);
    expect(await loadAllAssignmentsAdmin(state)).toBe(true);
    // Cursor followed to exhaustion without any manual paging; the legacy
    // id is present in the merged groups and would reach the picker's
    // leftover-ids section via assignmentAgentIds().
    expect(state.assignments).toEqual([
      { agentId: "agent-a", names: ["ONE"] },
      { agentId: "agent-b", names: ["TWO"] },
      { agentId: "agent-gone", names: ["THREE"] },
    ]);
    expect(state.nextCursor).toBeNull();
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "secrets.assignments.admin.list",
      "secrets.assignments.admin.list",
      "secrets.assignments.admin.list",
    ]);
    expect(request.mock.calls[1]?.[1]).toEqual({ cursor: "c1" });
    expect(request.mock.calls[2]?.[1]).toEqual({ cursor: "c2" });
  });

  it("assign calls the dedicated admin method with agentId and name, then reloads", async () => {
    const { request, snapshot } = clientWithResponses([
      { ok: true },
      { assignments: [{ agentId: "agent-a", names: ["ONE"] }] },
    ]);
    const state = createInitialAssignmentsAdminState(snapshot);
    expect(await assignSecretName(state, "agent-a", "ONE")).toBe(true);
    expect(request.mock.calls[0]).toEqual([
      "secrets.assignments.admin.assign",
      { agentId: "agent-a", name: "ONE" },
    ]);
    expect(state.assignments).toEqual([{ agentId: "agent-a", names: ["ONE"] }]);
  });

  it("unassign re-runs exhaustive pagination so a legacy id beyond page one survives", async () => {
    // Full inventory: the legacy/deleted agent id lives on page three. After
    // the mutation, the refresh must exhaust the cursor again — a first-page
    // reload would drop agent-gone from the picker until manual paging.
    const { request, snapshot } = clientWithResponses([
      { ok: true }, // unassign mutation
      // Post-mutation inventory: agent-a's group is gone; the legacy id
      // still lives beyond the first page.
      { assignments: [{ agentId: "agent-b", names: ["TWO"] }], nextCursor: "c1" },
      { assignments: [{ agentId: "agent-gone", names: ["THREE"] }] },
    ]);
    const state = createInitialAssignmentsAdminState(snapshot);
    expect(await unassignSecretName(state, "agent-a", "ONE")).toBe(true);
    const methods = request.mock.calls.map(([method]) => method);
    expect(methods[0]).toBe("secrets.assignments.admin.unassign");
    // The refresh followed every page rather than stopping at the first.
    expect(methods.filter((m) => m === "secrets.assignments.admin.list")).toHaveLength(2);
    expect(state.assignments).toEqual([
      { agentId: "agent-b", names: ["TWO"] },
      { agentId: "agent-gone", names: ["THREE"] },
    ]);
    expect(state.nextCursor).toBeNull();
  });

  it("unassign failure records the error and returns false", async () => {
    const { request, snapshot } = clientWithResponses([]);
    request.mockRejectedValueOnce(new Error("unassign refused"));
    const state = createInitialAssignmentsAdminState(snapshot);
    expect(await unassignSecretName(state, "agent-a", "ONE")).toBe(false);
    expect(state.error).toContain("unassign refused");
    expect(state.busy).toBe(false);
  });

  it("a client replacement during load discards the stale result", async () => {
    let release: (value: unknown) => void = () => {};
    const request = vi.fn(
      (_method: string, _params?: unknown) =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const state = createInitialAssignmentsAdminState({
      client: { request } as unknown as GatewayBrowserClient,
      connected: true,
    });
    const pending = loadAssignmentsAdmin(state);
    // Simulate gateway replacement before the response lands.
    const replacement = clientWithResponses([]);
    state.client = replacement.client;
    release({ assignments: [{ agentId: "agent-a", names: ["ONE"] }] });
    expect(await pending).toBe(false);
    // The stale result is discarded and never adopted into state.
    expect(state.assignments).toEqual([]);
  });
});

describe("enforcement state", () => {
  it("set adopts only the backend-observed mode, never a request echo", async () => {
    // The gateway returns the verified mode; a lying echo of a different
    // value than requested is still the backend's observation, but the state
    // must never adopt the *requested* value when the backend rejects.
    const { request, snapshot } = clientWithResponses([{ ok: true, mode: "enforce" }]);
    const state = createInitialEnforcementState(snapshot);
    state.mode = "off";
    expect(await setEnforcementMode(state, "enforce")).toBe("enforce");
    expect(state.mode).toBe("enforce");
    expect(request.mock.calls[0]).toEqual([
      "secrets.assignments.enforcement.set",
      { mode: "enforce" },
    ]);
  });

  it("set failure records the error and leaves the prior mode untouched", async () => {
    const { request, snapshot } = clientWithResponses([]);
    request.mockRejectedValueOnce(new Error("runtime still reports off"));
    const state = createInitialEnforcementState(snapshot);
    state.mode = "off";
    expect(await setEnforcementMode(state, "enforce")).toBeNull();
    expect(state.error).toContain("runtime still reports off");
    expect(state.mode).toBe("off");
    expect(state.busy).toBe(false);
  });

  it("set failure never adopts the requested mode into state", async () => {
    // Reproduces the live defect: the backend rejects after persist, so the
    // authoritative mode is still the pre-write value. The rejected requested
    // mode must never land in state (which would rerender the clicked radio).
    const { request, snapshot } = clientWithResponses([]);
    request.mockRejectedValueOnce(new Error("timeout: runtime still reports off"));
    const state = createInitialEnforcementState(snapshot);
    state.mode = "advisory";
    expect(await setEnforcementMode(state, "enforce")).toBeNull();
    expect(state.mode).toBe("advisory");
    expect(state.error).toContain("timeout");
  });

  it("set success after a delayed-but-confirmed backend apply adopts the confirmed mode", async () => {
    // Bounded backend confirmation resolves late but with ok:true; the state
    // must adopt the confirmed mode only after the backend response.
    const { request, snapshot } = clientWithResponses([{ ok: true, mode: "enforce" }]);
    request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ ok: true, mode: "enforce" }), 25);
        }),
    );
    const state = createInitialEnforcementState(snapshot);
    state.mode = "off";
    const pending = setEnforcementMode(state, "enforce");
    // While pending, the mode still reflects pre-attempt reality.
    expect(state.busy).toBe(true);
    expect(await pending).toBe("enforce");
    expect(state.mode).toBe("enforce");
    expect(state.busy).toBe(false);
  });
});
