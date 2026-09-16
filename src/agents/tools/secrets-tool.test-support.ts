// Shared fixtures and gateway stubs for secrets-tool tests; extracted to keep
// the main suite within its line budget.
import { Value } from "typebox/value";
import { expect, vi } from "vitest";
import { GatewayClientRequestError } from "../../../packages/gateway-client/src/request-error.js";
import {
  QuestionRequestParamsSchema,
  QuestionResolveParamsSchema,
  QuestionWaitAnswerParamsSchema,
} from "../../../packages/gateway-protocol/src/schema/questions.js";
import { QuestionManager, QuestionManagerError } from "../../gateway/question-manager.js";
import { createSecretsTool } from "./secrets-tool.js";

type GatewayCall = NonNullable<Parameters<typeof createSecretsTool>[0]["gatewayCall"]>;

export function gatewayStub(
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

export function questionManagerGateway(
  manager: QuestionManager,
  onRequest: (request: Parameters<QuestionManager["request"]>[0]) => unknown,
) {
  return gatewayStub(async (method, _options, params) => {
    try {
      if (method === "question.request") {
        const request = Value.Parse(QuestionRequestParamsSchema, params);
        return onRequest({ ...request, timeoutMs: request.timeoutMs ?? 60_000 });
      }
      if (method === "question.resolve") {
        const request = Value.Parse(QuestionResolveParamsSchema, params);
        if (!("cancel" in request)) {
          throw new Error("expected question cancellation");
        }
        return manager.cancel(request.id, request.resolvedBy);
      }
      if (method === "question.waitAnswer") {
        const request = Value.Parse(QuestionWaitAnswerParamsSchema, params);
        return manager.waitAnswer(request.id, request.timeoutMs);
      }
      throw new Error(`unexpected method ${method}`);
    } catch (error) {
      if (error instanceof QuestionManagerError) {
        throw new GatewayClientRequestError({
          code: "INVALID_REQUEST",
          message: error.message,
          details: { reason: error.code },
        });
      }
      throw error;
    }
  });
}

export function requestedQuestionId(mock: ReturnType<typeof gatewayStub>["mock"]): string {
  const request = mock.mock.calls.find(([method]) => method === "question.request");
  const questionId = request?.[2].id;
  if (typeof questionId !== "string") {
    throw new Error("question.request did not include an id");
  }
  return questionId;
}

export const storedAnswer = {
  status: "answered",
  answers: { answers: { secret_value: ["stored"] } },
};
export const storeMetadata = {
  name: "SERVICE_API_KEY",
  createdAtMs: 0,
  updatedAtMs: 0,
  scopeKind: "team",
  scopeId: "",
};
export const editedPolicy = { status: "available", allowedHosts: ["api.analytics.example"] };
export const secretEntry = {
  ...storeMetadata,
  kind: "secret",
  allowedHosts: editedPolicy.allowedHosts,
};
export const unrelatedEnv = {
  ...storeMetadata,
  name: "UNRELATED_ENV",
  kind: "env",
  value: "private-env-value",
};

export function storedRequestGateway(readMetadata: () => Promise<unknown>) {
  return gatewayStub(async (method, _options, params) => {
    if (method === "question.request") {
      return { id: params.id };
    }
    if (method === "secrets.assignments.entry") {
      // One name-scoped metadata read; never the store inventory. Env values
      // are stripped server-side, mirroring the value-free protocol result.
      expect(params).toEqual({ name: "SERVICE_API_KEY" });
      const metadata = await readMetadata();
      const entries = (metadata as { entries: Array<Record<string, unknown>> }).entries;
      const found = entries.find((entry) => entry.name === "SERVICE_API_KEY") ?? null;
      if (!found) {
        return { entry: null };
      }
      // Server-side mapping strips env values only; a secret entry carrying a
      // value field stays structurally invalid and fails validation.
      if (found.kind === "env") {
        const { value: _stripped, ...metadataOnly } = found;
        return { entry: metadataOnly };
      }
      return { entry: found };
    }
    return storedAnswer;
  });
}
