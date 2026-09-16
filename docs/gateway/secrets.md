---
summary: "Secrets management: SecretRef contract, shared secret store, runtime snapshots, and safe one-way scrubbing"
read_when:
  - Configuring SecretRefs for provider credentials and SQLite auth-profile refs
  - Storing team-wide secrets and environment values in the shared SQLite store
  - Operating secrets reload, audit, configure, and apply safely in production
  - Understanding startup fail-fast, inactive-surface filtering, and last-known-good behavior
title: "Secrets management"
sidebarTitle: "Secrets management"
---

OpenClaw supports additive SecretRefs so supported credentials do not need to live as plaintext in configuration.

<Note>
Plaintext still works. SecretRefs are opt-in per credential.
</Note>

<Warning>
Plaintext credentials remain agent-readable when they sit in files the agent can inspect, including `openclaw.json`, `.env`, retired auth-profile JSON archives, or generated `agents/*/agent/models.json` files. SecretRefs reduce that local blast radius once every supported credential is migrated and `openclaw secrets audit --check` reports no plaintext residue.
</Warning>

This page is an index. Secrets management is documented on five pages, one per reader job.
Open the page that matches your task.

## Secrets pages

| Page                                                                             | Read it when                                                                                                 |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| [Secrets runtime model](/gateway/secrets/runtime-model)                          | Owner isolation, sentinel injection, the agent-access boundary, and active-surface filtering.                |
| [SecretRef contract and provider config](/gateway/secrets/secretref-contract)    | The SecretRef contract, id grammars, validation rules, and the env, file, exec, and store provider blocks.   |
| [Shared secret store and egress proxy](/gateway/secrets/secret-store-and-egress) | The shared secret store, the secret egress proxy and its traffic allowlist, and file-backed API keys.        |
| [Secrets integration examples](/gateway/secrets/integration-examples)            | Exec provider recipes for 1Password, Bitwarden, Vault, pass, and sops, plus MCP and sandbox SSH.             |
| [Secrets operations and behavior](/gateway/secrets/operations)                   | Supported surfaces, precedence, activation triggers, degraded signals, and the audit and configure workflow. |

### Agent secret assignment broker

