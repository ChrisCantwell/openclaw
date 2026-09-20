// Windows argv/launch resolution for the child process adapter.
import {
  resolveWindowsExecutablePath,
  resolveWindowsSpawnProgramCandidate,
} from "../../../plugin-sdk/windows-spawn.js";
import {
  buildWindowsCmdExeCommandLine,
  isWindowsBatchCommand,
  resolveTrustedWindowsCmdExe,
  resolveWindowsCommandShim,
} from "../../windows-command.js";

const WINDOWS_PACKAGE_MANAGER_SHIMS = ["npm", "pnpm", "yarn", "npx"] as const;

export function resolveChildInvocation(params: {
  argv: string[];
  env?: NodeJS.ProcessEnv;
  windowsVerbatimArguments?: boolean;
}): {
  args: string[];
  command: string;
  windowsVerbatimArguments?: boolean;
} {
  const command = params.argv[0] ?? "";
  const candidate = resolveWindowsSpawnProgramCandidate({
    command,
    env: params.env,
    // npm shims invoke `node` from PATH; process.execPath may be a packaged OpenClaw executable.
    execPath:
      process.platform === "win32"
        ? resolveWindowsExecutablePath("node", params.env ?? process.env)
        : undefined,
  });
  const args = [...candidate.leadingArgv, ...params.argv.slice(1)];
  // Keep the historical package-manager fallback when PATH probing cannot see
  // its shim; every resolved wrapper takes the direct Node/exe path above.
  const resolvedCommand =
    candidate.resolution === "direct" && candidate.command === command
      ? resolveWindowsCommandShim({
          command,
          cmdCommands: WINDOWS_PACKAGE_MANAGER_SHIMS,
        })
      : candidate.command;
  if (!isWindowsBatchCommand(resolvedCommand)) {
    return {
      command: resolvedCommand,
      args,
      windowsVerbatimArguments: params.windowsVerbatimArguments,
    };
  }
  return {
    command: resolveTrustedWindowsCmdExe(),
    args: ["/d", "/s", "/c", buildWindowsCmdExeCommandLine(resolvedCommand, args)],
    windowsVerbatimArguments: true,
  };
}
