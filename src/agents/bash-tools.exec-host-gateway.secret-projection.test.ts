import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { quoteCliArg } from "../cli/quote-cli-arg.js";
import {
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
} from "../infra/diagnostic-events.js";
import type { DiagnosticSecurityEvent } from "../infra/diagnostic-events.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../plugins/hooks.test-helpers.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import { createProcessSupervisor } from "../process/supervisor/supervisor.js";
import { authorizeSecretEnvForExec } from "./bash-tools.exec-secret-authorize.js";
import type { ExecApprovalFollowupOutcome } from "./bash-tools.exec-types.js";

const resolveExecHostApprovalContextMock = vi.hoisted(() => vi.fn());
const resolveExecApprovalWaitOutcomeMock = vi.hoisted(() => vi.fn());
type BuildExecApprovalFollowupTarget =
  typeof import("./bash-tools.exec-host-shared.js").buildExecApprovalFollowupTarget;
type ExecApprovalFollowupTarget = Parameters<BuildExecApprovalFollowupTarget>[0];

const buildExecApprovalFollowupTargetMock = vi.hoisted(() => vi.fn());
const sendExecApprovalFollowupResultMock = vi.hoisted(() =>
  vi.fn<(target: ExecApprovalFollowupTarget, resultText: string) => Promise<void>>(
    async () => undefined,
  ),
);
const runExecProcessMock = vi.hoisted(() => vi.fn());
const startupCancellationMocks = vi.hoisted(() => ({ spawn: vi.fn(), prepare: vi.fn() }));
const buildExecApprovalPendingToolResultMock = vi.hoisted(() =>
  vi.fn(() => ({ details: { status: "approval-pending" } })),
);
const createExecApprovalDecisionStateMock = vi.hoisted(() =>
  vi.fn(() => ({
    baseDecision: { timedOut: false },
    approvedByAsk: false,
    deniedReason: "approval-required",
  })),
);
const createExecApprovalRequestRouteMock = vi.hoisted(() =>
  vi.fn(async () => ({
    approvalId: "req-1",
    approvalSlug: "slug",
    warningText: "warning",
    expiresAtMs: Date.now() + 60000,
    preResolvedDecision: null,
    initiatingSurface: undefined,
    sentApproverDms: false,
    unavailableReason: null,
    kind: "wait",
  })),
);
vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => ({ spawn: startupCancellationMocks.spawn }),
}));
vi.mock("./shell-snapshot.js", () => ({
  maybeWrapCommandWithShellSnapshot: async (input: { command: string }) => input.command,
}));
vi.mock("./bash-tools.exec-host-shared.js", async (importOriginal) => ({
  ...(await importOriginal()),
  resolveExecHostApprovalContext: resolveExecHostApprovalContextMock,
  buildExecApprovalFollowupTarget: buildExecApprovalFollowupTargetMock,
  sendExecApprovalFollowupResult: sendExecApprovalFollowupResultMock,
  buildExecApprovalPendingToolResult: buildExecApprovalPendingToolResultMock,
  createExecApprovalDecisionState: createExecApprovalDecisionStateMock,
  createExecApprovalRequestRoute: createExecApprovalRequestRouteMock,
  resolveExecApprovalWaitOutcome: resolveExecApprovalWaitOutcomeMock,
  buildDefaultExecApprovalRequestArgs: vi.fn(() => ({})),
  buildHeadlessExecApprovalDeniedMessage: vi.fn(() => "denied"),
  resolveApprovalDecisionOrUndefined: vi.fn(),
  shouldResolveExecApprovalUnavailableInline: vi.fn(() => false),
  enforceStrictInlineEvalApprovalBoundary: vi.fn((v) => v),
  registerExecApprovalRequestForHostOrThrow: vi.fn(async () => undefined),
}));
vi.mock("./bash-tools.exec-runtime.js", () => ({
  createApprovalSlug: vi.fn(() => "slug"),
  normalizeNotifyOutput: vi.fn((value) => value),
  runExecProcess: runExecProcessMock,
}));
vi.mock("./bash-process-registry.js", async (importOriginal) => ({
  ...(await importOriginal()),
  getActiveBackgroundExecSessionCount: vi.fn(() => 0),
  markBackgrounded: vi.fn(),
  tail: vi.fn((value) => value),
}));

