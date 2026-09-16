import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SecretStoreEntry } from "../../../../packages/gateway-protocol/src/index.js";
import { renderSecretsStore } from "./view.ts";

type SecretsStoreViewProps = Parameters<typeof renderSecretsStore>[0];

const containers: HTMLElement[] = [];

afterEach(() => {
  for (const container of containers.splice(0)) {
    render(null, container);
    container.remove();
  }
});

function mount(
  entries: SecretStoreEntry[],
  overrides: Partial<SecretsStoreViewProps> = {},
): HTMLElement {
  const container = document.createElement("div");
  containers.push(container);
  document.body.append(container);
  const noop = vi.fn();
  const props: SecretsStoreViewProps = {
    entries,
    loading: false,
    busy: false,
    error: null,
    notice: null,
    canList: true,
    canSet: true,
    canDelete: true,
    dialogMode: null,
    draft: { name: "", value: "", kind: "env", audience: "all", allowedHosts: "" },
    formError: null,
    bulkOpen: false,
    bulkRaw: "",
    bulkAutoDetect: true,
    bulkSecretCount: 0,
    bulkEntryCount: 0,
    bulkInvalidNames: [],
    onRefresh: noop,
    onOpenAdd: noop,
    onOpenEdit: noop,
    onCloseDialog: noop,
    onDraftNameChange: noop,
    onDraftValueChange: noop,
    onDraftAllowedHostsChange: noop,
    onDraftKindChange: noop,
    onSubmitDraft: noop,
    onOpenBulk: noop,
    onCloseBulk: noop,
    onBulkRawChange: noop,
    onBulkAutoDetectChange: noop,
    onSubmitBulk: noop,
    onDelete: noop,
    canAdminAssignments: true,
    assignments: [],
    assignmentsNextCursor: null,
    assignmentsLoading: false,
    assignmentsBusy: false,
    assignmentsError: null,
    assignmentRosterAgentIds: [],
    assignmentLegacyAgentIds: [],
    assignmentStoreNames: [],
    assignmentAgent: "",
    assignmentName: "",
    assignmentNotice: null,
    enforcementMode: "off",
    enforcementBusy: false,
    enforcementNotice: null,
    enforcementErrorNotice: null,
    onAssignmentAgentChange: noop,
    onAssignmentNameChange: noop,
    onSubmitAssign: noop,
    onUnassign: noop,
    onLoadMoreAssignments: noop,
    onEnforcementChange: noop,
  };
  render(renderSecretsStore({ ...props, ...overrides }), container);
  return container;
}

describe("secrets store view", () => {
  it("never renders a secret value even when hostile input carries one", () => {
    const secret = {
      name: "SERVICE_API_KEY",
      kind: "secret",
      value: "must-never-render",
      scopeKind: "team",
      scopeId: "",
      createdAtMs: 1,
      updatedAtMs: 2,
      updatedBy: "Operator",
      allowedHosts: ["api.example.com"],
    } as unknown as SecretStoreEntry;
    const env: SecretStoreEntry = {
      name: "SERVICE_URL",
      kind: "env",
      value: "https://service.test",
      scopeKind: "team",
      scopeId: "",
      createdAtMs: 1,
      updatedAtMs: 2,
      updatedBy: "Operator",
    };
    const container = mount([secret, env]);

    expect(container.innerHTML).not.toContain("must-never-render");
    expect(container.textContent).toContain("••••••••");
    expect(container.textContent).toContain("https://service.test");
    expect(container.textContent).toContain("api.example.com");
    expect(container.textContent).toContain("Protected secret");
    expect(container.textContent).toContain("Agent-readable environment");
  });

  it("shows the allowed-host field for secret add and edit dialogs", () => {
    const container = mount([], {
      dialogMode: "edit",
      draft: {
        name: "SERVICE_API_KEY",
        value: "replacement",
        kind: "secret",
        allowedHosts: "api.example.com",
      },
    });

    const field = container.querySelector<HTMLTextAreaElement>('textarea[name="allowed-hosts"]');
    expect(field?.value).toBe("api.example.com");
    expect(container.textContent).toContain("Exact hostnames only");
  });

  it("hides mutation controls when the gateway does not advertise them", () => {
    const container = mount([], {
      canSet: false,
      canDelete: false,
      canAdminAssignments: false,
    });

    expect(container.querySelector("button")).toBeNull();
    expect(container.textContent).toContain("Secrets");
  });

  it("renders the agent field as a select with a default option and roster agents", () => {
    const container = mount([], {
      assignmentRosterAgentIds: ["alpha", "beta"],
      assignmentLegacyAgentIds: ["legacy-agent"],
    });

    const select = container.querySelector<HTMLSelectElement>("select");
    expect(select).not.toBeNull();
    const options = [...(select?.options ?? [])];
    // Default option first, then every configured roster agent.
    expect(options.map((option) => option.value)).toEqual(["", "alpha", "beta", "legacy-agent"]);
    expect(options[0]?.textContent).toContain("Select an agent");
    // The legacy agent input+datalist is gone; the secret-name picker stays.
    expect(container.querySelector("datalist#secrets-assignment-agents")).toBeNull();
    expect(container.querySelector('input[list="secrets-assignment-names"]')).not.toBeNull();
  });

  it("keeps legacy agent ids visible after a roster agent is selected", () => {
    const container = mount([], {
      assignmentRosterAgentIds: ["alpha", "beta"],
      assignmentLegacyAgentIds: ["legacy-agent"],
    });

    const select = container.querySelector<HTMLSelectElement>("select");
    expect(select).not.toBeNull();
    select!.value = "alpha";
    select!.dispatchEvent(new Event("change"));

    const options = [...(select?.options ?? [])];
    // All configured agents remain listed after selection.
    expect(options.map((option) => option.value)).toEqual(["", "alpha", "beta", "legacy-agent"]);
    expect(
      options.filter((option) => option.value !== "").map((option) => option.textContent?.trim()),
    ).toEqual(["alpha", "beta", "legacy-agent"]);
  });

  it("fires the change handler with the selected agent id", () => {
    const onAssignmentAgentChange = vi.fn();
    const container = mount([], {
      assignmentRosterAgentIds: ["alpha", "beta"],
      onAssignmentAgentChange,
    });

    const select = container.querySelector<HTMLSelectElement>("select");
    select!.value = "beta";
    select!.dispatchEvent(new Event("change"));

    expect(onAssignmentAgentChange).toHaveBeenCalledWith("beta");
  });

  it("disables the agent select while assignments are busy", () => {
    const container = mount([], { assignmentsBusy: true });

    const select = container.querySelector<HTMLSelectElement>("select");
    expect(select?.disabled).toBe(true);
  });

  it("marks the selected roster agent as selected", () => {
    const container = mount([], {
      assignmentRosterAgentIds: ["alpha", "beta"],
      assignmentAgent: "beta",
    });

    const select = container.querySelector<HTMLSelectElement>("select");
    expect(select?.value).toBe("beta");
  });
});
