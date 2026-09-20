// Diagnostics export formatting for gateway exec approval follow-ups.
// Split from bash-tools.exec-host-gateway.ts to keep that module within budget.
import { isRecord } from "@openclaw/normalization-core/record-coerce";

export function formatOutcomeExitLabel(outcome: {
  exitCode: number | null;
  timedOut: boolean;
}): string {
  return outcome.timedOut ? "timeout" : `code ${outcome.exitCode ?? "?"}`;
}

function formatBytes(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return `${Math.max(0, Math.round(value))} bytes`;
}

function formatDiagnosticsContents(manifest: Record<string, unknown>): string[] {
  const contents = Array.isArray(manifest.contents) ? manifest.contents : [];
  if (contents.length === 0) {
    return [];
  }
  const lines = [`Contents (${contents.length} files):`];
  for (const entry of contents.slice(0, 12)) {
    if (!isRecord(entry)) {
      continue;
    }
    const path = typeof entry.path === "string" ? entry.path : "";
    if (!path) {
      continue;
    }
    const bytes = formatBytes(entry.bytes);
    lines.push(`- ${bytes ? `${path} (${bytes})` : path}`);
  }
  if (contents.length > 12) {
    lines.push(`- ... ${contents.length - 12} more`);
  }
  return lines;
}

function formatDiagnosticsPrivacy(manifest: Record<string, unknown>): string[] {
  const privacy = isRecord(manifest.privacy) ? manifest.privacy : null;
  if (!privacy) {
    return [];
  }
  const lines = ["Privacy:"];
  if (typeof privacy.payloadFree === "boolean") {
    lines.push(`- payload-free: ${privacy.payloadFree ? "yes" : "no"}`);
  }
  if (typeof privacy.rawLogsIncluded === "boolean") {
    lines.push(`- raw logs included: ${privacy.rawLogsIncluded ? "yes" : "no"}`);
  }
  const notes = Array.isArray(privacy.notes)
    ? privacy.notes.filter((note): note is string => typeof note === "string")
    : [];
  for (const note of notes.slice(0, 4)) {
    lines.push(`- ${note}`);
  }
  return lines.length > 1 ? lines : [];
}

export function formatDiagnosticsExportSuccess(aggregated: string): string {
  const trimmed = aggregated.trim();
  if (!trimmed) {
    return "Diagnostics export completed, but no JSON output was returned.";
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!isRecord(parsed)) {
      return trimmed;
    }
    const manifest = isRecord(parsed.manifest) ? parsed.manifest : {};
    const lines = ["Diagnostics export created.", "", "Local Gateway bundle:"];
    const bundlePath = typeof parsed.path === "string" ? parsed.path : "";
    if (bundlePath) {
      lines.push(`Path: ${bundlePath}`);
    }
    const bytes = formatBytes(parsed.bytes);
    if (bytes) {
      lines.push(`Size: ${bytes}`);
    }
    if (typeof manifest.generatedAt === "string") {
      lines.push(`Generated at: ${manifest.generatedAt}`);
    }
    if (typeof manifest.openclawVersion === "string") {
      lines.push(`OpenClaw version: ${manifest.openclawVersion}`);
    }
    const contents = formatDiagnosticsContents(manifest);
    if (contents.length > 0) {
      lines.push("", ...contents);
    }
    const privacy = formatDiagnosticsPrivacy(manifest);
    if (privacy.length > 0) {
      lines.push("", ...privacy);
    }
    return lines.join("\n");
  } catch {
    return trimmed;
  }
}
