// Default per-hook timeout budgets for the hook runner.
// Split from hooks.ts to keep that module within its line budget.
import type { PluginHookName } from "./hook-types.js";

export const DEFAULT_VOID_HOOK_TIMEOUT_MS_BY_HOOK: Partial<Record<PluginHookName, number>> = {
  agent_end: 30_000,
  channel_pairing_requested: 2_000,
  // Defensive default for the compaction lifecycle hooks. Without a budget an
  // unresponsive handler runs fully unbounded, and in the codex agent harness
  // these hooks fire on the serialized notification queue
  // (event-projector handleItemStarted awaits before_compaction / after_compaction
  // for a contextCompaction item), so a hung handler freezes every later codex
  // notification — including turn/completed — and the whole turn hangs. These
  // hooks can legitimately do real work (e.g. a memory flush), so the budget
  // matches agent_end's 30s rather than the tighter modifying-hook defaults.
  // The runner is fail-open for void hooks, so a timed-out handler is logged
  // and compaction proceeds.
  before_compaction: 30_000,
  after_compaction: 30_000,
  skill_changed: 30_000,
  skill_proposal_changed: 30_000,
  // Shutdown hooks share the Gateway's five-second teardown budget. They fail
  // open after logging so one plugin cannot consume the process watchdog.
  gateway_stop: 5_000,
};
export const DEFAULT_MODIFYING_HOOK_TIMEOUT_MS_BY_HOOK: Partial<Record<PluginHookName, number>> = {
  before_agent_run: 15_000,
  // Policy hooks fail closed in the global runner. A bounded timeout turns a
  // stalled policy process into a denial instead of freezing the operation.
  before_install: 15_000,
  before_tool_call: 15_000,
  // Terminal finalization hooks sit on the runner's completion path. A hung
  // handler must not freeze final delivery or keep compaction retry recovery
  // unresolved; timeout fail-opens with the original final answer.
  before_agent_finalize: 15_000,
  before_prompt_build: 15_000,
  // Outbound modifying hooks run inside the serialized reply delivery lane.
  // A hung plugin must fail open so later hooks and queued replies can settle.
  message_sending: 15_000,
  reply_payload_sending: 15_000,
  resolve_exec_env: 15_000,
  secret_env_authorize: 15_000,
  skill_proposal_evaluate: 120_000,
};
