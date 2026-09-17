import { html, nothing, type TemplateResult } from "lit";
import { renderSettingsSection } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import type { SecretsStoreViewProps } from "./view.ts";

/** Operator-admin agent-assignment and enforcement panel; never model-visible. */
export function renderAssignments(props: SecretsStoreViewProps): TemplateResult | typeof nothing {
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
