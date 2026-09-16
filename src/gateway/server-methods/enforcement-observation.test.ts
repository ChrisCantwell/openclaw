// Unit tests for the bounded enforcement-mode runtime-observation contract.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ENFORCEMENT_OBSERVATION_TIMEOUT_MS,
  resolveEnforcementObservationTimeoutMs,
  waitForEnforcementObservation,
} from "./enforcement-observation.js";

describe("waitForEnforcementObservation", () => {
  it("returns observed immediately when the runtime already reports the requested mode", async () => {
    const result = await waitForEnforcementObservation({
      requested: "enforce",
      preWrite: "off",
      read: () => "enforce",
      timeoutMs: 200,
    });
    expect(result).toEqual({ status: "observed", mode: "enforce" });
  });

  it("waits for a delayed observer and reports observed once it lands (persist first, observer later)", async () => {
    let mode: "off" | "advisory" | "enforce" = "off";
    setTimeout(() => {
      mode = "enforce";
    }, 60);
    const result = await waitForEnforcementObservation({
      requested: "enforce",
      preWrite: "off",
      read: () => mode,
      timeoutMs: 2_000,
    });
    expect(result).toEqual({ status: "observed", mode: "enforce" });
  });

  it("returns timeout without observing when the mode never lands within the deadline", async () => {
    const startedAt = Date.now();
    const result = await waitForEnforcementObservation({
      requested: "enforce",
      preWrite: "off",
      read: () => "off",
      timeoutMs: 120,
    });
    expect(result).toEqual({ status: "timeout", mode: "off" });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(110);
    expect(Date.now() - startedAt).toBeLessThan(1_500);
  }, 3_000);

  it("returns superseded immediately when the runtime reports a third mode", async () => {
    const startedAt = Date.now();
    const result = await waitForEnforcementObservation({
      requested: "enforce",
      preWrite: "off",
      read: () => "advisory",
      timeoutMs: 5_000,
    });
    expect(result).toEqual({ status: "superseded", mode: "advisory" });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it("defaults to the shared deadline when no override is given", () => {
    expect(DEFAULT_ENFORCEMENT_OBSERVATION_TIMEOUT_MS).toBeGreaterThan(0);
    expect(resolveEnforcementObservationTimeoutMs(undefined)).toBeUndefined();
    expect(resolveEnforcementObservationTimeoutMs(0)).toBeUndefined();
    expect(resolveEnforcementObservationTimeoutMs(-1)).toBeUndefined();
    expect(resolveEnforcementObservationTimeoutMs(Number.NaN)).toBeUndefined();
    expect(resolveEnforcementObservationTimeoutMs(250)).toBe(250);
  });
});
