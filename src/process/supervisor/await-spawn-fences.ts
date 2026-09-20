type SpawnFence = (() => Promise<void> | void) | undefined;

export async function awaitSpawnFences(params: {
  assertCurrent?: SpawnFence;
  beforeSpawn?: SpawnFence;
  recheckAfterAdmission?: boolean;
}): Promise<void> {
  const current = params.assertCurrent?.();
  if (current) {
    await current;
  }
  const admission = params.beforeSpawn?.();
  if (admission) {
    await admission;
  }
  if (params.recheckAfterAdmission) {
    const postAdmission = params.assertCurrent?.();
    if (postAdmission) {
      await postAdmission;
    }
  }
}
