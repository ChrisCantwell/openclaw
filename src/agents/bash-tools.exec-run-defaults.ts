// Exec tool defaults and follow-up constants.
// Split from bash-tools.exec-run.ts to keep that module within its line budget.
import { clampWithDefault, readEnvInt } from "./bash-tools.shared.js";

export const BACKGROUND_EXEC_FOLLOW_UP =
  "Use process (list/poll/log/write/send-keys/submit/paste/kill/clear/remove) for follow-up.";

/** Resolves the yield-window default and whether backgrounding is available. */
export function resolveExecBackgroundDefaults(defaults?: {
  backgroundMs?: number;
  allowBackground?: boolean;
  processToolAvailabilityRef?: { value?: boolean };
}): { defaultBackgroundMs: number; allowBackground: boolean } {
  return {
    defaultBackgroundMs: clampWithDefault(
      defaults?.backgroundMs ?? readEnvInt("OPENCLAW_BASH_YIELD_MS", "PI_BASH_YIELD_MS"),
      10_000,
      10,
      120_000,
    ),
    allowBackground:
      defaults?.processToolAvailabilityRef?.value ?? defaults?.allowBackground ?? true,
  };
}
