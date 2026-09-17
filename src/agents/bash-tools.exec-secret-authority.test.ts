import { describe, expect, it, vi } from "vitest";
import type {
  SecretStoreEgressBinding,
  SecretStoreExecEnvironment,
} from "../secrets/store/secret-store-shared.js";
import { ExecProcessPreflightError } from "./bash-tools.exec-runtime.js";
import {
  armSecretEgressForLaunch,
  assertSecretAuthorityForLaunch,
  buildPreSpawnSecretAuthorityRecheck,
  buildSecretAuthorityDeniedResult,
  type GatewayRevalidateBeforeExecution,
  type SecretAuthorityRevalidate,
} from "./bash-tools.exec-secret-authority.js";

function binding(name: string): SecretStoreEgressBinding {
  return { name, sentinel: `SENTINEL_${name}`, allowedHosts: ["example.com"] };
}

function storeEnv(bindings: SecretStoreEgressBinding[]): SecretStoreExecEnvironment {
  return { secretEgressBindings: bindings };
}

const okRevalidate: SecretAuthorityRevalidate = () => ({ ok: true });

function deniedRevalidate(reason: string): SecretAuthorityRevalidate {
  return () => ({ ok: false, reason });
}

describe("assertSecretAuthorityForLaunch", () => {
  it("passes when authority still holds after the snapshot", async () => {
    await expect(
      assertSecretAuthorityForLaunch({
        storeEnv: storeEnv([binding("API_KEY")]),
        revalidate: okRevalidate,
        cwd: "/tmp",
      }),
    ).resolves.toBeUndefined();
  });

  it("throws ExecProcessPreflightError when a binding was revoked between snapshot and spawn", async () => {
    let threw: unknown;
    try {
      await assertSecretAuthorityForLaunch({
        storeEnv: storeEnv([binding("API_KEY"), binding("DB_PASS")]),
        revalidate: deniedRevalidate("secret assignment revoked since snapshot: API_KEY"),
        cwd: "/tmp",
      });
    } catch (error) {
      threw = error;
    }
    expect(threw).toBeInstanceOf(ExecProcessPreflightError);
    const result = ExecProcessPreflightError.unwrap(threw);
    expect(result.details.status).toBe("failed");
    expect(result.details.aggregated).toContain("denied");
  });

  it("revalidates projected env entries even without protected egress", async () => {
    const revalidate = vi.fn(okRevalidate);
    await expect(
      assertSecretAuthorityForLaunch({
        storeEnv: { env: { API_KEY: "cached" } },
        revalidate,
        cwd: undefined,
      }),
    ).resolves.toBeUndefined();
    expect(revalidate).toHaveBeenCalledWith({
      names: ["API_KEY"],
      agentId: undefined,
      config: undefined,
    });
  });

  it("does not consult authority when the snapshot projected no entries", async () => {
    const revalidate = vi.fn(okRevalidate);
    await expect(
      assertSecretAuthorityForLaunch({
        storeEnv: {},
        revalidate,
        cwd: undefined,
      }),
    ).resolves.toBeUndefined();
    expect(revalidate).not.toHaveBeenCalled();
  });
});

