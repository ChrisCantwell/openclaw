export function resolveGatewayGitHubProfileDir(params: {
  host: string;
  preparedRunEnvironment: {
    managedLocalIdentity: boolean;
    localIdentityEnv: { GH_CONFIG_DIR?: string };
  };
}): string | undefined {
  return params.host === "gateway" && params.preparedRunEnvironment.managedLocalIdentity
    ? params.preparedRunEnvironment.localIdentityEnv.GH_CONFIG_DIR
    : undefined;
}

/** Fatal local-launch prerequisite kept out of the exec orchestrator. */
export function assertLocalExecWorkdir(workdir: string | undefined): asserts workdir is string {
  if (!workdir) {
    throw new Error("exec internal error: local execution requires a resolved workdir");
  }
}
