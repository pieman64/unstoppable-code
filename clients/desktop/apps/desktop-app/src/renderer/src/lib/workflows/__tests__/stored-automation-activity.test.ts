import type {
  AutomationAction,
  ScheduledActivity,
} from '@canopy/desktop-shared/types';
import { storedAutomationActivity } from '../stored-automation-activity';

const chat: AutomationAction = {
  type: 'standalone_prompt',
  chatProjectId: 'cowork-1',
  prompt: 'Organize notes',
  planMode: true,
};
const stored: AutomationAction = {
  type: 'worktree_pipeline',
  target: { kind: 'global' },
  pipelineId: 'owned-1',
  pipelineSource: 'user',
  pipelineName: 'Notes',
  inputs: { project_id: 'cowork-1' },
};

function activity(overrides: Partial<ScheduledActivity>): ScheduledActivity {
  return {
    version: 1,
    id: 'a1',
    name: 'Notes',
    enabled: true,
    schedule: { kind: 'cron', expression: '0 9 * * *', timezone: 'local' },
    action: chat,
    createdAt: '2026-10-29T00:00:00.000Z',
    updatedAt: '2026-10-29T00:00:00.000Z',
    failureCount: 0,
    ...overrides,
  };
}

// CAN-4551: sharing publishes the workflow a converted automation runs.
describe('storedAutomationActivity', () => {
  it('restores the stored workflow action and drops the projection', () => {
    const shared = storedAutomationActivity(
      activity({
        ownedPipeline: {
          pipelineId: 'owned-1',
          chatEditable: true,
          storedAction: stored,
        },
      }),
    );
    expect(shared.action).toEqual(stored);
    expect(shared).not.toHaveProperty('ownedPipeline');
  });

  it('leaves an automation that owns nothing alone', () => {
    const native = activity({});
    expect(storedAutomationActivity(native)).toBe(native);
  });
});
