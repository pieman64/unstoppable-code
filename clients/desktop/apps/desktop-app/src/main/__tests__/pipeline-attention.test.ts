import type {
  ExecutionEvent,
  ExecutionState,
  PipelineStatusReason,
} from '@canopy/desktop-shared/types/pipeline';

const mark = jest.fn();
const clear = jest.fn();

jest.mock('../services/attention-tracker', () => ({
  getAttentionTracker: (): { mark: jest.Mock; clear: jest.Mock } => ({
    mark,
    clear,
  }),
}));

import {
  pipelineAttentionChatId,
  syncPipelineAttention,
} from '../pipelines/pipeline-attention';

function reason(
  kind: PipelineStatusReason['kind'],
  overrides: Partial<PipelineStatusReason> = {},
): PipelineStatusReason {
  return {
    id: `reason-${kind}`,
    kind,
    code:
      kind === 'input_required'
        ? 'input_requested'
        : kind === 'action_paused'
          ? 'action_requested_pause'
          : kind === 'provider_authentication_required'
            ? 'authentication_failed'
            : kind === 'provider_usage_limit'
              ? 'usage_limit_exceeded'
              : kind === 'provider_temporarily_unavailable'
                ? 'server_overloaded'
                : 'app_shutdown',
    detected_at: '2026-09-20T12:00:00.000Z',
    source: {
      job_id: 'build',
      step_id: 'approve',
      attempt: 1,
      iteration: 1,
    },
    ...overrides,
  };
}

function event(
  statusReasons: PipelineStatusReason[],
  status: ExecutionState['status'] = 'paused',
): ExecutionEvent {
  return {
    executionId: 'execution-1',
    type: status === 'paused' ? 'execution.paused' : 'execution.updated',
    timestamp: '2026-09-20T12:00:00.000Z',
    state: {
      version: 10,
      id: 'execution-1',
      pipeline_id: 'pipeline-1',
      pipeline_snapshot: {
        name: 'Release',
        scope: ['directory'],
        jobs: {},
      },
      status,
      jobs: {},
      job_definitions: {},
      job_groups: {},
      started_at: '2026-09-20T11:00:00.000Z',
      cwd: '/tmp/worktree',
      env: {},
      inputs: {},
      pending_pauses: [],
      status_reasons: statusReasons,
      project_id: 'project-1',
      worktree_id: 'worktree-1',
    },
  };
}

describe('syncPipelineAttention', () => {
  beforeEach(() => {
    mark.mockReset();
    clear.mockReset();
  });

  it.each(['input_required', 'action_paused'] as const)(
    'raises pipeline_input for a %s checkpoint',
    (kind) => {
      syncPipelineAttention(event([reason(kind)]));

      expect(mark).toHaveBeenCalledWith({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: pipelineAttentionChatId('execution-1'),
        sourceId: 'pipeline-status',
        state: 'needs_input',
        reason: 'pipeline_input',
        detail: 'build / approve',
      });
    },
  );

  it.each([
    ['provider_authentication_required', 'auth_required'],
    ['provider_usage_limit', 'usage_limit'],
  ] as const)('raises blocked attention for %s', (kind, attentionReason) => {
    syncPipelineAttention(event([reason(kind)]));

    expect(mark).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: 'pipeline-status',
        state: 'blocked',
        reason: attentionReason,
      }),
    );
  });

  it('clears the synthetic execution attention when the checkpoint resolves', () => {
    syncPipelineAttention(event([], 'running'));

    expect(clear).toHaveBeenCalledWith(
      'project-1',
      'worktree-1',
      pipelineAttentionChatId('execution-1'),
    );
  });

  it('treats a sparse legacy event with no status reasons as resolved', () => {
    const legacyEvent = event([], 'running');
    Reflect.deleteProperty(legacyEvent.state, 'status_reasons');

    expect(() => syncPipelineAttention(legacyEvent)).not.toThrow();
    expect(clear).toHaveBeenCalledWith(
      'project-1',
      'worktree-1',
      pipelineAttentionChatId('execution-1'),
    );
  });

  it('ignores retryable provider pauses and executions with no worktree target', () => {
    syncPipelineAttention(event([reason('provider_temporarily_unavailable')]));
    const withoutTarget = event([reason('input_required')]);
    delete withoutTarget.state.project_id;
    syncPipelineAttention(withoutTarget);

    expect(mark).not.toHaveBeenCalled();
    expect(clear).toHaveBeenCalledTimes(1);
    expect(clear).toHaveBeenCalledWith(
      'project-1',
      'worktree-1',
      pipelineAttentionChatId('execution-1'),
    );
  });
});
