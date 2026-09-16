import { html, nothing, type TemplateResult } from "lit";
import { repeat } from "lit/directives/repeat.js";
import type { SecretStoreEntry } from "../../../../packages/gateway-protocol/src/index.js";
import { icon } from "../../components/icons.ts";
import "../../components/modal-dialog.ts";
import {
  renderDocsLink,
  renderSettingsEmpty,
  renderSettingsLoadingSkeleton,
  renderSettingsPage,
  renderSettingsSection,
} from "../../components/settings-ui.ts";
import "../../components/web-awesome.ts";
import { i18n, t } from "../../i18n/index.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import type { SecretsStoreDraft } from "../../lib/secrets-store/index.ts";
import "../../styles/secrets-store.css";

export type SecretsDialogMode = "add" | "edit" | null;

type SecretsStoreViewProps = {
  entries: SecretStoreEntry[];
  loading: boolean;
  busy: boolean;
  error: string | null;
  notice: string | null;
  canList: boolean;
  canSet: boolean;
  canDelete: boolean;
  dialogMode: SecretsDialogMode;
  draft: SecretsStoreDraft;
  formError: string | null;
  bulkOpen: boolean;
  bulkRaw: string;
  bulkAutoDetect: boolean;
  bulkSecretCount: number;
  bulkEntryCount: number;
  bulkInvalidNames: readonly string[];
  onRefresh: () => void;
  onOpenAdd: () => void;
  onOpenEdit: (entry: SecretStoreEntry) => void;
  onCloseDialog: () => void;
  onDraftNameChange: (name: string) => void;
  onDraftValueChange: (value: string) => void;
  onDraftAllowedHostsChange: (allowedHosts: string) => void;
  onDraftKindChange: (kind: "secret" | "env") => void;
  onDraftAudienceChange: (audience: "all" | "selected") => void;
  onSubmitDraft: () => void;
  onOpenBulk: () => void;
  onCloseBulk: () => void;
  onBulkRawChange: (raw: string) => void;
  onBulkAutoDetectChange: (enabled: boolean) => void;
  onSubmitBulk: () => void;
  onDelete: (entry: SecretStoreEntry) => void;
  canAdminAssignments: boolean;
  assignments: Array<{ agentId: string; names: string[] }>;
  assignmentsNextCursor: string | null;
  assignmentsLoading: boolean;
  assignmentsBusy: boolean;
  assignmentsError: string | null;
  /** Configured agents from the roster; the dropdown lists these first. */
  assignmentRosterAgentIds: string[];
  /**
   * Legacy/deleted agent ids still present in assignment groups; merged after
   * the roster so existing assignments remain selectable and operable.
   */
  assignmentLegacyAgentIds: string[];
  assignmentStoreNames: string[];
  assignmentAgent: string;
  assignmentName: string;
  assignmentNotice: string | null;
  enforcementMode: "off" | "advisory" | "enforce";
  enforcementBusy: boolean;
  enforcementNotice: string | null;
  enforcementErrorNotice: string | null;
  onAssignmentAgentChange: (agent: string) => void;
  onAssignmentNameChange: (name: string) => void;
  onSubmitAssign: () => void;
  onUnassign: (agentId: string, name: string) => void;
  onLoadMoreAssignments: () => void;
  onEnforcementChange: (mode: "off" | "advisory" | "enforce") => void;
};

const DOCS_URL = "https://docs.openclaw.ai/gateway/secrets#shared-secret-store";
const SECRET_MASK = "••••••••";

function updatedLabel(entry: SecretStoreEntry): string {
  const relative = formatRelativeTimestamp(entry.updatedAtMs, {
    fallback: t("common.unknown"),
  });
  return entry.updatedBy
    ? t("secretsStore.by", { time: relative, name: entry.updatedBy })
    : relative;
}

