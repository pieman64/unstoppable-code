import type { SharedPipelineSaveImpact } from '@canopy/desktop-shared/types/pipeline';

export async function getSharedPipelineSaveImpact(
  remoteId: string,
): Promise<SharedPipelineSaveImpact> {
  const [{ getAutomationsService }, { getSharedAutomation }] =
    await Promise.all([
      import('../automations/service'),
      import('../automations/canopy-server-client'),
    ]);
  const candidates =
    await getAutomationsService().listActivitiesForSharedPipelineImpact();
  const automations: SharedPipelineSaveImpact['automations'] = [];
  const hiddenKinds = new Set<'shared' | 'installed'>();
  const addImpact = (
    candidate: (typeof candidates)[number],
    kind: 'shared' | 'installed',
  ): void => {
    if (candidate.visibleInCurrentContext) {
      automations.push({
        id: candidate.activity.id,
        name: candidate.activity.name,
        kind,
      });
      return;
    }
    if (hiddenKinds.has(kind)) return;
    hiddenKinds.add(kind);
    automations.push({
      id: `hidden-${kind}`,
      name: 'Another automation',
      kind,
    });
  };

  for (const candidate of candidates) {
    const { activity } = candidate;
    const action = activity.action;
    if (
      action.type === 'worktree_pipeline' &&
      action.pipelineSource === 'shared' &&
      action.sharedPipeline?.remoteId === remoteId &&
      action.sharedPipeline.installPin
    ) {
      addImpact(candidate, 'installed');
    }
  }

  await Promise.all(
    candidates.map(async (candidate) => {
      const { activity } = candidate;
      if (!activity.remote) return;
      try {
        const detail = await getSharedAutomation(activity.remote.remoteId);
        const action = detail.automation.action;
        if (
          action.type !== 'worktree_pipeline' ||
          action.pipeline.source !== 'shared' ||
          action.pipeline.remoteId !== remoteId
        ) {
          return;
        }
      } catch {
        // A failed lookup cannot prove the shared automation is unaffected.
        // Fail toward warning so publisher edits do not skip consent UX.
      }
      addImpact(candidate, 'shared');
    }),
  );

  return { automations };
}
