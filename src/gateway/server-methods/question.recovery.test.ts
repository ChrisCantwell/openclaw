import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  getAdmittedRunDelegatedAuthority,
  prepareSystemAgentRunAdmission,
  type PreparedAgentRunAdmission,
} from "../../agents/admitted-run-context.js";
import { prepareEmbeddedAttemptTimeout } from "../../agents/embedded-agent-runner/run/attempt-timeout-prepare.js";
import {
  abortAndDrainEmbeddedAgentRun,
  clearActiveEmbeddedRun,
  queueEmbeddedAgentMessageWithOutcomeAsync,
  setActiveEmbeddedRun,
  type EmbeddedAgentQueueHandle,
} from "../../agents/embedded-agent-runner/runs.js";
import { testing as embeddedRunTesting } from "../../agents/embedded-agent-runner/runs.test-support.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../agents/tools/gateway-caller-context.js";
import {
  createReplyOperation,
  isReplyRunEvidenceStale,
} from "../../auto-reply/reply/reply-run-registry.js";
import { admitReplyTurn } from "../../auto-reply/reply/reply-turn-admission.js";
import {
  claimAgentRunDelegatedAuthority,
  clearAgentRunContext,
  registerAgentRunContext,
  registerAgentRunDelegatedAuthorityClosedHandler,
  releaseAgentRunDelegatedAuthority,
  rotateAgentRunRegistryLifecycleGeneration,
  type AgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import {
  emitTrustedDiagnosticEvent,
  resetDiagnosticEventsForTest,
  setDiagnosticsEnabledForProcess,
} from "../../infra/diagnostic-events.js";
import { recoverStuckDiagnosticSession } from "../../logging/diagnostic-stuck-session-recovery.runtime.js";
import { diagnosticLogger, startDiagnosticHeartbeat } from "../../logging/diagnostic.js";
import { resetDiagnosticStateForTest } from "../../logging/diagnostic.test-support.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../agent-runtime-identity-token.js";
import { QuestionManager } from "../question-manager.js";
import { createQuestionHandlers } from "./question.js";
import { createSecretStoreWriteService } from "./secrets-store-write-service.js";
import type { GatewayClient, GatewayRequestHandlerOptions, RespondFn } from "./types.js";

const ref = {
  sessionId: "human-wait-session",
  sessionKey: "agent:main:main",
  runId: "human-wait-run",
};
let manager: QuestionManager;
let authority: AgentRunDelegatedAuthority;
let unregister: () => void;
let client: GatewayClient;
let handlers: ReturnType<typeof createQuestionHandlers>;
let admission: PreparedAgentRunAdmission;
let onBroadcast: (event: string) => void;
let requesterActive: boolean;
let validateAuthority: ReturnType<typeof createAgentRuntimeApprovalAuthorityValidator>;
const abort = vi.fn();
let handle: EmbeddedAgentQueueHandle;

beforeEach(async () => {
  handle = {
    runId: ref.runId,
    queueMessage: async () => {},
    isStreaming: () => true,
    isCompacting: () => false,
    abort,
  };
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2026-08-20T12:00:00Z"));
  setDiagnosticsEnabledForProcess(true);
  manager = new QuestionManager();
  onBroadcast = () => {};
  requesterActive = true;
  const validateRunAuthority = createAgentRuntimeApprovalAuthorityValidator();
  validateAuthority = (identity) => requesterActive && validateRunAuthority(identity);
  registerAgentRunContext(ref.runId, { sessionKey: ref.sessionKey, agentId: "main" });
  admission = prepareSystemAgentRunAdmission({}, ref.runId, "main", "question-recovery-test");
  const admitted = await admission.admit("embedded");
  authority = getAdmittedRunDelegatedAuthority(admitted)!;
  unregister = registerAgentRunDelegatedAuthorityClosedHandler(() =>
    manager.cancelClosedAuthorities(),
  );
  client = {
    connect: { scopes: ["operator.admin"] },
    internal: {
      agentRuntimeIdentity: {
        kind: "agentRuntime",
        agentId: "main",
        sessionKey: ref.sessionKey,
        operationalRunInstance: authority.operationalRunInstance,
        delegatedAuthority: { kind: "local", ...authority },
      },
    },
  } as GatewayClient;
  handlers = createQuestionHandlers(
    manager,
    createSecretStoreWriteService({ reloadSecrets: async () => ({ warningCount: 0 }) }),
  );
  abort.mockReset().mockImplementation(() => {
    releaseAgentRunDelegatedAuthority(authority);
    clearActiveEmbeddedRun(ref.sessionId, handle, ref.sessionKey);
  });
  await withGatewayToolCallerIdentity(
    createAdmittedGatewayToolCallerIdentity({
      admittedRunContext: admitted,
      agentId: "main",
      sessionKey: ref.sessionKey,
    }),
    () => setActiveEmbeddedRun(ref.sessionId, handle, ref.sessionKey),
  );
});

afterEach(() => {
  resetDiagnosticStateForTest();
  admission.close();
  releaseAgentRunDelegatedAuthority(authority);
  unregister();
  clearAgentRunContext(ref.runId);
  manager.close();
  embeddedRunTesting.resetActiveEmbeddedRuns();
  resetDiagnosticEventsForTest();
  vi.useRealTimers();
});

async function call(method: string, params: Record<string, unknown>, trusted = true) {
  const responses: Parameters<RespondFn>[] = [];
  await handlers[method]!({
    req: { type: "req", id: "request", method, params },
    params,
    client: trusted ? client : ({ connect: { scopes: ["operator.admin"] } } as GatewayClient),
    respond: (...args) => responses.push(args),
    isWebchatConnect: () => false,
    context: {
      broadcast: (event: string) => onBroadcast(event),
      getRuntimeConfig: () => ({}),
      validateAgentRuntimeApprovalAuthority: validateAuthority,
    } as unknown as GatewayRequestHandlerOptions["context"],
  });
  return responses[0];
}

async function request(
  tool: "secrets" | "ask_user",
  trusted = true,
  timeoutMs = 3_600_000,
  id = "human-question",
) {
  const params = {
    id,
    agentId: "main",
    sessionKey: ref.sessionKey,
    runId: ref.runId,
    timeoutMs,
    questions: [
      {
        questionId: "answer",
        header: "Input",
        question: "Provide the requested input",
        options: [],
        isOther: true,
        ...(tool === "secrets"
          ? {
              isSecret: true,
              secretStore: {
                name: "TEST_API_KEY",
                kind: "secret",
                allowedHosts: ["api.example.test"],
              },
            }
          : {}),
      },
    ],
  };
  expect((await