/** Operator-admin agent-assignment and enforcement panel; never model-visible. */
function renderAssignments(props: SecretsStoreViewProps): TemplateResult | typeof nothing {
  if (!props.canAdminAssignments) {
    return nothing;
  }
  return html`
    ${renderSettingsSection(
      { title: t("secretsAssignments.title") },
      html`
        <p class="secrets-store__hint">${t("secretsAssignments.hint")}</p>
        ${
          props.assignmentsError
            ? html`<div class="callout danger" role="alert">${props.assignmentsError}</div>`
            : nothing
        }
        ${
          props.enforcementErrorNotice
            ? html`<div class="callout danger" role="alert">${props.enforcementErrorNotice}</div>`
            : nothing
        }
        ${
          props.enforcementNotice
            ? html`<div
                class="callout success secrets-store__message"
                role="status"
                aria-live="polite"
              >
                ${props.enforcementNotice}
              </div>`
            : nothing
        }
        ${
          props.assignmentNotice
            ? html`<div
                class="callout success secrets-store__message"
                role="status"
                aria-live="polite"
              >
                ${props.assignmentNotice}
              </div>`
            : nothing
        }
        <div class="secrets-store-assignments">
          <div class="secrets-store-assignments__controls">
            <label class="secrets-store-field">
              <span>${t("secretsAssignments.agent")}</span>
              <select
                class="settings-input mono"
                ?disabled=${props.assignmentsBusy}
                .value=${props.assignmentAgent}
                @change=${(event: Event) =>
                  props.onAssignmentAgentChange((event.currentTarget as HTMLSelectElement).value)}
              >
                <option value="" ?selected=${props.assignmentAgent === ""}>
                  ${t("secretsAssignments.agentDefaultOption")}
                </option>
                ${props.assignmentRosterAgentIds.map(
                  (agentId) =>
                    html`<option value=${agentId} ?selected=${props.assignmentAgent === agentId}>
                      ${agentId}
                    </option>`,
                )}
                ${props.assignmentLegacyAgentIds
                  .filter((agentId) => !props.assignmentRosterAgentIds.includes(agentId))
                  .map(
                    (agentId) =>
                      html`<option value=${agentId} ?selected=${props.assignmentAgent === agentId}>
                        ${agentId}
                      </option>`,
                  )}
              </select>
            </label>
            <label class="secrets-store-field">
              <span>${t("secretsAssignments.secretName")}</span>
              <input
                class="settings-input mono"
                list="secrets-assignment-names"
                autocomplete="off"
                spellcheck="false"
                placeholder=${t("secretsAssignments.secretNamePlaceholder")}
                ?disabled=${props.assignmentsBusy}
                .value=${props.assignmentName}
                @input=${(event: Event) =>
                  props.onAssignmentNameChange((event.currentTarget as HTMLInputElement).value)}
              />
              <datalist id="secrets-assignment-names">
                ${props.assignmentStoreNames.map((name) => html`<option value=${name}></option>`)}
              </datalist>
            </label>
            <button
              class="btn btn--sm primary"
              type="button"
              ?disabled=${props.assignmentsBusy || !props.assignmentAgent.trim() || !props.assignmentName.trim()}
              @click=${props.onSubmitAssign}
            >
              ${t("secretsAssignments.assign")}
            </button>
          </div>
          ${
            props.assignments.length
              ? html`
                  <table class="secrets-store__table settings-table--stacked" role="table">
                    <tbody>
                      ${props.assignments.map((group) =>
                        group.names.map(
                          (name) => html`
                            <tr tabindex="0" aria-label=${`${name} → ${group.agentId}`}>
                              <td data-label=${t("secretsAssignments.agent")}>
                                <code class="secrets-store__name">${group.agentId}</code>
                              </td>
                              <td data-label=${t("secretsAssignments.secretName")}>
                                <code class="secrets-store__name">${name}</code>
                              </td>
                              <td data-label=${t("secretsStore.actions")}>
                                <button
                                  class="btn btn--sm"
                                  type="button"
                                  ?disabled=${props.assignmentsBusy}
                                  @click=${() => props.onUnassign(group.agentId, name)}
                                >
                                  ${t("secretsAssignments.unassign")}
                                </button>
                              </td>
                            </tr>
                          `,
                        ),
                      )}
                    </tbody>
                  </table>
                `
              : html`<p>${t("secretsAssignments.none")}</p>`
          }
          ${
            props.assignmentsNextCursor
              ? html`
                  <button
                    class="btn btn--sm"
                    type="button"
                    ?disabled=${props.assignmentsLoading || props.assignmentsBusy}
                    @click=${props.onLoadMoreAssignments}
                  >
                    ${t("secretsAssignments.loadMore")}
                  </button>
                `
              : nothing
          }
          <fieldset class="secrets-store-modes">
            <legend>${t("secretsAssignments.enforcementTitle")}</legend>
            <small>${t("secretsAssignments.enforcementHint")}</small>
            ${(["off", "advisory", "enforce"] as const).map(
              (mode) => html`
                <label
                  class="secrets-store-mode ${
                    props.enforcementMode === mode ? "secrets-store-mode--selected" : ""
                  }"
                >
                  <input
                    type="radio"
                    name="assignment-enforcement"
                    value=${mode}
                    .checked=${props.enforcementMode === mode}
                    ?disabled=${props.enforcementBusy || props.enforcementMode === mode}
                    @change=${() => props.onEnforcementChange(mode)}
                  />
                  <span>
                    <strong>${t(`secretsAssignments.mode.${mode}`)}</strong>
                    <small>${t(`secretsAssignments.modeHint.${mode}`)}</small>
                  </span>
                </label>
              `,
            )}
          </fieldset>
        </div>
      `,
    )}
  `;
}

