import type { AppAdvisorAction } from '../types';

type AutomationCreateWatcher = NonNullable<
  Extract<AppAdvisorAction, { type: 'automation.create' }>['watchers']
>[number];
type AutomationRunNowWatcher = NonNullable<
  Extract<AppAdvisorAction, { type: 'automation.run_now' }>['watchers']
>[number];

const createWatcher: AutomationCreateWatcher = {
  followUpInstruction: 'Report the created automation outcome.',
};
const runNowWatcher: AutomationRunNowWatcher = {
  followUpInstruction: 'Report the manual run outcome.',
};

const createWatcherWithPipelineStatuses: AutomationCreateWatcher = {
  // @ts-expect-error Automation watchers do not support pipeline terminal statuses.
  terminalStatuses: ['failure'],
};
const runNowWatcherWithPipelineStatuses: AutomationRunNowWatcher = {
  // @ts-expect-error Automation watchers do not support pipeline terminal statuses.
  terminalStatuses: ['failure'],
};

describe('automation inline watcher types', () => {
  it('accepts watcher metadata without pipeline-only status filters', () => {
    expect(createWatcher.followUpInstruction).toContain('created automation');
    expect(runNowWatcher.followUpInstruction).toContain('manual run');
    expect([
      createWatcherWithPipelineStatuses,
      runNowWatcherWithPipelineStatuses,
    ]).toHaveLength(2);
  });
});
