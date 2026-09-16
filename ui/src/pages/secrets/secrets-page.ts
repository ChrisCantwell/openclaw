import { consume } from "@lit/context";
import { html } from "lit";
import { state } from "lit/decorators.js";
import { ENV_SECRET_REF_ID_RE } from "../../../../src/config/types.secrets.js";
import { isSensitiveEnvName } from "../../../../src/secrets/secret-env-name.js";
import { titleForRoute } from "../../app-navigation.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { renderSettingsPageHeader } from "../../components/settings-ui.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { t } from "../../i18n/index.ts";
import { canCallGatewayMethod, isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import {
  assignSecretName,
  assignmentAgentIds,
  createInitialAssignmentsAdminState,
  createInitialEnforcementState,
  loadAllAssignmentsAdmin,
  loadEnforcementMode,
  setEnforcementMode,
  storeEntryNames,
  unassignSecretName,
  type EnforcementMode,
} from "../../lib/secrets-assignments/index.ts";
import {
  bulkSetSecretsStoreEntries,
  createInitialSecretsStoreState,
  deleteSecretsStoreEntry,
  loadSecretsStore,
  parseSecretsStoreBulkInput,
  setSecretsStoreEntry,
  type SecretsStoreDraft,
  type SecretsStoreState,
} from "../../lib/secrets-store/index.ts";
import { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { renderSecretsStore, type SecretsDialogMode } from "./view.ts";

const MAX_VALUE_BYTES = 64 * 1024;

class SecretsPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @state() private store = createInitialSecretsStoreState();
  @state() private assignments = createInitialAssignmentsAdminState();
  @state() private enforcement = createInitialEnforcementState();
  @state() private assignmentAgent = "";
  @state() private assignmentName = "";
  @state() private rosterAgentIds: string[] = [];
  @state() private assignmentNotice: string | null = null;
  /** Enforcement success feedback; never carries error text. */
  @state() private enforcementNotice: string | null = null;
  /** Enforcement error feedback; never rendered as success. */
  @state() private enforcementErrorNotice: string | null = null;
  @state() private dialogMode: SecretsDialogMode = null;
  @state() private draft: SecretsStoreDraft = {
    name: "",
    value: "",
    kind: "env",
    audience: "all",
    allowedHosts: "",
  };
  @state() private secretKindOverridden = false;
  @state() private bulkOpen = false;
  @state() private bulkRaw = "";
  @state() private bulkAutoDetect = true;
  @state() private formError: string | null = null;
  @state() private notice: string | null = null;

  private readonly gateway = new GatewayPageController(this, {
    getGateway: () => this.context?.gateway,
    invalidateRequests: (change) => this.resetGatewayState(change.snapshot),
    onSnapshot: (change) => {
      if (change.initial) {
        this.resetGatewayState(change.snapshot);
      }
      if (this.gateway.connected) {
        void this.context?.agents.ensureList();
      }
    },
    ensureInitialData: () => this.ensureInitialData(),
  });

  // Roster agents hydrate asynchronously; a subscription (not a one-shot
  // read) fills the dropdown as soon as agents.list resolves.
  constructor() {
    super();
    new SubscriptionsController(this).watch(
      () => this.context?.agents,
      (agents, notify) => agents.subscribe(notify),
      () => this.reconcileRosterAgentIds(),
    );
  }

  private reconcileRosterAgentIds() {
    const agents = this.context?.agents.state.agentsList?.agents ?? [];
    // Assignment targets are runtime secret principals: configured (non-system)
    // agents only, matching the repository's selectable-agent convention.
    const ids = agents
      .filter((agent) => agent.kind !== "system")
      .map((agent) => agent.id)
      .filter(Boolean)
      .toSorted();
    if (ids.join("\u0000") !== this.rosterAgentIds.join("\u0000")) {
      this.rosterAgentIds = ids;
    }
  }

  private resetGatewayState(snapshot?: ApplicationContext["gateway"]["snapshot"]) {
    this.store = createInitialSecretsStoreState({
      client: snapshot?.client ?? null,
      connected: snapshot?.phase === "connected",
    });
    this.assignments = createInitialAssignmentsAdminState({
      client: snapshot?.client ?? null,
      connected: snapshot?.phase === "connected",
    });
    this.enforcement = createInitialEnforcementState({
      client: snapshot?.client ?? null,
      connected: snapshot?.phase === "connected",
    });
    this.dialogMode = null;
    this.bulkOpen = false;
    this.formError = null;
    this.notice = null;
    this.assignmentNotice = null;
    this.enforcementNotice = null;
    this.enforcementErrorNotice = null;
    this.assignmentAgent = "";
    this.assignmentName = "";
  }

  private get canList(): boolean {
    return this.canCall("secrets.store.list");
  }

  private get canSet(): boolean {
    return this.canCall("secrets.store.set");
  }

  private get canDelete(): boolean {
    return this.canCall("secrets.store.delete");
  }

  private get canAdminAssignments(): boolean {
    return this.canCall("secrets.assignments.admin.list");
  }

  private get canAdminAssign(): boolean {
    return this.canCall("secrets.assignments.admin.assign");
  }

  private get canAdminUnassign(): boolean {
    return this.canCall("secrets.assignments.admin.unassign");
  }

  private get canAdminEnforcement(): boolean {
    return this.canCall("secrets.assignments.enforcement.get");
  }

  private get canAdminEnforcementSet(): boolean {
    return this.canCall("secrets.assignments.enforcement.set");
  }

  private canCall(
    method:
      | "secrets.store.list"
      | "secrets.store.set"
      | "secrets.store.delete"
      | "secrets.assignments.admin.list"
      | "secrets.assignments.admin.assign"
      | "secrets.assignments.admin.unassign"
      | "secrets.assignments.enforcement.get"
      | "secrets.assignments.enforcement.set",
  ) {
    return (
      isGatewayMethodAdvertised(this.gateway.snapshot ?? {}, method) === true &&
      canCallGatewayMethod(this.gateway.snapshot, method, "operator.admin")
    );
  }

  private ensureInitialData() {
    if (this.canList && !this.store.loaded && !this.store.loading) {
      void this.runStoreTask((store) => loadSecretsStore(store));
    }
    if (this.canAdminAssignments && !this.assignments.loaded && !this.assignments.loading) {
      void loadAllAssignmentsAdmin(this.assignments).then(() => this.assignmentsChanged());
    }
    if (this.canAdminEnforcement && !this.enforcement.loaded && !this.enforcement.busy) {
      void loadEnforcementMode(this.enforcement).then(() => this.enforcementChanged());
    }
  }

  private readonly assignmentsChanged = () => {
    this.assignments = { ...this.assignments };
    this.requestUpdate();
  };

  private readonly enforcementChanged = () => {
    this.enforcement = { ...this.enforcement };
    this.requestUpdate();
  };

  private async submitAssign() {
    const agentId = this.assignmentAgent.trim();
    const name = this.assignmentName.trim().toUpperCase();
    if (!agentId || !ENV_SECRET_REF_ID_RE.test(name) || !this.canAdminAssign) {
      return;
    }
    this.assignmentNotice = null;
    const ok = await assignSecretName(this.assignments, agentId, name);
    this.assignmentsChanged();
    this.assignmentNotice = ok
      ? t("secretsAssignments.assigned", { name, agentId })
      : (this.assignments.error ?? t("secretsAssignments.failed"));
    if (ok) {
      this.assignmentName = "";
    }
  }

  private async submitUnassign(agentId: string, name: string) {
    if (!this.canAdminUnassign) {
      return;
    }
    const gateway = this.context.gateway;
    const client = this.assignments.client;
    if (
      !client ||
      !(await showConfirmDialog({
        title: t("common.delete"),
        message: t("secretsAssignments.confirmUnassign", { name, agentId }),
        confirmLabel: t("common.delete"),
        danger: true,
      }))
    ) {
      return;
    }
    if (this.context.gateway !== gateway || this.assignments.client !== client) {
      this.assignmentNotice = t("secretsAssignments.failed");
      return;
    }
    this.assignmentNotice = null;
    const ok = await unassignSecretName(this.assignments, agentId, name);
    this.assignmentsChanged();
    this.assignmentNotice = ok
      ? t("secretsAssignments.unassigned", { name, agentId })
      : (this.assignments.error ?? t("secretsAssignments.failed"));
  }

  private async applyEnforcement(mode: EnforcementMode) {
    if (!this.canAdminEnforcement || !this.canAdminEnforcementSet) {
      return;
    }
    if (this.enforcement.busy) {
      // A pending mutation must not be double-fired by another radio change.
      return;
    }
    // Capture the live gateway/client pair so a completed confirm on a
    // replaced or disconnected client cannot still call `set` (same guard
    // pattern as unassign).
    const gateway = this.context.gateway;
    const client = this.enforcement.client;
    // Warn before the fail-closed flip: agents without valid identities or
    // assignments lose all store entries the moment `enforce` lands.
    if (mode === "enforce") {
      const confirmed = await showConfirmDialog({
        title: t("secretsAssignments.enforceTitle"),
        message: t("secretsAssignments.enforceWarning"),
        confirmLabel: t("secretsAssignments.enforceConfirm"),
        danger: true,
      });
      if (!confirmed) {
        // A cancelled confirm must not leave the rendered radio sitting on
        // the requested mode while state still holds the old value.
        this.enforcementChanged();
        return;
      }
    }
    if (this.context.gateway !== gateway || this.enforcement.client !== client) {
      this.enforcementChanged();
      this.enforcementNotice = null;
      this.enforcementErrorNotice = t("secretsAssignments.failed");
      return;
    }
    const confirmedMode = await setEnforcementMode(this.enforcement, mode);
    this.enforcementChanged();
    if (confirmedMode !== null) {
      // Success only after the backend confirmed the live runtime state.
      this.enforcementErrorNotice = null;
      this.enforcementNotice = t("secretsAssignments.enforcementSet", {
        mode: confirmedMode,
      });
    } else {
      // Failure: render the authoritative post-attempt mode (state.mode was
      // refreshed by the backend or the last get) and never a success callout.
      this.enforcementNotice = null;
      this.enforcementErrorNotice = this.enforcement.error ?? t("secretsAssignments.failed");
      // Re-read the authoritative mode so a delayed-but-successful backend
      // apply (or a superseding change) rerenders the real radio state
      // instead of the clicked value.
      void loadEnforcementMode(this.enforcement).then(() => this.enforcementChanged());
    }
  }

  private async runStoreTask<T>(task: (store: SecretsStoreState) => Promise<T>): Promise<T> {
    const store = this.store;
    try {
      const result = task(store);
      this.requestUpdate();
      return await result;
    } finally {
      if (this.store === store) {
        this.requestUpdate();
      }
    }
  }

  private refresh() {
    if (!this.canList) {
      return;
    }
    void this.runStoreTask((store) => loadSecretsStore(store));
  }

  private openAdd() {
    if (!this.canSet) {
      return;
    }
    this.notice = null;
    this.formError = null;
    this.secretKindOverridden = false;
    this.metadataOnlyEdit = false;
    this.draft = { name: "", value: "", kind: "env", audience: "all", allowedHosts: "" };
    this.dialogMode = "add";
  }

  /** Editing an existing entry without retyping its protected value. */
  private metadataOnlyEdit = false;

  private openEdit(entry: (typeof this.store.entries)[number]) {
    if (!this.canSet) {
      return;
    }
    this.notice = null;
    this.formError = null;
    this.secretKindOverridden = true;
    // Protected values are never disclosed back into the form; leaving the
    // field empty lets the operator change audience/allowed hosts without
    // re-entering the credential, preserving the stored value server-side.
    this.metadataOnlyEdit = entry.kind === "secret";
    this.draft = {
      name: entry.name,
      ...(entry.kind === "env" ? { value: entry.value } : {}),
      kind: entry.kind,
      audience: entry.audience ?? "all",
      allowedHosts: entry.kind === "secret" ? (entry.allowedHosts ?? []).join("\n") : "",
    };
    this.dialogMode = "edit";
  }

  private closeDialog() {
    if (!this.store.busy) {
      this.dialogMode = null;
      this.formError = null;
      this.metadataOnlyEdit = false;
    }
  }

  private patchDraft(patch: Partial<SecretsStoreDraft>) {
    this.draft = { ...this.draft, ...patch };
    this.formError = null;
  }

  private changeDraftName(name: string) {
    const normalized = name.toUpperCase();
    this.patchDraft({
      name: normalized,
      ...(!this.secretKindOverridden
        ? {
            kind: isSensitiveEnvName(normalized) ? ("secret" as const) : ("env" as const),
          }
        : {}),
    });
  }

  private validateValue(value: string, kind: SecretsStoreDraft["kind"]): string | null {
    if (kind === "secret" && value.length === 0) {
      return t("secretsStore.required");
    }
    if (new TextEncoder().encode(value).byteLength > MAX_VALUE_BYTES) {
      return t("secretsStore.tooLarge");
    }
    return null;
  }

  private validateDraft(): string | null {
    if (!ENV_SECRET_REF_ID_RE.test(this.draft.name)) {
      return t("secretsStore.badName");
    }
    if (this.metadataOnlyEdit && this.draft.value === undefined) {
      // Metadata-only: audience/allowed-hosts change preserves the stored value.
      return null;
    }
    return this.validateValue(this.draft.value ?? "", this.draft.kind);
  }

  private submitDraft() {
    if (!this.canSet || !this.dialogMode) {
      return;
    }
    const error = this.validateDraft();
    if (error) {
      this.formError = error;
      return;
    }
    const draft = { ...this.draft };
    void this.runStoreTask(async (store) => {
      const result = await setSecretsStoreEntry(store, draft);
      if (this.store !== store) {
        return;
      }
      if (!result) {
        this.formError = store.error;
        return;
      }
      this.dialogMode = null;
      this.formError = null;
      const saved = t(
        draft.audience === "selected"
          ? "secretsStore.audienceSaved"
          : draft.kind === "secret"
            ? "secretsStore.savedProtected"
            : "secretsStore.savedReadable",
        { name: draft.name, audience: t("secretsStore.audienceSelected") },
      );
      this.notice = result.warningCount
        ? `${saved} ${t("secretsStore.warnings", { count: String(result.warningCount) })}`
        : saved;
    });
  }

  private openBulk() {
    if (!this.canSet) {
      return;
    }
    this.notice = null;
    this.formError = null;
    this.bulkRaw = "";
    this.bulkAutoDetect = true;
    this.bulkOpen = true;
  }

  private closeBulk() {
    if (!this.store.busy) {
      this.bulkOpen = false;
      this.formError = null;
    }
  }

  private get bulkParsed() {
    return parseSecretsStoreBulkInput(this.bulkRaw, this.bulkAutoDetect);
  }

  private submitBulk() {
    if (!this.canSet || !this.bulkOpen) {
      return;
    }
    const parsed = this.bulkParsed;
    if (parsed.invalidNames.length > 0) {
      this.formError = `${t("secretsStore.badName")} ${parsed.invalidNames.join(", ")}`;
      return;
    }
    if (parsed.entries.length === 0) {
      this.formError = t("secretsStore.required");
      return;
    }
    for (const entry of parsed.entries) {
      const error = this.validateValue(entry.value, entry.kind);
      if (error) {
        this.formError = `${entry.name}: ${error}`;
        return;
      }
    }
    void this.runStoreTask(async (store) => {
      const result = await bulkSetSecretsStoreEntries(store, parsed.entries);
      if (this.store !== store) {
        return;
      }
      if (!result) {
        this.formError = store.error;
        return;
      }
      this.bulkOpen = false;
      this.formError = null;
      const saved = t("secretsStore.savedMany", {
        count: String(result.saved),
        protected: String(parsed.entries.filter((entry) => entry.kind === "secret").length),
        readable: String(parsed.entries.filter((entry) => entry.kind === "env").length),
      });
      this.notice = result.warningCount
        ? `${saved} ${t("secretsStore.warnings", { count: String(result.warningCount) })}`
        : saved;
    });
  }

  private async removeEntry(entry: (typeof this.store.entries)[number]) {
    // A confirmation belongs to the client that opened it. Same-client reconnects remain valid,
    // but a replacement client must never inherit this destructive action.
    const gateway = this.context.gateway;
    const client = this.store.client;
    if (
      !client ||
      !this.canDelete ||
      !(await showConfirmDialog({
        title: t("common.delete"),
        message: t("secretsStore.confirmDelete", { name: entry.name }),
        confirmLabel: t("common.delete"),
        danger: true,
      }))
    ) {
      return;
    }
    this.notice = null;
    if (this.context.gateway !== gateway || this.store.client !== client || !this.canDelete) {
      this.store.error = t("secretsStore.deleteFailed");
      this.requestUpdate();
      return;
    }
    await this.runStoreTask(async (store) => {
      const result = await deleteSecretsStoreEntry(store, entry.name);
      if (result && this.store === store) {
        this.notice = t("secretsStore.deleted", { name: entry.name });
      }
    });
  }

  override render() {
    const parsed = this.bulkParsed;
    const body = renderSecretsStore({
      entries: this.store.entries,
      loading: this.store.loading,
      busy: this.store.busy,
      error: this.store.error,
      notice: this.notice,
      canList: this.canList,
      canSet: this.canSet,
      canDelete: this.canDelete,
      dialogMode: this.dialogMode,
      draft: this.draft,
      formError: this.formError,
      bulkOpen: this.bulkOpen,
      bulkRaw: this.bulkRaw,
      bulkAutoDetect: this.bulkAutoDetect,
      bulkSecretCount: parsed.entries.filter((entry) => entry.kind === "secret").length,
      bulkEntryCount: parsed.entries.length,
      bulkInvalidNames: parsed.invalidNames,
      onRefresh: () => this.refresh(),
      onOpenAdd: () => this.openAdd(),
      onOpenEdit: (entry) => this.openEdit(entry),
      onCloseDialog: () => this.closeDialog(),
      onDraftNameChange: (name) => this.changeDraftName(name),
      onDraftValueChange: (value) => {
        // Typing a value during a metadata-only edit means full replacement.
        if (this.metadataOnlyEdit && value.length > 0) {
          this.metadataOnlyEdit = false;
        }
        this.patchDraft({ value });
      },
      onDraftAllowedHostsChange: (allowedHosts) => this.patchDraft({ allowedHosts }),
      onDraftKindChange: (kind) => {
        this.secretKindOverridden = true;
        this.patchDraft({ kind });
      },
      onDraftAudienceChange: (audience) => {
        this.patchDraft({ audience });
      },
      onSubmitDraft: () => this.submitDraft(),
      onOpenBulk: () => this.openBulk(),
      onCloseBulk: () => this.closeBulk(),
      onBulkRawChange: (raw) => {
        this.bulkRaw = raw;
        this.formError = null;
      },
      onBulkAutoDetectChange: (enabled) => {
        this.bulkAutoDetect = enabled;
        this.formError = null;
      },
      onSubmitBulk: () => this.submitBulk(),
      onDelete: (entry) => void this.removeEntry(entry),
      canAdminAssignments: this.canAdminAssignments,
      assignments: this.assignments.assignments,
      assignmentsNextCursor: this.assignments.nextCursor,
      assignmentsLoading: this.assignments.loading,
      assignmentsBusy: this.assignments.busy,
      assignmentsError: this.assignments.error,
      assignmentRosterAgentIds: this.rosterAgentIds,
      assignmentLegacyAgentIds: assignmentAgentIds(this.assignments.assignments),
      assignmentStoreNames: storeEntryNames(this.store.entries),
      assignmentAgent: this.assignmentAgent,
      assignmentName: this.assignmentName,
      assignmentNotice: this.assignmentNotice,
      enforcementMode: this.enforcement.mode,
      enforcementBusy: this.enforcement.busy,
      enforcementNotice: this.enforcementNotice,
      enforcementErrorNotice: this.enforcementErrorNotice,
      onAssignmentAgentChange: (agent) => {
        this.assignmentAgent = agent;
        this.assignmentNotice = null;
      },
      onAssignmentNameChange: (name) => {
        this.assignmentName = name;
        this.assignmentNotice = null;
      },
      onSubmitAssign: () => void this.submitAssign(),
      onUnassign: (agentId, name) => void this.submitUnassign(agentId, name),
      onLoadMoreAssignments: () => {
        if (this.assignments.nextCursor) {
          void loadAllAssignmentsAdmin(this.assignments, {
            cursor: this.assignments.nextCursor,
          }).then(() => this.assignmentsChanged());
        }
      },
      onEnforcementChange: (mode) => void this.applyEnforcement(mode),
    });
    return html`
      ${renderSettingsPageHeader({
        title: titleForRoute("secrets"),
        subtitle: t("secretsStore.hint"),
      })}
      ${renderSettingsWorkspace(body)}
    `;
  }
}

if (!customElements.get("openclaw-secrets-page")) {
  customElements.define("openclaw-secrets-page", SecretsPage);
}
