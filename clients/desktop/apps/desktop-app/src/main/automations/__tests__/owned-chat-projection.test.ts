import { chatAutomationToPipeline } from '@canopy/desktop-shared/lib/chat-automation-conversion';
import type {
  AutomationAction,
  ScheduledActivity,
} from '@canopy/desktop-shared/types';
import type { Pipeline } from '@canopy/desktop-shared/types/pipeline';
import { projectOwnedChatAutomations } from '../owned-chat-projection';

const mockOwned = new Map<string, string>();
jest.mock('../owned-pipeline', () => ({
  ownedPipelineId: (activity: ScheduledActivity): string | undefined =>
    mockOwned.get(activity.id),
}));

const mockPipelines = new Map<string, Pipeline>();
jest.mock('../../pipelines/pipeline-service', () => ({
  getStoredPipelineBySource: (
    _source: string,
    id: string,
  ): { success: boolean; data?: { content: Pipeline } } => {
    const content = mockPipelines.get(id);
    return content ? { success: true, data: { content } } : { success: false };
  },
}));

jest.mock('../../lib/workspace-registry', () => ({
  isCoworkWorkspace: (id: string): boolean => id === 'cowork-1',
}));

const chatAction: AutomationAction = {
  type: 'standalone_prompt',
  chatProjectId: 'cowork-1',
  prompt: 'Organize notes',
};

function activity(id: string, action: AutomationAction): ScheduledActivity {
  return {
    version: 1,
    id,
    name: 'Notes',
    enabled: true,
    schedule: { kind: 'cron', expression: '0 9 * * *', timezone: 'local' },
    action,
    createdAt: '2026-10-29T00:00:00.000Z',
    updatedAt: '2026-10-29T00:00:00.000Z',
    failureCount: 0,
  };
}

/** A converted activity and the pipeline it owns. */
function converted(id: string, pipelineId: string): ScheduledActivity {
  const { pipeline, inputs } = chatAutomationToPipeline({
    name: 'Notes',
    action: chatAction,
  });
  mockPipelines.set(pipelineId, pipeline);
  mockOwned.set(id, pipelineId);
  return activity(id, {
    type: 'worktree_pipeline',
    target: { kind: 'global' },
    pipelineId,
    pipelineSource: 'user',
    pipelineName: pipeline.name,
    inputs,
  });
}

beforeEach(() => {
  mockOwned.clear();
  mockPipelines.clear();
});

// CAN-4551: the renderer edits a converted automation as the chat it sends.
describe('projectOwnedChatAutomations', () => {
  it('shows a converted automation as its chat action, naming its pipeline', () => {
    const [projected] = projectOwnedChatAutomations({
      activities: [converted('a1', 'owned-1')],
      recentRuns: [],
    }).activities;
    expect(projected?.action).toEqual(chatAction);
    expect(projected?.ownedPipeline).toMatchObject({
      pipelineId: 'owned-1',
      chatEditable: true,
      storedAction: { type: 'worktree_pipeline', pipelineId: 'owned-1' },
    });
  });

  it('keeps a hand-edited pipeline as a pipeline, marked read-only', () => {
    const source = converted('a1', 'owned-1');
    const pipeline = mockPipelines.get('owned-1');
    if (!pipeline) throw new Error('no pipeline');
    const [job] = Object.values(pipeline.jobs);
    if (!job) throw new Error('no job');
    mockPipelines.set('owned-1', {
      ...pipeline,
      jobs: {
        chat: { ...job, steps: [...job.steps, { id: 'extra', run: 'true' }] },
      },
    });
    const [projected] = projectOwnedChatAutomations({
      activities: [source],
      recentRuns: [],
    }).activities;
    expect(projected?.action).toEqual(source.action);
    expect(projected?.ownedPipeline).toEqual({
      pipelineId: 'owned-1',
      chatEditable: false,
      storedAction: source.action,
    });
  });

  it('leaves an automation that owns nothing, or whose pipeline is gone', () => {
    const native = activity('a1', chatAction);
    const gone = converted('a2', 'owned-2');
    mockPipelines.delete('owned-2');
    const { activities } = projectOwnedChatAutomations({
      activities: [native, gone],
      recentRuns: [],
    });
    expect(activities).toEqual([native, gone]);
  });
});