function renderEntryMenu(props: SecretsStoreViewProps, entry: SecretStoreEntry): TemplateResult {
  if (!props.canSet && !props.canDelete) {
    return html``;
  }
  return html`
    <wa-dropdown
      class="secrets-store__menu"
      placement="bottom-end"
      @wa-select=${(event: CustomEvent<{ item: { value?: string } }>) => {
        if (event.detail.item.value === "edit" && props.canSet) {
          props.onOpenEdit(entry);
        } else if (event.detail.item.value === "delete" && props.canDelete) {
          props.onDelete(entry);
        }
      }}
    >
      <button
        slot="trigger"
        type="button"
        class="btn btn--sm btn--ghost secrets-store__menu-trigger"
        aria-label=${`${t("secretsStore.actions")}: ${entry.name}`}
        title=${t("secretsStore.actions")}
        ?disabled=${props.busy}
      >
        ${icon("moreHorizontal")}
      </button>
      ${
        props.canSet
          ? html`<wa-dropdown-item value="edit">${t("secretsStore.edit")}</wa-dropdown-item>`
          : nothing
      }
      ${
        props.canDelete
          ? html`<wa-dropdown-item value="delete" variant="danger"
              >${t("common.delete")}</wa-dropdown-item
            >`
          : nothing
      }
    </wa-dropdown>
  `;
}