Gateway methods `secrets.assignments.list` and `secrets.assignments.has` let an
authenticated agent discover which secret names it has been assigned — metadata
only, no values. The CLI commands `openclaw secrets assign` and
`openclaw secrets unassign` manage bindings. See
[CLI: secrets](/cli/secrets#agent-assignments) and
[Secrets operations](/gateway/secrets/operations).

### Exec snapshot audience and enforcement

Every secret-store entry carries an explicit, persisted audience that is
orthogonal to value protection (kind). The audience decides which agents
receive the entry through delivery paths; the off/advisory/enforce mode
governs how denials behave for selected-audience entries:

- `audience: "all"` (default, and the behavior of every entry that predates
  the audience column): legacy team-wide delivery. Every valid agent receives
  the entry on every current or future delivery path, regardless of
  assignment rows.
- `audience: "selected"`: only agents with an explicit
  `agent_secret_assignments` row receive the entry. An empty assignment set
  never implies global access, and invalid agent identities fail closed —
  they never inherit the unscoped store.

The automatic agent exec store snapshot honors this audience with
`secrets.agentAssignmentEnforcement`:

- `off` (default): all-audience entries keep full legacy delivery;
  selected-audience entries still project only to their assigned agents
  (unassigned ones are withheld silently).
- `advisory`: same delivery decisions as `off`, but selected entries the
  current agent is not assigned log a per-entry warning so operators can soak
  before tightening.
- `enforce`: additionally fails closed when no valid agent identity can be
  derived — a missing or invalid identity yields a generic denial instead of
  projecting the unscoped store. Enforcement honors the explicit audience:
  it never converts an `all`-audience entry into assignment-only delivery.
  Subagent sessions use their owning configured agent's identity and
  therefore share that agent's assignments; they are not separate assignment
  principals. An unsandboxed agent with same-user host access can still read
  state database, process, file, or upstream-vault material directly: this is
  supported-path OpenClaw authorization and defense in depth, not OS
  isolation.

The Control UI enforcement switch awaits a durable config persist and then
confirms the mode against the live runtime source with a bounded,
condition-based wait before reporting success. If the wait expires without
observing the expected mode (about five seconds), the switch reports failure
with the authoritative post-attempt mode in a separate error callout, never
as a success notice. A timeout is not a rollback: the persist may still have
landed, and the error callout's mode is the source of truth.

Agent identity is derived from authenticated runtime context inside the exec
tool; it cannot be selected through model or tool arguments. Operator config
materialization, CLI surfaces, and the operator-owned `createExecTool` callers
(diagnostics, export-trajectory, and the auto-reply bash command) are
unaffected. When a derived agent id is absent, `advisory` still delivers every
entry (legacy behavior, warn-only soak); under `enforce`, however, a missing
or invalid identity fails closed with a generic denial instead of projecting
the unscoped store.

The model-facing `secrets` tool `list` action never renders env entry values.
When assignment policy is active (`advisory` or `enforce`), `list` returns only
names accessible to the runtime agent — all-audience entries plus its
selected-audience assignments — and does not call the identity-blind
full-store listing; with policy `off` it lists store metadata with env values
redacted (a presentation window, not an authorization bound). `request`
stores an entry without assigning it, and its post-write policy read is
name-scoped (`secrets.assignments.entry`): the tool process never receives
the unscoped team store. `secrets.assignments.entry` is an exact-name read
for live agent runtime identity — it is not assignment-scoped. By exact
secret name it discloses store existence (entry vs null), entry kind,
creation/update timestamps, `updatedBy`, the entry's `audience`, and the
secret's `allowedHosts`; values never cross. This name-scoped disclosure is
what lets `request` verify post-write host policy without assigning or
listing. Under any policy, a selected-audience entry the agent is not
assigned does not project into its exec environment; operators assign the
name or widen the entry to `all` explicitly.
Model-facing `delete` is refused while any assignment policy is active;
operators use the CLI or Control UI. The Control UI Settings → Secrets page
manages the store, agent assignments, and the off/advisory/enforce mode for
authenticated operators (operator.admin scope), with a confirmation warning
before switching to `enforce`; the CLI remains an equivalent fallback. The
page edits each entry's two independent axes separately: **Value protection**
(Protected secret vs Agent-readable environment value) and **Agent access**
(All agents vs Selected agents, with the assignment picker shown only for
selected-audience entries). The operator-admin assignment RPCs (`secrets.assignments.admin.*`,
`secrets.assignments.enforcement.*`) take explicit agent ids, never derive
identity from runtime context, and carry no secret values; the model-facing
self-only RPCs are unchanged.

## Where each section moved

Every section, tab, step, and accordion title from the previous single-page
version keeps its anchor here, so an existing link such as
`/gateway/secrets#shared-secret-store` still resolves. Each entry points at the
page that now holds the content.

- <a id="runtime-model" />[Runtime model](/gateway/secrets/runtime-model#runtime-model)
- <a id="egress-time-injection-(sentinels)" />[Egress-time injection (sentinels)](/gateway/secrets/runtime-model#egress-time-injection-sentinels)
- <a id="agent-access-boundary" />[Agent-access boundary](/gateway/secrets/runtime-model#agent-access-boundary)
- <a id="active-surface-filtering" />[Active-surface filtering](/gateway/secrets/runtime-model#active-surface-filtering)
- <a id="gateway-auth-surface-diagnostics" />[Gateway auth surface diagnostics](/gateway/secrets/runtime-model#gateway-auth-surface-diagnostics)
- <a id="onboarding-reference-preflight" />[Onboarding reference preflight](/gateway/secrets/runtime-model#onboarding-reference-preflight)
- <a id="secretref-contract" />[SecretRef contract](/gateway/secrets/secretref-contract#secretref-contract)
- <a id="provider-config" />[Provider config](/gateway/secrets/secretref-contract#provider-config)
- <a id="shared-secret-store" />[Shared secret store](/gateway/secrets/secret-store-and-egress#shared-secret-store)
- <a id="secret-egress-proxy" />[Secret egress proxy](/gateway/secrets/secret-store-and-egress#secret-egress-proxy)
- <a id="traffic-allowlist" />[Traffic allowlist](/gateway/secrets/secret-store-and-egress#traffic-allowlist)
- <a id="file-backed-api-keys" />[File-backed API keys](/gateway/secrets/secret-store-and-egress#file-backed-api-keys)
- <a id="exec-integration-examples" />[Exec integration examples](/gateway/secrets/integration-examples#exec-integration-examples)
- <a id="mcp-server-environment-variables" />[MCP server environment variables](/gateway/secrets/integration-examples#mcp-server-environment-variables)
- <a id="sandbox-ssh-auth-material" />[Sandbox SSH auth material](/gateway/secrets/integration-examples#sandbox-ssh-auth-material)
- <a id="supported-credential-surface" />[Supported credential surface](/gateway/secrets/operations#supported-credential-surface)
- <a id="required-behavior-and-precedence" />[Required behavior and precedence](/gateway/secrets/operations#required-behavior-and-precedence)
- <a id="activation-triggers" />[Activation triggers](/gateway/secrets/operations#activation-triggers)
- <a id="degraded-and-recovered-signals" />[Degraded and recovered signals](/gateway/secrets/operations#degraded-and-recovered-signals)
- <a id="command-path-resolution" />[Command-path resolution](/gateway/secrets/operations#command-path-resolution)
- <a id="audit-and-configure-workflow" />[Audit and configure workflow](/gateway/secrets/operations#audit-and-configure-workflow)
- <a id="one-way-safety-policy" />[One-way safety policy](/gateway/secrets/operations#one-way-safety-policy)
- <a id="legacy-auth-compatibility-notes" />[Legacy auth compatibility notes](/gateway/secrets/operations#legacy-auth-compatibility-notes)
- <a id="control-ui" />[Control UI](/gateway/secrets/operations#control-ui)
- <a id="egress-time-injection-sentinels" />[Egress-time injection (sentinels)](/gateway/secrets/runtime-model#egress-time-injection-sentinels)
- <a id="examples-of-inactive-surfaces" />[Examples of inactive surfaces](/gateway/secrets/runtime-model#examples-of-inactive-surfaces)
- <a id="env" />[env](/gateway/secrets/secretref-contract#env)
- <a id="file" />[file](/gateway/secrets/secretref-contract#file)
- <a id="exec" />[exec](/gateway/secrets/secretref-contract#exec)
- <a id="store" />[store](/gateway/secrets/secretref-contract#store)
- <a id="env-provider" />[Env provider](/gateway/secrets/secretref-contract#env-provider)
- <a id="file-provider" />[File provider](/gateway/secrets/secretref-contract#file-provider)
- <a id="exec-provider" />[Exec provider](/gateway/secrets/secretref-contract#exec-provider)
- <a id="store-provider" />[Store provider](/gateway/secrets/secretref-contract#store-provider)
- <a id="1password" />[1Password](/gateway/secrets/integration-examples#1password)
- <a id="bitwarden-secrets-manager-openclawverbatim568end" />[Bitwarden Secrets Manager (`bws`)](/gateway/secrets/integration-examples#bitwarden-secrets-manager-openclawverbatim229end)
- <a id="hashicorp-vault-cli" />[HashiCorp Vault CLI](/gateway/secrets/integration-examples#hashicorp-vault-cli)
- <a id="password-store-openclawverbatim579end" />[password-store (`pass`)](/gateway/secrets/integration-examples#password-store-openclawverbatim240end)
- <a id="sops" />[sops](/gateway/secrets/integration-examples#sops)
- <a id="strict-command-paths" />[Strict command paths](/gateway/secrets/operations#strict-command-paths)
- <a id="read-only-command-paths" />[Read-only command paths](/gateway/secrets/operations#read-only-command-paths)
- <a id="audit-current-state" />[Audit current state](/gateway/secrets/operations#audit-current-state)
- <a id="configure-and-apply-secretrefs" />[Configure and apply SecretRefs](/gateway/secrets/operations#configure-and-apply-secretrefs)
- <a id="re-audit" />[Re-audit](/gateway/secrets/operations#re-audit)
- <a id="secrets-audit" />[secrets audit](/gateway/secrets/operations#secrets-audit)
- <a id="secrets-configure" />[secrets configure](/gateway/secrets/operations#secrets-configure)
- <a id="secrets-apply" />[secrets apply](/gateway/secrets/operations#secrets-apply)

## Related

- [Authentication](/gateway/authentication) - auth setup
- [CLI: secrets](/cli/secrets) - CLI commands
- [Vault SecretRefs](/plugins/vault) - HashiCorp Vault provider setup
- [Environment Variables](/help/environment) - environment precedence
- [SecretRef Credential Surface](/reference/secretref-credential-surface) - credential surface
- [Secrets Apply Plan Contract](/gateway/secrets-plan-contract) - plan contract details
- [Security](/gateway/security) - security posture
- [Configuration reference](/gateway/configuration-reference) - where each secrets and env setting is documented
- [Ask user](/tools/ask-user) - asking the operator a non-secret question; never answer it with a credential, use the masked `secrets` tool for those
- [Auth credential semantics](/auth-credential-semantics) - the canonical rules for auth profile ordering and runtime credential resolution
