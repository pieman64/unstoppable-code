import type { LedgerContainer } from '@canopy/protocol/canopy-core';
import {
  LedgerPipelineAgentOwners,
  getLedgerPipelineAgentOwners,
  retireLedgerPipelineExecutionTree,
} from '../pipeline-agent-owners';

const WORKTREE: LedgerContainer = {
  kind: 'code_worktree',
  workspaceId: 'workspace-1',
  worktreeId: 'worktree-1',
};
const OTHER_WORKTREE: LedgerContainer = {
  kind: 'code_worktree',
  workspaceId: 'workspace-1',
  worktreeId: 'worktree-2',
};

function pause(
  owners: LedgerPipelineAgentOwners,
  agentSessionId: string,
  executionId: string,
  checkpointId: string,
  container: LedgerContainer = WORKTREE,
): void {
  owners.notePaused({
    agentSessionId,
    displayName: `Agent ${agentSessionId}`,
    executionId,
    jobId: 'build',
    stepId: 'agent',
    attempt: 1,
    container,
    checkpointId,
    pausedAt: '2026-09-30T00:00:00.000Z',
  });
}

describe('LedgerPipelineAgentOwners', () => {
  it('lists paused agents by container at a new execution generation', () => {
    const owners = new LedgerPipelineAgentOwners();
    pause(owners, 'agent-a', 'exec-1', 'checkpoint-a');
    pause(owners, 'agent-b', 'exec-2', 'checkpoint-b', OTHER_WORKTREE);

    expect(owners.list(WORKTREE)).toEqual([
      expect.objectContaining({
        agentSessionId: 'agent-a',
        checkpointId: 'checkpoint-a',
        executionGeneration: 1,
      }),
    ]);
    expect(owners.find('agent-b')?.executionId).toBe('exec-2');
    expect(owners.generation('exec-1')).toBe(1);
  });

  it("lists a global Ledger's paused agents only for the incarnation they paused in", () => {
    const owners = new LedgerPipelineAgentOwners();
    const personal: LedgerContainer = {
      kind: 'global',
      owner: { kind: 'personal' },
    };
    // Each account's Personal global Ledger is its own incarnation.
    owners.notePaused({
      agentSessionId: 'agent-a',
      displayName: 'Agent a',
      executionId: 'exec-1',
      jobId: 'build',
      stepId: 'agent',
      attempt: 1,
      container: personal,
      containerCreatedAt: '2026-10-01T00:00:00.000Z',
      checkpointId: 'checkpoint-a',
      pausedAt: '2026-09-30T00:00:00.000Z',
    });

    expect(
      owners
        .list(personal, '2026-10-01T00:00:00.000Z')
        .map((agent) => agent.agentSessionId),
    ).toEqual(['agent-a']);
    expect(owners.list(personal, '2026-10-02T00:00:00.000Z')).toEqual([]);
  });

  it('drops an agent once it runs again', () => {
    const owners = new LedgerPipelineAgentOwners();
    pause(owners, 'agent-a', 'exec-1', 'checkpoint-a');
    owners.noteRunning('agent-a');
    expect(owners.list(WORKTREE)).toEqual([]);
    expect(owners.find('agent-a')).toBeUndefined();
  });

  it('retires resumed checkpoints and restamps agents still paused', () => {
    const owners = new LedgerPipelineAgentOwners();
    pause(owners, 'agent-a', 'exec-1', 'checkpoint-a');
    pause(owners, 'agent-b', 'exec-1', 'checkpoint-b');
    expect(owners.find('agent-b')?.executionGeneration).toBe(2);

    owners.retireExecution('exec-1', ['checkpoint-a']);

    expect(owners.find('agent-a')).toBeUndefined();
    // Still paused, at the new generation, so earlier tokens go stale.
    expect(owners.find('agent-b')?.executionGeneration).toBe(3);
    expect(owners.generation('exec-1')).toBe(3);

    owners.retireExecution('exec-1');
    expect(owners.list(WORKTREE)).toEqual([]);
  });

  it('holds an execution fence until the holder finishes', async () => {
    const owners = new LedgerPipelineAgentOwners();
    pause(owners, 'agent-a', 'exec-1', 'checkpoint-a');
    const order: string[] = [];
    let releaseCommit: () => void = (): void => undefined;
    const commitHeld = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });

    const commit = owners.withAdmission('exec-1', async () => {
      order.push('commit-start');
      await commitHeld;
      order.push('commit-end');
      return owners.find('agent-a') !== undefined;
    });
    const resume = owners.withAdmission('exec-1', () => {
      order.push('resume');
      owners.retireExecution('exec-1');
      return Promise.resolve();
    });
    // Another execution's fence is independent.
    await owners.withAdmission('exec-2', () => {
      order.push('other');
      return Promise.resolve();
    });

    releaseCommit();
    await expect(commit).resolves.toBe(true);
    await resume;
    expect(order).toEqual(['commit-start', 'other', 'commit-end', 'resume']);
    expect(owners.find('agent-a')).toBeUndefined();
  });
});