const evaluateShellAllowlistWithAuthorizationMock = vi.hoisted(() =>
  vi.fn(() => ({
    allowlistMatches: [],
    analysisOk: true,
    allowlistSatisfied: true,
    segments: [{ resolution: null, argv: ["echo", "ok"] }],
    segmentAllowlistEntries: [],
    segmentSatisfiedBy: [],
  })),
);
const hasDurableExecApprovalMock = vi.hoisted(() => vi.fn(() => false));
const requiresExecApprovalMock = vi.hoisted(() => vi.fn(() => true));
const commitExecAuthorizationMock = vi.hoisted(() => vi.fn(async () => () => {}));
const defaultExecAutoReviewerMock = vi.hoisted(() =>
  vi.fn(async () => ({ decision: "allow-once", risk: "low", rationale: "allowed" })),
);
const detectInterpreterInlineEvalArgvMock = vi.hoisted(() => vi.fn(() => null));

vi.mock("../infra/exec-approvals.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/exec-approvals.js")>()),
  evaluateShellAllowlistWithAuthorization: evaluateShellAllowlistWithAuthorizationMock,
  hasDurableExecApproval: hasDurableExecApprovalMock,
  hasExactCommandDurableExecApproval: vi.fn(() => false),
  buildEnforcedShellCommand: vi.fn(() => ({
    ok: false,
    reason: "segment execution plan unavailable",
  })),
  requiresExecApproval: requiresExecApprovalMock,
  commitExecAuthorizationLocked: commitExecAuthorizationMock,
  resolveApprovalAuditTrustPath: vi.fn(() => null),
  resolveAllowAlwaysPatterns: vi.fn(() => []),
  resolveExecApprovalAllowedDecisions: vi.fn(() => ["allow-once", "allow-always", "deny"]),
  resolveExecApprovalUnavailableDecisions: vi.fn(() => []),
}));
vi.mock("../infra/exec-auto-review.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/exec-auto-review.js")>()),
  defaultExecAutoReviewer: defaultExecAutoReviewerMock,
}));
vi.mock("./bash-tools.exec-approval-request.js", () => ({
  buildExecApprovalRequesterContext: vi.fn(() => ({})),
  buildExecApprovalTurnSourceContext: vi.fn(() => ({})),
  registerExecApprovalRequestForHostOrThrow: vi.fn(async () => undefined),
  isExecApprovalRunAbortedError: () => false,
}));
vi.mock("../infra/command-analysis/inline-eval.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/command-analysis/inline-eval.js")>()),
  describeInterpreterInlineEval: vi.fn(() => "python -c"),
  detectInterpreterInlineEvalArgv: detectInterpreterInlineEvalArgvMock,
}));

