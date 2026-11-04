import type { AutomationAction, ScheduledActivity } from '../../types';
import { chatAutomationConversionReport } from '../chat-automation-conversion-report';

function activity(
  id: string,
  action: AutomationAction,
  overrides: Partial<ScheduledActivity> = {},
): ScheduledActivity {
  return {
    version: 1,
    id,
    name: `Secret name ${id}`,
    enabled: true,
    schedule: { kind: 'cron', expression: '0 9 * * *', timezone: 'local' },
    action,
    createdAt: '2026-05-28T12:00:00.000Z',
    updatedAt: '2026-05-28T12:00:00.000Z',
    failureCount: 0,
    ...overrides,
  };
}

// CAN-5479: the read-only characterization of a stored automations file.
describe('chatAutomationConversionReport', () => {
  const activities = [
    activity(
      'advisor',
      { type: 'app_advisor_prompt', prompt: 'Secret prompt' },
      { ifCommand: 'echo go' },
    ),
    activity('home-task', {
      type: 'worktree_prompt',
      workspaceId: 'workspace-1',
      prompt: 'Secret prompt',
      purpose: 'scheduled_task',
    }),
    activity('workflow', {
      type: 'worktree_pipeline',
      target: { kind: 'global' },
      pipelineId: 'owned-1',
      pipelineSource: 'user',
    }),
    activity(
      'resume',
      {
        type: 'pipeline_execution_resume',
        executionId: 'execution-1',
        statusReasonIds: [],
        provider: 'claude',
        purpose: 'usage_limit_resume',
        pipelineName: 'Nightly',
      },
      {
        enabled: false,
        schedule: {
          kind: 'one_time',
          runAt: '2026-05-28T13:00:00.000Z',
          timezone: 'local',
        },
      },
    ),
  ];

  it('gives each automation a verdict and totals them', () => {
    const report = chatAutomationConversionReport(activities);
    expect(report.entries.map(({ id, shape }) => [id, shape.verdict])).toEqual([
      ['advisor', 'converts'],
      ['home-task', 'stays_native:native_send'],
      ['workflow', 'workflow'],
      ['resume', 'not_chat'],
    ]);
    expect(report.totals).toEqual({
      converts: 1,
      'stays_native:native_send': 1,
      workflow: 1,
      not_chat: 1,
    });
  });

  it('describes shapes by field names and flags, never values', () => {
    const { entries } = chatAutomationConversionReport(activities);
    expect(entries[1]?.shape).toEqual({
      actionType: 'worktree_prompt',
      enabled: true,
      scheduleKind: 'cron',
      actionFields: ['prompt', 'purpose', 'workspaceId'],
      flags: [],
      verdict: 'stays_native:native_send',
    });
    expect(entries[0]?.shape.flags).toEqual(['gate_command']);
    const shapes = JSON.stringify(entries.map(({ shape }) => shape));
    expect(shapes).not.toContain('Secret');
    expect(shapes).not.toContain('workspace-1');
  });
});