function renderTable(props: SecretsStoreViewProps): TemplateResult {
  if (!props.canList) {
    return renderSettingsEmpty(t("secretsStore.unavail"));
  }
  if (props.loading && !props.entries.length) {
    return renderSettingsLoadingSkeleton();
  }
  if (!props.entries.length) {
    return html`
      <div class="secrets-store__empty">
        ${renderSettingsEmpty(t("tabs.secrets"))} ${renderDocsLink(DOCS_URL, t("common.docs"))}
      </div>
    `;
  }
  return html`
    <div class="secrets-store__table-wrap">
      <table class="secrets-store__table settings-table--stacked" role="table">
        <thead>
          <tr>
            <th scope="col">${t("secretsStore.name")}</th>
            <th scope="col">${t("secretsStore.access")}</th>
            <th scope="col">${t("secretsStore.value")}</th>
            <th scope="col">${t("secretsStore.allowedHosts")}</th>
            <th scope="col">${t("secretsStore.updated")}</th>
            <th scope="col" class="secrets-store__actions-heading">
              <span class="settings-control__sr-label">${t("secretsStore.actions")}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          ${repeat(
            props.entries,
            (entry) => entry.name,
            (entry) => html`
              <tr tabindex="0" aria-label=${entry.name}>
                <td data-label=${t("secretsStore.name")}>
                  <code class="secrets-store__name" title=${entry.name}>${entry.name}</code>
                </td>
                <td data-label=${t("secretsStore.access")}>
                  <span class="secrets-store__mode secrets-store__mode--${entry.kind}"
                    >${t(
                      entry.kind === "secret"
                        ? "secretsStore.protectedSecret"
                        : "secretsStore.agentReadable",
                    )}</span
                  >
                  <span class="secrets-store__mode secrets-store__mode--audience"
                    >${t(
                      (entry.audience ?? "all") === "selected"
                        ? "secretsStore.audienceSelected"
                        : "secretsStore.audienceAll",
                    )}</span
                  >
                </td>
                <td data-label=${t("secretsStore.value")}>
                  <span
                    class="secrets-store__value ${
                      entry.kind === "secret" ? "secrets-store__value--secret" : ""
                    }"
                    title=${entry.kind === "env" ? entry.value : nothing}
                    >${entry.kind === "env" ? entry.value : SECRET_MASK}</span
                  >
                </td>
                <td data-label=${t("secretsStore.allowedHosts")}>
                  <span class="secrets-store__hosts">
                    ${
                      entry.kind === "secret" && (entry.allowedHosts?.length ?? 0) > 0
                        ? entry.allowedHosts?.join(", ")
                        : t("secretsStore.noAllowedHosts")
                    }
                  </span>
                </td>
                <td data-label=${t("secretsStore.updated")}>
                  <time
                    class="secrets-store__updated"
                    datetime=${new Date(entry.updatedAtMs).toISOString()}
                    title=${new Intl.DateTimeFormat(i18n.getLocale(), {
                      dateStyle: "medium",
                      timeStyle: "short",
                    }).format(new Date(entry.updatedAtMs))}
                    >${updatedLabel(entry)}</time
                  >
                </td>
                <td class="secrets-store__actions-cell" data-label=${t("secretsStore.actions")}>
                  ${renderEntryMenu(props, entry)}
                </td>
              </tr>
            `,
          )}
        </tbody>
      </table>
    </div>
  `;
}

