// Verifies the secret_env_authorize hook through the real hook runner:
// most-restrictive intersection, fail-closed default, and no handlers.
import { describe, expect, it } from "vitest";
import { createHookRunner } from "./hooks.js";
import { addStaticTestHooks } from "./hooks.test-fixtures.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import type { PluginHookSecretEnvAuthorizeContext } from "./types.js";

const ctx: PluginHookSecretEnvAuthorizeContext = { agentId: "agent-1" };

function registryWith(
  hooks: Array<{ pluginId: string; allowedNames: string[]; priority?: number }>,
) {
  const registry = createEmptyPluginRegistry();
  addStaticTestHooks(registry, {
    hookName: "secret_env_authorize",
    hooks: hooks.map((h) => ({
      pluginId: h.pluginId,
      result: { allowedNames: h.allowedNames },
      ...(h.priority !== undefined ? { priority: h.priority } : {}),
    })),
  });
  return registry;
}

describe("secret_env_authorize hook", () => {
  it("returns undefined when no handlers are registered", async () => {
    const runner = createHookRunner(createEmptyPluginRegistry());
    await expect(
      runner.runSecretEnvAuthorize(
        { toolName: "exec", host: "gateway", candidates: [{ name: "A", kind: "env" }] },
        ctx,
      ),
    ).resolves.toBeUndefined();
  });

  it("intersects handler results so the most restrictive set wins", async () => {
    const registry = registryWith([
      { pluginId: "wide", allowedNames: ["A", "B", "C"] },
      { pluginId: "narrow", allowedNames: ["A", "B"] },
      { pluginId: "narrower", allowedNames: ["B"] },
    ]);
    const runner = createHookRunner(registry);
    await expect(
      runner.runSecretEnvAuthorize({ toolName: "exec", host: "gateway", candidates: [] }, ctx),
    ).resolves.toEqual({ allowedNames: ["B"] });
  });

  it("a handler that authorizes nothing makes the intersection empty", async () => {
    const registry = registryWith([
      { pluginId: "a", allowedNames: ["A", "B"] },
      { pluginId: "b", allowedNames: [] },
    ]);
    const runner = createHookRunner(registry);
    await expect(
      runner.runSecretEnvAuthorize({ toolName: "exec", host: "gateway", candidates: [] }, ctx),
    ).resolves.toEqual({ allowedNames: [] });
  });

  it("a bare runner is fail-open and yields no decision; the seam converts that to a denial", async () => {
    const registry = createEmptyPluginRegistry();
    addStaticTestHooks(registry, {
      hookName: "secret_env_authorize",
      hooks: [
        {
          pluginId: "crasher",
          result: { allowedNames: ["A"] },
          handler: () => {
            throw new Error("policy failed");
          },
        },
      ],
    });
    // A bare runner (no catchErrors/policy) logs the handler error and yields
    // no decision. authorizeSecretEnvProjection treats "registered but no
    // decision" as a denial, so fail-open at this layer is still fail-closed
    // at the seam.
    const runner = createHookRunner(registry);
    await expect(
      runner.runSecretEnvAuthorize({ toolName: "exec", host: "gateway", candidates: [] }, ctx),
    ).resolves.toBeUndefined();
  });

  it("stays fail-closed with catchErrors + policy, so the caller sees a denial not a value", async () => {
    const registry = createEmptyPluginRegistry();
    addStaticTestHooks(registry, {
      hookName: "secret_env_authorize",
      hooks: [
        {
          pluginId: "crasher",
          result: { allowedNames: ["A"] },
          handler: () => {
            throw new Error("policy failed");
          },
        },
      ],
    });
    const runner = createHookRunner(registry, {
      catchErrors: true,
      failurePolicyByHook: { secret_env_authorize: "fail-closed" },
    });
    await expect(
      runner.runSecretEnvAuthorize({ toolName: "exec", host: "gateway", candidates: [] }, ctx),
    ).rejects.toThrow(/policy failed/);
  });
});
