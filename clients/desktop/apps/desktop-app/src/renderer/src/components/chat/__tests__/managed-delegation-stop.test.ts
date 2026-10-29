/** @jest-environment jsdom */
import type { AgentDelegationStatus } from '@canopy/protocol/delegation';
import type {
  TurnBlock,
  TurnGroupOrMessage,
  TurnMessage,
} from '@canopy/desktop-shared/lib/turn-utils';
import {
  requestManagedDelegationStop,
  requestManagedDelegationStopAll,
  selectManagedDelegationStopState,
} from '../managed-delegation-stop';

const mockAddToast = jest.fn();
jest.mock('@/stores/githubStore', () => ({
  useGitHubStore: {
    getState: (): { addToast: jest.Mock } => ({ addToast: mockAddToast }),
  },
}));

const stop = jest.fn();
const stopAll = jest.fn();
Object.defineProperty(window, 'api', {
  configurable: true,
  value: { managedDelegation: { stop, stopAll } },
});

const TARGET = {
  projectId: 'project-1',
  worktreeId: 'worktree-1',
  chatId: 'chat-1',
};

function delegation(
  delegationId: string,
  status: AgentDelegationStatus,
  options: {
    parentDelegationId?: string;
    runGeneration?: number;
    executionMode?: 'foreground' | 'background';
    subBlocks?: TurnBlock[];
  } = {},
): TurnBlock {
  return {
    type: 'delegated_agent_call',
    agentBlockId: `delegated-agent-${delegationId}`,
    delegationId,
    parentTurnId: 'turn',
    sequence: 1,
    createdAt: 1,
    selectedModelId: 'sonnet',
    runtimeModelId: 'sonnet',
    targetHarnessId: 'claude',
    parentToolCallId: `spawn-${delegationId}`,
    parentHarnessId: 'claude',
    description: delegationId,
    prompt: delegationId,
    executionMode: options.executionMode ?? 'background',
    status,
    runGeneration: options.runGeneration ?? 1,
    outputTruncated: false,
    subBlocks: options.subBlocks ?? [],
    ...(options.parentDelegationId !== undefined
      ? { parentDelegationId: options.parentDelegationId }
      : {}),
  };
}

function groupsOf(...blocks: TurnBlock[]): TurnGroupOrMessage[] {
  return blocks.map((block, index): TurnGroupOrMessage => {
    const message: TurnMessage = {
      id: `message-${index}`,
      role: 'assistant',
      timestamp: index,
      blocks: [block],
    };
    return { kind: 'standalone', message };
  });
}

describe('selectManagedDelegationStopState', () => {
  it('lists every live delegation at any depth and in either mode', () => {
    const state = selectManagedDelegationStopState(
      groupsOf(
        delegation('queued', 'pending'),
        delegation('foreground', 'running', { executionMode: 'foreground' }),
        delegation('done', 'completed'),
        delegation('parent', 'running', {
          subBlocks: [
            delegation('nested', 'running', { parentDelegationId: 'parent' }),
          ],
        }),
      ),
    );
    expect(state.liveDelegationIds).toEqual([
      'queued',
      'foreground',
      'parent',
      'nested',
    ]);
  });

  it('uses the latest run of each delegation', () => {
    const state = selectManagedDelegationStopState(
      groupsOf(
        delegation('child', 'completed', { runGeneration: 1 }),
        delegation('child', 'running', { runGeneration: 2 }),
        delegation('settled', 'running', { runGeneration: 1 }),
        delegation('settled', 'cancelled', { runGeneration: 1 }),
      ),
    );
    expect(state.liveDelegationIds).toEqual(['child']);
  });

  it('marks every ancestor of a live delegation, through settled parents', () => {
    const state = selectManagedDelegationStopState(
      groupsOf(
        delegation('root-child', 'running'),
        delegation('middle', 'completed', {
          parentDelegationId: 'root-child',
        }),
        delegation('grandchild', 'running', { parentDelegationId: 'middle' }),
        delegation('lonely', 'running'),
        delegation('finished-parent', 'running'),
        delegation('finished-child', 'completed', {
          parentDelegationId: 'finished-parent',
        }),
      ),
    );
    expect(state.withLiveDescendants).toEqual(['middle', 'root-child']);
  });
});

describe('user delegation stops', () => {
  beforeEach(() => {
    stop.mockReset();
    stopAll.mockReset();
    mockAddToast.mockReset();
  });

  it('stops one delegation for the chat', async () => {
    stop.mockResolvedValue({ ok: true });
    await expect(
      requestManagedDelegationStop(TARGET, 'delegation-1'),
    ).resolves.toBe(true);
    expect(stop).toHaveBeenCalledWith({
      ...TARGET,
      delegationId: 'delegation-1',
    });
    expect(mockAddToast).not.toHaveBeenCalled();
  });

  it('reports a refused stop with main’s reason', async () => {
    stop.mockResolvedValue({
      ok: false,
      error: 'That delegation is not one of your descendants.',
    });
    await expect(
      requestManagedDelegationStop(TARGET, 'delegation-1'),
    ).resolves.toBe(false);
    expect(mockAddToast).toHaveBeenCalledWith(
      "Couldn't stop the delegation. That delegation is not one of your descendants.",
      'error',
      undefined,
      { category: 'Chat', ...TARGET },
    );
  });

  it('reports a failed stop request without the IPC wrapper', async () => {
    stop.mockRejectedValue(
      new Error("Error invoking remote method 'managed-delegation:stop': Boom"),
    );
    await expect(
      requestManagedDelegationStop(TARGET, 'delegation-1'),
    ).resolves.toBe(false);
    expect(mockAddToast).toHaveBeenCalledWith(
      "Couldn't stop the delegation. Boom",
      'error',
      undefined,
      { category: 'Chat', ...TARGET },
    );
  });

  it('stops every delegation in the chat', async () => {
    stopAll.mockResolvedValue({ ok: true, stopped: 3 });
    await expect(requestManagedDelegationStopAll(TARGET)).resolves.toBe(true);
    expect(stopAll).toHaveBeenCalledWith(TARGET);
    expect(stop).not.toHaveBeenCalled();
  });

  it('reports a failed Stop all', async () => {
    stopAll.mockResolvedValue({ ok: false, error: '' });
    await expect(requestManagedDelegationStopAll(TARGET)).resolves.toBe(false);
    expect(mockAddToast).toHaveBeenCalledWith(
      "Couldn't stop the delegations.",
      'error',
      undefined,
      { category: 'Chat', ...TARGET },
    );
  });
});