function renderEntryDialog(props: SecretsStoreViewProps): TemplateResult | typeof nothing {
  if (!props.dialogMode) {
    return nothing;
  }
  const editing = props.dialogMode === "edit";
  return html`
    <openclaw-modal-dialog
      label=${editing ? t("secretsStore.edit") : t("secretsStore.add")}
      description=${t("secretsStore.hint")}
      @modal-cancel=${props.onCloseDialog}
    >
      <form
        class="secrets-store-dialog"
        aria-busy=${props.busy ? "true" : "false"}
        @submit=${(event: SubmitEvent) => {
          event.preventDefault();
          props.onSubmitDraft();
        }}
      >
        <div class="secrets-store-dialog__header">
          <h2>${editing ? t("secretsStore.edit") : t("secretsStore.add")}</h2>
        </div>
        <label class="secrets-store-field">
          <span>${t("secretsStore.name")}</span>
          <input
            class="settings-input mono"
            name="name"
            autocomplete="off"
            spellcheck="false"
            autofocus
            ?readonly=${editing}
            ?disabled=${props.busy}
            .value=${props.draft.name}
            @input=${(event: Event) =>
              props.onDraftNameChange((event.currentTarget as HTMLInputElement).value)}
          />
        </label>
        <label class="secrets-store-field">
          <span>${t("secretsStore.value")}</span>
          <textarea
            class="settings-input secrets-store-dialog__value"
            name="value"
            autocomplete="off"
            spellcheck="false"
            ?disabled=${props.busy}
            placeholder=${editing ? t("secretsStore.valueMetadataOnly") : ""}
            .value=${props.draft.value ?? ""}
            @input=${(event: Event) =>
              props.onDraftValueChange((event.currentTarget as HTMLTextAreaElement).value)}
          ></textarea>
        </label>
        <fieldset class="secrets-store-modes">
          <legend>${t("secretsStore.accessMode")}</legend>
          <label
            class="secrets-store-mode ${
              props.draft.kind === "secret" ? "secrets-store-mode--selected" : ""
            }"
          >
            <input
              type="radio"
              name="access-mode"
              value="secret"
              .checked=${props.draft.kind === "secret"}
              ?disabled=${props.busy}
              @change=${() => props.onDraftKindChange("secret")}
            />
            <span>
              <strong>${t("secretsStore.protectedSecret")}</strong>
              <small>${t("secretsStore.protectedSecretHint")}</small>
            </span>
          </label>
          <label
            class="secrets-store-mode ${
              props.draft.kind === "env"
                ? "secrets-store-mode--selected secrets-store-mode--risk"
                : ""
            }"
          >
            <input
              type="radio"
              name="access-mode"
              value="env"
              .checked=${props.draft.kind === "env"}
              ?disabled=${props.busy}
              @change=${() => props.onDraftKindChange("env")}
            />
            <span>
              <strong>${t("secretsStore.agentReadable")}</strong>
              <small>${t("secretsStore.agentReadableHint")}</small>
            </span>
          </label>
        </fieldset>
        <fieldset class="secrets-store-modes">
          <legend>${t("secretsStore.agentAccess")}</legend>
          <label
            class="secrets-store-mode ${
              props.draft.audience === "all" ? "secrets-store-mode--selected" : ""
            }"
          >
            <input
              type="radio"
              name="agent-access"
              value="all"
              .checked=${props.draft.audience === "all"}
              ?disabled=${props.busy}
              @change=${() => props.onDraftAudienceChange("all")}
            />
            <span>
              <strong>${t("secretsStore.audienceAll")}</strong>
              <small>${t("secretsStore.audienceHint")}</small>
            </span>
          </label>
          <label
            class="secrets-store-mode ${
              props.draft.audience === "selected" ? "secrets-store-mode--selected" : ""
            }"
          >
            <input
              type="radio"
              name="agent-access"
              value="selected"
              .checked=${props.draft.audience === "selected"}
              ?disabled=${props.busy}
              @change=${() => props.onDraftAudienceChange("selected")}
            />
            <span>
              <strong>${t("secretsStore.audienceSelected")}</strong>
              <small>${t("secretsStore.selectedAgentsHint")}</small>
            </span>
          </label>
        </fieldset>
        ${
          props.draft.kind === "secret"
            ? html`
                <label class="secrets-store-field">
                  <span>${t("secretsStore.allowedHosts")}</span>
                  <textarea
                    class="settings-input secrets-store-dialog__hosts mono"
                    name="allowed-hosts"
                    autocomplete="off"
                    spellcheck="false"
                    placeholder=${t("secretsStore.allowedHostsPlaceholder")}
                    ?disabled=${props.busy}
                    .value=${props.draft.allowedHosts}
                    @input=${(event: Event) =>
                      props.onDraftAllowedHostsChange(
                        (event.currentTarget as HTMLTextAreaElement).value,
                      )}
                  ></textarea>
                  <small>${t("secretsStore.allowedHostsHint")}</small>
                </label>
              `
            : nothing
        }
        ${
          props.formError
            ? html`<div class="callout danger" role="alert">${props.formError}</div>`
            : nothing
        }
        <div class="secrets-store-dialog__actions">
          <button class="btn primary" type="submit" ?disabled=${props.busy}>
            ${props.busy ? t("common.saving") : t("common.save")}
          </button>
          <button class="btn" type="button" ?disabled=${props.busy} @click=${props.onCloseDialog}>
            ${t("common.cancel")}
          </button>
        </div>
      </form>
    </openclaw-modal-dialog>
  `;
}

