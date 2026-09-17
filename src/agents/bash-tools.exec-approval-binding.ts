import {
  revalidateSystemRunMutableFileBinding,
  type SystemRunMutableFileBinding,
} from "../infra/system-run-approval-binding.js";
import {
  APPROVAL_CWD_DRIFT_DENIED_MESSAGE,
  type ApprovedCwdSnapshot,
  revalidateApprovedCwdSnapshot,
} from "../infra/system-run-cwd-binding.js";

/** Rechecks a gateway approval binding before an approved execution starts. */
export async function resolveGatewayExecApprovalDrift(params: {
  binding?: SystemRunMutableFileBinding;
  cwdSnapshot?: ApprovedCwdSnapshot;
  cwd: string;
}): Promise<string | undefined> {
  if (params.binding) {
    const current = await revalidateSystemRunMutableFileBinding({
      binding: params.binding,
      cwd: params.cwd,
    });
    if (!current.ok) return current.message;
  }
  return params.cwdSnapshot && !revalidateApprovedCwdSnapshot(params.cwdSnapshot)
    ? APPROVAL_CWD_DRIFT_DENIED_MESSAGE
    : undefined;
}