let processGatewayAllowlist: typeof import("./bash-tools.exec-host-gateway.js").processGatewayAllowlist;
type GatewayAllowlistParams = Parameters<typeof processGatewayAllowlist>[0];
function runGatewayAllowlist(
  overrides: Partial<GatewayAllowlistParams> & Pick<GatewayAllowlistParams, "command">,
) {
  const { command, ...rest } = overrides;
  return processGatewayAllowlist({
    command,
    workdir: process.cwd(),
    env: process.env as Record<string, string>,
    pty: false,
    defaultTimeoutSec: 30,
    security: "allowlist",
    ask: "off",
    safeBins: new Set(),
    safeBinProfiles: {},
    warnings: [],
    approvalRunningNoticeMs: 0,
    maxOutput: 1000,
    pendingMaxOutput: 1000,
    ...rest,
  });
}
function requireSentFollowupText(index: number): string {
  const call = sendExecApprovalFollowupResultMock.mock.calls[index];
  if (!call) {
    throw new Error("missing followup");
  }
  return call[1] ?? "";
}
function mockApprovedDetachedExec(params: {
  outcome: ExecApprovalFollowupOutcome;
  sessionId?: string;
}) {
  resolveExecApprovalWaitOutcomeMock.mockResolvedValueOnce({
    kind: "resolved",
    decision: "allow-once",
    state: {
      baseDecision: { timedOut: false },
      approvedByAsk: true,
      deniedReason: null,
      timeoutContext: undefined,
    },
  });
  runExecProcessMock.mockResolvedValue({
    session: { id: params.sessionId ?? "sess-1" },
    promise: Promise.resolve(params.outcome),
  });
  buildExecApprovalFollowupTargetMock.mockImplementation((value) => value);
}
function captureSecurityEvents(): { events: DiagnosticSecurityEvent[]; stop: () => void } {
  const events: DiagnosticSecurityEvent[] = [];
  const stop = onInternalDiagnosticEvent((event, metadata) => {
    if (metadata.trusted && event.type === "security.event") {
      events.push(event);
    }
  });
  return { events, stop };
}
type SyntheticAssignmentPolicy = {
  assign: (agentId: string, names: readonly string[]) => void;
  authorize: (agentId: string) => ReturnType<typeof authorizeSecretEnvForExec>;
  revoke: (agentId: string) => void;
  reset: () => void;
};
function installSyntheticAssignmentPolicy(): SyntheticAssignmentPolicy {
  const assignments = new Map<string, readonly string[]>();
  initializeGlobalHookRunner(
    createMockPluginRegistry([
      {
        pluginId: "synthetic-assignment-policy",
        hookName: "secret_env_authorize",
        handler: (...args: unknown[]) => {
          const event = args[0] as { candidates: Array<{ name: string }> };
          const ctx = args[1] as { agentId?: string };
          const selected = assignments.get(ctx.agentId ?? "");
          if (!selected) {
            return { allowedNames: [] };
          }
          const allowed = new Set(selected);
          return {
            allowedNames: event.candidates
              .map((candidate) => candidate.name)
              .filter((name) => allowed.has(name)),
          };
        },
      },
    ]),
  );
  return {
    assign: (id, names) => assignments.set(id, [...names]),
    authorize: (agentId) =>
      authorizeSecretEnvForExec({
        storeEnv: { env: { DEPLOY_ENV_A: "synthetic-a", DEPLOY_ENV_B: "synthetic-b" } },
        host: "gateway",
        agentId,
      }),
    revoke: (id) => assignments.set(id, []),
    reset: () => {
      resetGlobalHookRunner();
      assignments.clear();
    },
  };
}
beforeEach(() => {
  resetGatewayWorkAdmission();
  resetDiagnosticEventsForTest();
  buildExecApprovalFollowupTargetMock.mockReset();
  buildExecApprovalFollowupTargetMock.mockReturnValue(null);
  sendExecApprovalFollowupResultMock.mockReset();
  sendExecApprovalFollowupResultMock.mockResolvedValue(undefined);
  runExecProcessMock.mockReset();
  resolveExecHostApprovalContextMock.mockReset();
  resolveExecApprovalWaitOutcomeMock.mockReset();
});
beforeEach(async () => {
  ({ processGatewayAllowlist } = await import("./bash-tools.exec-host-gateway.js"));
});
describe("secret projection deferred launch boundary", () => {
  it("denies a deferred approval launch when the secret assignment is revoked while waiting", async () => {
    // The foreground owner validated the assignment before approval was
    // requested; a revocation during the wait must deny at the detached
    // launch boundary instead of delivering the captured environment.
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "allowlist",
      hostAsk: "always",
      askFallback: "deny",
    });
    resolveExecApprovalWaitOutcomeMock.mockResolvedValueOnce({
      kind: "resolved",
      decision: "allow-once",
      state: {
        baseDecision: { timedOut: false },
        approvedByAsk: true,
        deniedReason: null,
        timeoutContext: undefined,
      },
    });
    buildExecApprovalFollowupTargetMock.mockImplementation((value) => value);
    const beforeSpawnCalls: Array<() => Promise<unknown>> = [];
    let spawnReached = false;
    runExecProcessMock.mockImplementation(
      async (input: { beforeSpawn?: () => Promise<unknown> }) => {
        if (input.beforeSpawn) {
          beforeSpawnCalls.push(input.beforeSpawn);
          // Mirror the real runtime: the pre-spawn recheck runs immediately
          // before the process is created and its denial prevents the spawn.
          await input.beforeSpawn();
        }
        spawnReached = true;
        return { session: { id: "sess-revoked" }, promise: Promise.resolve({}) };
      },
    );
    const captured = captureSecurityEvents();

    let result: Awaited<ReturnType<typeof runGatewayAllowlist>>;
    try {
      result = await runGatewayAllowlist({
        command: "openclaw sessions export-trajectory --json",
        approvalFollowupMode: "agent",
        sessionId: "approval-session",
        secretEnvBeforeSpawn: async () => ({
          content: [{ type: "text", text: "secret assignment policy revoked one or more entries" }],
          details: { status: "failed", exitCode: null, durationMs: 0, aggregated: "revoked" },
        }),
      });
      await vi.waitFor(() => {
        expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledTimes(1);
      });
    } finally {
      captured.stop();
    }

    expect(result!.pendingResult?.details.status).toBe("approval-pending");
    expect(beforeSpawnCalls).toHaveLength(1);
    // The revoked entry must never reach a launched process.
    expect(spawnReached).toBe(false);
    const text = requireSentFollowupText(0);
    expect(text).toContain("secret-projection-denied");
    expect(text).toContain("revoked one or more entries");
    expect(captured.events.at(-1)).toMatchObject({
      action: "exec.approval.denied",
      outcome: "denied",
      policy: { reason: "secret-projection-denied" },
    });
  });

  it("launches a deferred approval when the assignment recheck still authorizes the run", async () => {
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "allowlist",
      hostAsk: "always",
      askFallback: "deny",
    });
    mockApprovedDetachedExec({
      outcome: { status: "completed", exitCode: 0, timedOut: false, aggregated: "ok" },
    });
    const recheck = vi.fn(async () => undefined);
    runExecProcessMock.mockImplementation(
      async (input: { beforeSpawn?: () => Promise<unknown> }) => {
        await input.beforeSpawn?.();
        return {
          session: { id: "sess-allowed" },
          promise: Promise.resolve({
            status: "completed",
            exitCode: 0,
            timedOut: false,
            aggregated: "ok",
          }),
        };
      },
    );

    const result = await runGatewayAllowlist({
      command: "openclaw sessions export-trajectory --json",
      approvalFollowupMode: "agent",
      sessionId: "approval-session",
      secretEnvBeforeSpawn: recheck,
    });

    expect(result.pendingResult?.details.status).toBe("approval-pending");
    await vi.waitFor(() => {
      expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledTimes(1);
    });
    expect(recheck).toHaveBeenCalledOnce();
    expect(requireSentFollowupText(0)).not.toContain("secret-projection-denied");
  });

  // Discriminating real-owner proof. Unlike the callback-level test above, this
  // does NOT rely on a mock re-invoking the recheck: the deferred owner calls the
  // real `runExecProcess`, which drives the real process supervisor and a real
  // child. A revocation that lands during the approval wait must therefore
  // propagate through the real launch owner to the final process effect.
  //
  // Baseline behavior (the deferred owner's pre-spawn recheck removed): the
  // captured `DEPLOY_ENV_A` would be delivered to a launched process and the
  // marker would exist. Under this fix the child never launches.
  it("withholds a revoked assignment at the real deferred launch owner and spawns no process", async () => {
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "allowlist",
      hostAsk: "always",
      askFallback: "deny",
    });
    buildExecApprovalFollowupTargetMock.mockImplementation((value) => value);

    const policy = installSyntheticAssignmentPolicy();
    let supervisor: ReturnType<typeof createProcessSupervisor> | undefined;
    const markerPath = path.join(fs.realpathSync(os.tmpdir()), `revoked-${crypto.randomUUID()}`);
    try {
      policy.assign("agent-revoked", ["DEPLOY_ENV_A"]);
      const authorization = await policy.authorize("agent-revoked");
      expect(authorization.denied).toBeUndefined();
      expect(authorization.storeEnv.env).toEqual({ DEPLOY_ENV_A: "synthetic-a" });
      expect(authorization.beforeSpawn).toBeTypeOf("function");
      const env: Record<string, string> = { PATH: "/usr/bin:/bin", ...authorization.storeEnv.env };

      const runtime = await vi.importActual<typeof import("./bash-tools.exec-runtime.js")>(
        "./bash-tools.exec-runtime.js",
      );
      runExecProcessMock.mockImplementation(runtime.runExecProcess);
      supervisor = createProcessSupervisor();
      startupCancellationMocks.spawn.mockImplementation(supervisor.spawn.bind(supervisor));

      // Revoke during the approval wait, then let the approval resolve anyway.
      resolveExecApprovalWaitOutcomeMock.mockImplementationOnce(async () => {
        policy.revoke("agent-revoked");
        return {
          kind: "resolved" as const,
          decision: "allow-once",
          state: {
            baseDecision: { timedOut: false },
            approvedByAsk: true,
            deniedReason: null,
            timeoutContext: undefined,
          },
        };
      });

      const captured = captureSecurityEvents();
      try {
        const result = await runGatewayAllowlist({
          command: `printf '%s' "$DEPLOY_ENV_A" > ${quoteCliArg(markerPath)}`,
          approvalFollowupMode: "agent",
          env,
          requestedEnv: env,
          workdir: os.tmpdir(),
          sessionId: "approval-session",
          secretEnvBeforeSpawn: authorization.beforeSpawn,
        });

        expect(result.pendingResult?.details.status).toBe("approval-pending");
        await vi.waitFor(() => expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledTimes(1));
        await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));

        // Final process effect: the revoked entry never reached a launched process.
        await expect(fs.promises.stat(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
        expect(requireSentFollowupText(0)).toContain("secret-projection-denied");
        expect(captured.events.at(-1)).toMatchObject({
          action: "exec.approval.denied",
          outcome: "denied",
          policy: { reason: "secret-projection-denied" },
        });
      } finally {
        captured.stop();
      }
    } finally {
      fs.rmSync(markerPath, { force: true });
      await supervisor?.shutdown();
      policy.reset();
    }
  });

  // Positive control: with the same real owner and real process path, an
  // assignment still authorized at the launch boundary runs the real child and
  // delivers the assigned entry. Without this, "nothing launched" could be a
  // harness artifact rather than enforcement.
  it("launches the real child through the real deferred owner when the assignment stays authorized", async () => {
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "allowlist",
      hostAsk: "always",
      askFallback: "deny",
    });
    buildExecApprovalFollowupTargetMock.mockImplementation((value) => value);

    const policy = installSyntheticAssignmentPolicy();
    let supervisor: ReturnType<typeof createProcessSupervisor> | undefined;
    const markerPath = path.join(fs.realpathSync(os.tmpdir()), `assigned-${crypto.randomUUID()}`);
    try {
      policy.assign("agent-assigned", ["DEPLOY_ENV_A"]);
      const authorization = await policy.authorize("agent-assigned");
      expect(authorization.denied).toBeUndefined();
      const env: Record<string, string> = { PATH: "/usr/bin:/bin", ...authorization.storeEnv.env };

      const runtime = await vi.importActual<typeof import("./bash-tools.exec-runtime.js")>(
        "./bash-tools.exec-runtime.js",
      );
      runExecProcessMock.mockImplementation(runtime.runExecProcess);
      supervisor = createProcessSupervisor();
      startupCancellationMocks.spawn.mockImplementation(supervisor.spawn.bind(supervisor));

      resolveExecApprovalWaitOutcomeMock.mockResolvedValueOnce({
        kind: "resolved",
        decision: "allow-once",
        state: {
          baseDecision: { timedOut: false },
          approvedByAsk: true,
          deniedReason: null,
          timeoutContext: undefined,
        },
      });

      const result = await runGatewayAllowlist({
        command: `printf '%s' "$DEPLOY_ENV_A" > ${quoteCliArg(markerPath)}`,
        approvalFollowupMode: "agent",
        env,
        requestedEnv: env,
        workdir: os.tmpdir(),
        sessionId: "approval-session",
        secretEnvBeforeSpawn: authorization.beforeSpawn,
      });

      expect(result.pendingResult?.details.status).toBe("approval-pending");
      await vi.waitFor(() => expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));

      expect(fs.readFileSync(markerPath, "utf8")).toBe("synthetic-a");
      expect(requireSentFollowupText(0)).not.toContain("secret-projection-denied");
    } finally {
      fs.rmSync(markerPath, { force: true });
      await supervisor?.shutdown();
      policy.reset();
    }
  });
});