function renderBulkDialog(props: SecretsStoreViewProps): TemplateResult | typeof nothing {
  if (!props.bulkOpen) {
    return nothing;
  }
  return html`
    <openclaw-modal-dialog label=${t("secretsStore.bulk")} @modal-cancel=${props.onCloseBulk}>
      <form
        class="secrets-store-dialog"
        aria-busy=${props.busy ? "true" : "false"}
        @submit=${(event: SubmitEvent) => {
          event.preventDefault();
          props.onSubmitBulk();
        }}
      >
        <div class="secrets-store-dialog__header">
          <h2>${t("secretsStore.bulk")}</h2>
        </div>
        <label class="secrets-store-field">
          <span>${t("secretsStore.value")}</span>
          <textarea
            class="settings-input secrets-store-dialog__bulk"
            name="bulk-values"
            autocomplete="off"
            spellcheck="false"
            autofocus
            ?disabled=${props.busy}
            .value=${props.bulkRaw}
            @input=${(event: Event) =>
              props.onBulkRawChange((event.currentTarget as HTMLTextAreaElement).value)}
          ></textarea>
        </label>
        <div class="secrets-store-bulk__summary" aria-live="polite">
          ${t(props.bulkSecretCount === 1 ? "secretsStore.detectedOne" : "secretsStore.detected", {
            count: String(props.bulkSecretCount),
          })}
        </div>
        <label class="secrets-store-checkbox">
          <input
            type="checkbox"
            .checked=${props.bulkAutoDetect}
            ?disabled=${props.busy}
            @change=${(event: Event) =>
              props.onBulkAutoDetectChange((event.currentTarget as HTMLInputElement).checked)}
          />
          <span>
            <strong>${t("secretsStore.detect")}</strong>
          </span>
        </label>
        ${
          props.bulkInvalidNames.length
            ? html`<div class="callout danger" role="alert">
                ${t("secretsStore.badName")} ${props.bulkInvalidNames.join(", ")}
              </div>`
            : nothing
        }
        ${
          props.formError
            ? html`<div class="callout danger" role="alert">${props.formError}</div>`
            : nothing
        }
        <div class="secrets-store-dialog__actions">
          <button
            class="btn primary"
            type="submit"
            ?disabled=${props.busy || !props.bulkEntryCount || props.bulkInvalidNames.length > 0}
          >
            ${props.busy ? t("common.saving") : t("common.save")}
          </button>
          <button class="btn" type="button" ?disabled=${props.busy} @click=${props.onCloseBulk}>
            ${t("common.cancel")}
          </button>
        </div>
      </form>
    </openclaw-modal-dialog>
  `;
}

export function renderSecretsStore(props: SecretsStoreViewProps): TemplateResult {
  const actions = props.canSet
    ? html`
        <button
          class="btn btn--sm"
          type="button"
          ?disabled=${props.busy}
          @click=${props.onOpenBulk}
        >
          ${t("secretsStore.bulk")}
        </button>
        <button
          class="btn btn--sm primary"
          type="button"
          ?disabled=${props.busy}
          @click=${props.onOpenAdd}
        >
          ${icon("plus")} ${t("secretsStore.add")}
        </button>
      `
    : undefined;
  return html`
    ${renderSettingsPage(
      html`
        ${
          props.error
            ? html`<div class="callout danger secrets-store__message" role="alert">
                <span>${props.error}</span>
                ${
                  props.canList
                    ? html`<button class="btn btn--sm" type="button" @click=${props.onRefresh}>
                        ${t("common.retry")}
                      </button>`
                    : nothing
                }
              </div>`
            : nothing
        }
        ${
          props.notice
            ? html`<div
                class="callout success secrets-store__message"
                role="status"
                aria-live="polite"
              >
                ${props.notice}
              </div>`
            : nothing
        }
        ${renderSettingsSection(
          {
            title: t("tabs.secrets"),
            actions,
            count: props.entries.length,
          },
          renderTable(props),
        )}
        ${renderAssignments(props)}
      `,
      { wide: true },
    )}
    ${renderEntryDialog(props)} ${renderBulkDialog(props)}
  `;
}