describe("armSecretEgressForLaunch", () => {
  const runInstance = { instanceId: "inst-1", runId: "run-1" };

  it("arms egress and registers bindings when authority holds", async () => {
    const registerRun = vi.fn(() => ({ PROXY: "1" }));
    const env = await armSecretEgressForLaunch({
      enabled: true,
      storeEnv: storeEnv([binding("API_KEY")]),
      operationalRunInstance: runInstance,
      registerRun,
      revalidate: okRevalidate,
      cwd: "/tmp",
    });
    expect(env).toEqual({ PROXY: "1" });
    expect(registerRun).toHaveBeenCalledWith(
      runInstance,
      [binding("API_KEY")],
      expect.any(Function),
    );
  });

  it("returns undefined when egress is not enabled", async () => {
    const registerRun = vi.fn();
    const env = await armSecretEgressForLaunch({
      enabled: false,
      storeEnv: storeEnv([binding("API_KEY")]),
      operationalRunInstance: runInstance,
      registerRun,
      revalidate: deniedRevalidate("unassigned"),
      cwd: undefined,
    });
    expect(env).toBeUndefined();
    expect(registerRun).not.toHaveBeenCalled();
  });

  it("denies egress arming after an audience narrowing or unassignment", async () => {
    const registerRun = vi.fn();
    let threw: unknown;
    try {
      await armSecretEgressForLaunch({
        enabled: true,
        storeEnv: storeEnv([binding("API_KEY")]),
        operationalRunInstance: runInstance,
        registerRun,
        revalidate: deniedRevalidate("agent no longer has access to API_KEY"),
        cwd: "/tmp",
      });
    } catch (error) {
      threw = error;
    }
    expect(threw).toBeInstanceOf(ExecProcessPreflightError);
    expect(registerRun).not.toHaveBeenCalled();
  });

  it("requires an admitted run instance when enabled", async () => {
    await expect(
      armSecretEgressForLaunch({
        enabled: true,
        storeEnv: storeEnv([binding("API_KEY")]),
        operationalRunInstance: undefined,
        registerRun: vi.fn(),
        revalidate: okRevalidate,
        cwd: undefined,
      }),
    ).rejects.toThrow(/run instance/);
  });
});

describe("buildPreSpawnSecretAuthorityRecheck", () => {
  it("installs a guard even without gateway approval or protected egress", () => {
    expect(
      buildPreSpawnSecretAuthorityRecheck({
        gatewayRevalidate: undefined,
        secretEgressEnabled: false,
        resolveStoreEnv: async () => ({}),
        cwd: undefined,
      }),
    ).toBeDefined();
  });

  it("returns the gateway denial before consulting the secret store", async () => {
    const resolveStoreEnv = vi.fn(async () => storeEnv([]));
    const gatewayRevalidate: GatewayRevalidateBeforeExecution = async () =>
      buildSecretAuthorityDeniedResult("gateway approval revoked", "/tmp");
    const hook = buildPreSpawnSecretAuthorityRecheck({
      gatewayRevalidate,
      secretEgressEnabled: true,
      resolveStoreEnv,
      cwd: "/tmp",
    });
    expect(hook).toBeDefined();
    const result = await hook!();
    expect(result?.details.aggregated).toContain("gateway approval revoked");
    expect(resolveStoreEnv).not.toHaveBeenCalled();
  });

  it("denies the launch when assignment was revoked between snapshot and spawn (including after approval wait)", async () => {
    const resolveStoreEnv = vi.fn(async () => storeEnv([binding("API_KEY")]));
    const hook = buildPreSpawnSecretAuthorityRecheck({
      gatewayRevalidate: undefined,
      secretEgressEnabled: true,
      resolveStoreEnv,
      agentId: "agent-1",
      config: undefined,
      cwd: "/tmp",
    });
    expect(hook).toBeDefined();
    // Stub the live recheck module so the revocation is deterministic.
    const execRuntime = await import("./bash-tools.exec-runtime.js");
    const execStoreSnapshot = await import("../secrets/exec-store-snapshot.js");
    const revalidateSpy = vi
      .spyOn(execStoreSnapshot, "revalidateAssignedSecretNames")
      .mockReturnValue({ ok: false, reason: "assignment revoked: API_KEY" });
    try {
      const result = await hook!();
      expect(result?.details.status).toBe("failed");
      expect(result?.details.aggregated).toContain("assignment revoked: API_KEY");
    } finally {
      revalidateSpy.mockRestore();
      void execRuntime;
    }
  });

  it("surfaces unexpected store errors instead of swallowing them", async () => {
    const resolveStoreEnv = vi.fn(async () => storeEnv([binding("API_KEY")]));
    const hook = buildPreSpawnSecretAuthorityRecheck({
      gatewayRevalidate: undefined,
      secretEgressEnabled: true,
      resolveStoreEnv,
      agentId: "agent-1",
      cwd: "/tmp",
    });
    const execStoreSnapshot = await import("../secrets/exec-store-snapshot.js");
    const revalidateSpy = vi
      .spyOn(execStoreSnapshot, "revalidateAssignedSecretNames")
      .mockImplementation(() => {
        throw new Error("store unavailable");
      });
    try {
      await expect(hook!()).rejects.toThrow("store unavailable");
    } finally {
      revalidateSpy.mockRestore();
    }
  });
});
