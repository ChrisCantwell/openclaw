// Lazy per-run exec secret-store reader.
// Split from bash-tools.exec-run.ts to keep that module within its line budget.
import type { SecretStoreExecEnvironment } from "../secrets/store/secret-store.js";

/**
 * Returns a memoized reader: agent runs own one exec tool instance, so the store
 * is read on first use and reused for that run; a new run constructs a new
 * instance and observes later store mutations.
 */
export function createExecStoreEnvReader(params: {
  includeSecretSentinels: boolean;
  excludeNames: readonly string[];
}): () => Promise<SecretStoreExecEnvironment> {
  let cached: Promise<SecretStoreExecEnvironment> | undefined;
  return () =>
    (cached ??= import("../secrets/store/secret-store.js").then((store) =>
      store.readSecretStoreExecEnvironment({
        includeSecretSentinels: params.includeSecretSentinels,
        excludeNames: params.excludeNames,
      }),
    ));
}
