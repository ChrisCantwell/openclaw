// Secrets config schema fragments: provider unions and the top-level secrets block.
import path from "node:path";
import { z } from "zod";
import { isSafeExecutableValue } from "../infra/exec-safety.js";
import { normalizeExactAllowedHost } from "../secrets/exact-hostname.js";
import { ENV_SECRET_REF_ID_RE, SECRET_PROVIDER_ALIAS_PATTERN } from "../secrets/ref-contract.js";

const WINDOWS_ABS_PATH_PATTERN = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC_PATH_PATTERN = /^\\\\[^\\]+\\[^\\]+/;

function isAbsolutePath(value: string): boolean {
  // `path.isAbsolute` follows the host OS, but config files can be authored for Windows from
  // macOS/Linux. Accept Windows forms explicitly so cross-platform config validation stays stable.
  return (
    path.isAbsolute(value) ||
    WINDOWS_ABS_PATH_PATTERN.test(value) ||
    WINDOWS_UNC_PATH_PATTERN.test(value)
  );
}

const SecretsEnvProviderSchema = z
  .object({
    source: z.literal("env"),
    /** Optional env var allowlist (exact names). */
    allowlist: z.array(z.string().regex(ENV_SECRET_REF_ID_RE)).max(256).optional(),
  })
  .strict();

const SecretsFileProviderSchema = z
  .object({
    source: z.literal("file"),
    path: z.string().min(1),
    mode: z.union([z.literal("singleValue"), z.literal("json")]).optional(),
    timeoutMs: z.number().int().positive().max(120000).optional(),
    maxBytes: z
      .number()
      .int()
      .positive()
      .max(20 * 1024 * 1024)
      .optional(),
  })
  .strict();

const SecretsManualExecProviderSchema = z
  .object({
    source: z.literal("exec"),
    command: z
      .string()
      .min(1)
      .refine((value) => isSafeExecutableValue(value), "secrets.providers.*.command is unsafe.")
      .refine(
        (value) => isAbsolutePath(value),
        "secrets.providers.*.command must be an absolute path.",
      ),
    args: z.array(z.string().max(1024)).max(128).optional(),
    timeoutMs: z.number().int().positive().max(120000).optional(),
    noOutputTimeoutMs: z.number().int().positive().max(120000).optional(),
    maxOutputBytes: z
      .number()
      .int()
      .positive()
      .max(20 * 1024 * 1024)
      .optional(),
    jsonOnly: z.boolean().optional(),
    env: z.record(z.string(), z.string()).optional(),
    passEnv: z.array(z.string().regex(ENV_SECRET_REF_ID_RE)).max(128).optional(),
    trustedDirs: z
      .array(
        z
          .string()
          .min(1)
          .refine((value) => isAbsolutePath(value), "trustedDirs entries must be absolute paths."),
      )
      .max(64)
      .optional(),
  })
  .strict();

const SecretsPluginIntegrationExecProviderSchema = z
  .object({
    source: z.literal("exec"),
    pluginIntegration: z
      .object({
        pluginId: z.string().min(1).max(128),
        integrationId: z.string().min(1).max(128),
      })
      .strict(),
  })
  .strict();

const SecretsExecProviderSchema = z.union([
  SecretsManualExecProviderSchema,
  SecretsPluginIntegrationExecProviderSchema,
]);

const SecretsStoreProviderSchema = z.object({ source: z.literal("store") }).strict();

// Same exact-host contract as per-secret destination bindings: rejecting schemes,
// ports, wildcards, and malformed hostnames here keeps invalid entries out of the
// egress-proxy startup path, which would otherwise throw while starting the Gateway.
const EgressProxyExactHostSchema = z
  .string()
  .trim()
  .min(1)
  .superRefine((host, ctx) => {
    try {
      normalizeExactAllowedHost(host);
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : "Invalid allowed host",
      });
    }
  });

/** Schema for one configured env/file/exec/store secret provider entry. */
export const SecretProviderSchema = z.union([
  SecretsEnvProviderSchema,
  SecretsFileProviderSchema,
  SecretsExecProviderSchema,
  SecretsStoreProviderSchema,
]);

/** Schema for the top-level `secrets` config block. */
export const SecretsConfigSchema = z
  .object({
    egressProxy: z
      .object({
        enabled: z.boolean().optional(),
        allowedHosts: z.array(EgressProxyExactHostSchema).max(256).optional(),
        bypassHosts: z.array(EgressProxyExactHostSchema).max(256).optional(),
      })
      .strict()
      .optional(),
    providers: z
      .object({
        // Keep this as a record so users can define multiple named providers per source.
      })
      .catchall(SecretProviderSchema)
      .optional(),
    agentAssignmentEnforcement: z.enum(["off", "advisory", "enforce"]).optional(),
    defaults: z
      .object({
        env: z.string().regex(SECRET_PROVIDER_ALIAS_PATTERN).optional(),
        file: z.string().regex(SECRET_PROVIDER_ALIAS_PATTERN).optional(),
        exec: z.string().regex(SECRET_PROVIDER_ALIAS_PATTERN).optional(),
        store: z.string().regex(SECRET_PROVIDER_ALIAS_PATTERN).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .optional();
