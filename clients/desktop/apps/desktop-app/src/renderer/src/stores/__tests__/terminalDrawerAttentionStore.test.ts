import {
  terminalDrawerNeedsAttention,
  useTerminalDrawerAttentionStore,
} from '../terminalDrawerAttentionStore';

beforeEach(() => {
  useTerminalDrawerAttentionStore.setState({ worktrees: {} });
});

it('deduplicates output and retains unread after process exit', () => {
  const store = useTerminalDrawerAttentionStore.getState();
  store.setCollapsed('p/w', true);
  store.applyRunning({
    projectId: 'p',
    worktreeId: 'w',
    terminalId: 't',
    running: true,
    processName: 'npm',
  });
  store.applyOutput({
    projectId: 'p',
    worktreeId: 'w',
    terminalId: 't',
    seq: 2,
    data: new Uint8Array([1]),
  });
  store.applyOutput({
    projectId: 'p',
    worktreeId: 'w',
    terminalId: 't',
    seq: 2,
    data: new Uint8Array([1]),
  });
  store.applyExit({
    projectId: 'p',
    worktreeId: 'w',
    terminalId: 't',
    exitCode: 0,
    signal: null,
  });
  expect(terminalDrawerNeedsAttention('p/w')).toBe(true);
  expect(
    useTerminalDrawerAttentionStore.getState().worktrees['p/w']?.terminals.t,
  ).toMatchObject({
    running: false,
    unread: true,
    lastSequence: 2,
  });
  store.setCollapsed('p/w', false);
  expect(terminalDrawerNeedsAttention('p/w')).toBe(false);
});

it('reconstructs running state from the terminal list while pruning ended sessions', () => {
  useTerminalDrawerAttentionStore.setState({
    worktrees: {
      'p/w': {
        collapsed: true,
        terminals: {
          ended: { running: true, unread: true, lastSequence: 8 },
        },
      },
    },
  });

  useTerminalDrawerAttentionStore.getState().reconcileSessions([
    {
      id: 'running',
      projectId: 'p',
      worktreeId: 'w',
      running: true,
      processName: 'npm',
    },
  ]);

  expect(useTerminalDrawerAttentionStore.getState().worktrees['p/w']).toEqual({
    collapsed: true,
    terminals: {
      running: { running: true, unread: false, lastSequence: 0 },
    },
  });
  expect(terminalDrawerNeedsAttention('p/w')).toBe(true);
});