describe('retireLedgerPipelineExecutionTree', () => {
  const owners = getLedgerPipelineAgentOwners();
  const TREE: Record<string, string[]> = {
    'tree-root': ['tree-child'],
    // A malformed record naming its parent is not walked twice.
    'tree-child': ['tree-grandchild', 'tree-root'],
    'tree-grandchild': [],
  };

  afterEach(() => {
    for (const executionId of [...Object.keys(TREE), 'tree-other']) {
      owners.retireExecution(executionId);
    }
  });

  it('retires the nested executions a cancellation leaves paused', async () => {
    pause(owners, 'agent-root', 'tree-root', 'checkpoint-root');
    pause(owners, 'agent-grandchild', 'tree-grandchild', 'checkpoint-gc');
    pause(owners, 'agent-other', 'tree-other', 'checkpoint-other');
    const listed: string[] = [];

    await retireLedgerPipelineExecutionTree('tree-root', (executionId) => {
      listed.push(executionId);
      return Promise.resolve(TREE[executionId] ?? []);
    });

    expect(owners.find('agent-root')).toBeUndefined();
    expect(owners.find('agent-grandchild')).toBeUndefined();
    // Another execution's paused agent stays assignable.
    expect(owners.find('agent-other')).toBeDefined();
    expect(listed).toEqual(['tree-root', 'tree-child', 'tree-grandchild']);
  });

  it('reads nothing once no paused agent is left outside the execution', async () => {
    pause(owners, 'agent-root', 'tree-root', 'checkpoint-root');
    const nestedExecutions = jest.fn(
      (): Promise<readonly string[]> => Promise.resolve([]),
    );

    await retireLedgerPipelineExecutionTree('tree-root', nestedExecutions);

    expect(owners.find('agent-root')).toBeUndefined();
    expect(nestedExecutions).not.toHaveBeenCalled();
  });

  it('treats an unreadable execution as having no nested ones', async () => {
    pause(owners, 'agent-child', 'tree-child', 'checkpoint-child');

    await expect(
      retireLedgerPipelineExecutionTree('tree-root', () =>
        Promise.reject(new Error('unreadable')),
      ),
    ).resolves.toBeUndefined();
    expect(owners.find('agent-child')).toBeDefined();
  });

  it('waits for an owner commit checking a nested agent', async () => {
    pause(owners, 'agent-child', 'tree-child', 'checkpoint-child');
    let releaseCommit: () => void = (): void => undefined;
    const commit = owners.withAdmission(
      'tree-child',
      () =>
        new Promise<void>((resolve) => {
          releaseCommit = resolve;
        }),
    );

    const retiring = retireLedgerPipelineExecutionTree(
      'tree-root',
      (executionId) => Promise.resolve(TREE[executionId] ?? []),
    );
    for (let tick = 0; tick < 10; tick += 1) await Promise.resolve();

    expect(owners.find('agent-child')).toBeDefined();
    releaseCommit();
    await commit;
    await retiring;
    expect(owners.find('agent-child')).toBeUndefined();
  });
});
