import type {
  PersistedChatMessage,
  PipelineRunArtifactReceiptV1,
} from '../../types';
import { buildPipelineRunArtifactReceipt } from '../agent-artifacts';
import {
  isArtifactDispatchTool,
  projectAgentArtifactsWithCarry,
  projectPipelineRunTurnLinks,
  type AgentArtifactProjectionStats,
} from '../agent-artifact-projection';

const now = '2026-08-04T12:00:00.000Z';

function receipt(
  executionId: string,
  operation = 'pipeline.run',
  worktreeId = 'worktree-1',
): PipelineRunArtifactReceiptV1 {
  return buildPipelineRunArtifactReceipt({
    operation,
    executionId,
    pipelineId: 'pipe-1',
    pipelineName: 'Build',
    initialStatus: 'running',
    queuedAt: now,
    createdAt: now,
    projectId: 'project-1',
    worktreeId,
    navigationTarget: {
      kind: 'pipeline_execution',
      executionId,
      projectId: 'project-1',
      worktreeId,
    },
  });
}

function user(id: string, hidden = false): PersistedChatMessage {
  return {
    id,
    role: 'user',
    blocks: [{ type: 'text', text: id }],
    timestamp: 1,
    ...(hidden ? { hidden: true } : {}),
  };
}

function call(
  id: string,
  toolUseId: string,
  toolName = 'DispatchAction',
): PersistedChatMessage {
  return {
    id,
    role: 'assistant',
    blocks: [{ type: 'tool_use', toolUseId, toolName, input: '{}' }],
    timestamp: 2,
  };
}

function result(
  id: string,
  toolUseId: string,
  receipts: readonly PipelineRunArtifactReceiptV1[],
  toolName = 'DispatchAction',
): PersistedChatMessage {
  return {
    id,
    role: 'assistant',
    blocks: [
      {
        type: 'tool_result',
        toolUseId,
        toolName,
        output: JSON.stringify({
          ok: true,
          result: { agentArtifacts: receipts },
        }),
        isError: false,
      },
    ],
    timestamp: 3,
  };
}

const scope = { projectId: 'project-1', worktreeId: 'worktree-1' };

describe('shared agent artifact projection (CAN-3619)', () => {
  it('recognizes only action dispatch tools', () => {
    expect(isArtifactDispatchTool('DispatchAction')).toBe(true);
    expect(isArtifactDispatchTool('Bash')).toBe(false);
  });

  it('reports projection work to the host callback', () => {
    const stats: AgentArtifactProjectionStats[] = [];
    projectAgentArtifactsWithCarry(
      [user('u-1'), call('c-1', 't-1'), result('r-1', 't-1', [receipt('e')])],
      undefined,
      undefined,
      (next) => stats.push(next),
    );
    expect(stats).toEqual([{ turns: 1, segments: 1 }]);
  });

  it('links each run once per owning turn with its merged relation', () => {
    const messages = [
      user('u-1'),
      call('c-1', 't-1'),
      result('r-1', 't-1', [receipt('exec-run')]),
      call('c-2', 't-2'),
      result('r-2', 't-2', [receipt('exec-run', 'pipeline.execution_resume')]),
      // A hidden delivery does not start a turn; its calls stay with u-1.
      user('hidden-1', true),
      call('c-3', 't-3'),
      result('r-3', 't-3', [receipt('exec-foreign', 'pipeline.run', 'wt-2')]),
      user('u-2'),
      call('c-4', 't-4'),
      user('u-3'),
      // Late result: belongs to u-2, which made the call.
      result('r-4', 't-4', [receipt('exec-retry', 'pipeline.execution_retry')]),
      call('c-5', 't-5', 'Bash'),
      result('r-5', 't-5', [receipt('exec-bash')], 'Bash'),
    ];
    const projection = projectAgentArtifactsWithCarry(messages, {
      'u-3': [receipt('exec-watch', 'pipeline.watch')],
      'u-gone': [receipt('exec-ghost', 'pipeline.watch')],
    });

    expect(
      projectPipelineRunTurnLinks(projection, ['u-1', 'u-2', 'u-3'], scope),
    ).toEqual([
      { executionId: 'exec-run', userMessageId: 'u-1', relation: 'launched' },
      {
        executionId: 'exec-retry',
        userMessageId: 'u-2',
        relation: 'launched',
      },
      {
        executionId: 'exec-watch',
        userMessageId: 'u-3',
        relation: 'watching',
      },
    ]);
    // Without a scope, another worktree's receipt still attributes to u-1.
    expect(
      projectPipelineRunTurnLinks(projection, ['u-1']).map(
        (link) => link.executionId,
      ),
    ).toEqual(['exec-run', 'exec-foreign']);
  });

  it('follows the given turn order and skips turns without receipts', () => {
    const projection = projectAgentArtifactsWithCarry(
      [user('u-1'), user('u-2')],
      {
        'u-1': [receipt('exec-a', 'pipeline.watch')],
        'u-2': [receipt('exec-b', 'pipeline.watch')],
      },
    );
    expect(
      projectPipelineRunTurnLinks(projection, ['u-2', 'u-missing', 'u-1']).map(
        (link) => link.userMessageId,
      ),
    ).toEqual(['u-2', 'u-1']);
  });
});
