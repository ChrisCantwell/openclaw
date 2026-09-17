import { formatErrorMessage as errorMessage } from "../../infra/errors.js";
import { registerSecretValueForRedaction } from "../../logging/secret-redaction-registry.js";
import {
  collectSecretStoreRefKeysInSnapshot,
  getActiveSecretsRuntimeSnapshotState,
} from "../../secrets/runtime-state.js";
import {
  purgeExpiredSecretStoreEntries,
  SecretStoreValidationError,
  updateSecretStoreEntryPolicy,
  writeSecretStoreEntry,
} from "../../secrets/store/secret-store.js";
// Gateway secret-store write service: owns redaction-first store writes and
// the runtime refresh shared by the store RPCs. Split from server-methods/
// secrets.ts to keep that handler file within its line budget.
import type { GatewayClient } from "./types.js";
const teamScope = { kind: "team" } as const;

export function storeUpdatedBy(client: GatewayClient | null): string {
  return (
    client?.authenticatedUserProfile?.displayName?.trim() ||
    client?.connect?.client?.displayName?.trim() ||
    client?.connect?.client?.id?.trim() ||
    "gateway"
  );
}

export type SecretStoreReload = (options?: {
  forceColdRefKeys?: ReadonlySet<string>;
  joinInFlight?: boolean;
}) => Promise<{ warningCount: number }>;

export type SecretStoreLogger = {
  warn?: (message: string) => void;
  debug?: (message: string) => void;
};

/** Owns redaction-first store writes and the runtime refresh shared by Gateway RPCs. */
export function createSecretStoreWriteService(params: {
  reloadSecrets: SecretStoreReload;
  log?: SecretStoreLogger;
}) {
  const purgeRetention = () => {
    try {
      purgeExpiredSecretStoreEntries();
    } catch (error) {
      params.log?.warn?.(`secrets.store retention purge failed: ${errorMessage(error)}`);
    }
  };
  const reloadReference = async (
    name: string,
  ): Promise<{ reloaded: boolean; warningCount?: number }> => {
    purgeRetention();
    const snapshot = getActiveSecretsRuntimeSnapshotState();
    const refKeys = snapshot
      ? collectSecretStoreRefKeysInSnapshot(snapshot, name)
      : new Set<string>();
    if (refKeys.size === 0) {
      return { reloaded: false };
    }
    // Explicit replacement must cold-refresh affected owners instead of
    // retaining an older credential from the active runtime snapshot.
    try {
      const reload = await params.reloadSecrets({ forceColdRefKeys: refKeys, joinInFlight: false });
      return { reloaded: true, warningCount: reload.warningCount };
    } catch (error) {
      params.log?.warn?.(`secrets.store runtime refresh failed: ${errorMessage(error)}`);
      throw error;
    }
  };

  return {
    resolveUpdatedBy: storeUpdatedBy,
    reloadReference,
    write(
      input: Omit<Parameters<typeof writeSecretStoreEntry>[0], "scope" | "database" | "value"> & {
        /** Omitted value performs a metadata-only update preserving the stored value. */
        value?: string;
      },
    ) {
      const value = input.value;
      if (value === undefined) {
        if (input.audience === undefined && input.allowedHosts === undefined) {
          throw new SecretStoreValidationError(
            "SECRET_STORE_VALUE_EMPTY",
            "A store write must supply a value, or policy metadata for an existing entry.",
          );
        }
        updateSecretStoreEntryPolicy({
          scope: teamScope,
          name: input.name,
          ...(input.audience !== undefined ? { audience: input.audience } : {}),
          ...(input.allowedHosts !== undefined ? { allowedHosts: input.allowedHosts } : {}),
          updatedBy: input.updatedBy,
        });
        return;
      }
      // Registration precedes validation and SQLite so even write failures
      // cannot disclose the submitted credential through downstream logging.
      registerSecretValueForRedaction(value);
      writeSecretStoreEntry({ scope: teamScope, ...input, value });
    },
  };
}

export type SecretStoreWriteService = ReturnType<typeof createSecretStoreWriteService>;
