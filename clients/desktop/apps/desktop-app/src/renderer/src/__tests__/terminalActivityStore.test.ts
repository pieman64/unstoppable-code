// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="../../../preload/index.d.ts" />
import {
  disposeTerminalActivitySubscriptions,
  initTerminalActivitySubscriptions,
  useTerminalActivityStore,
} from '@/stores/terminalActivityStore';
import {
  __resetClaudeTerminalStoreForTests,
  useClaudeTerminalStore,
} from '@/stores/claudeTerminalStore';
import { useChatStore } from '@/stores/chatStore';
import { useNavigationStore } from '@/stores/navigationStore';
import {
  type TerminalExitEvent,
  type TerminalRunningChangedEvent,
} from '@canopy/desktop-shared/types';

const PROJECT_ID = 'project-1';
const WORKTREE_ID = 'wt-1';
const WORKTREE_KEY = `${PROJECT_ID}/${WORKTREE_ID}`;

function resetStore(): void {
  disposeTerminalActivitySubscriptions();
  useTerminalActivityStore.setState({
    entriesByWorktree: {},
    runningWorktreeKeys: new Set<string>(),
    unseenWorktreeKeys: new Set<string>(),
    unseenFailureWorktreeKeys: new Set<string>(),
    baselineEstablished: new Set<string>(),
    userInitiatedCloseTerminalIds: new Set<string>(),
  });
  useChatStore.setState({ selectedWorktree: null });
  useNavigationStore.getState().navigate('overview');
  __resetClaudeTerminalStoreForTests();
  initTerminalActivitySubscriptions();
}

function runningEvent(
  overrides: Partial<TerminalRunningChangedEvent> & { terminalId: string },
): TerminalRunningChangedEvent {
  return {
    projectId: PROJECT_ID,
    worktreeId: WORKTREE_ID,
    running: true,
    processName: 'sleep',
    ...overrides,
  };
}

function exitEvent(
  overrides: Partial<TerminalExitEvent> & { terminalId: string },
): TerminalExitEvent {
  return {
    projectId: PROJECT_ID,
    worktreeId: WORKTREE_ID,
    exitCode: 0,
    signal: null,
    ...overrides,
  };
}

describe('desktop terminal activity host', () => {
  beforeEach(resetStore);
  afterAll(disposeTerminalActivitySubscriptions);
  describe('managed Claude chat terminals', () => {
    it('ignores Claude Code terminal running events', () => {
      useTerminalActivityStore.getState().handleRunningChanged(
        runningEvent({
          terminalId: 't1',
          kind: 'claude-code',
          processName: '/Applications/Canopy.app/Contents/Resources/bin/claude',
        }),
      );

      const next = useTerminalActivityStore.getState();
      expect(next.entriesByWorktree[WORKTREE_KEY]).toBeUndefined();
      expect(next.baselineEstablished.has('t1')).toBe(false);
      expect(next.runningWorktreeKeys.has(WORKTREE_KEY)).toBe(false);
    });

    it('removes stale activity once a terminal is identified as Claude Code', () => {
      const store = useTerminalActivityStore.getState();
      store.handleRunningChanged(runningEvent({ terminalId: 't1' }));
      expect(
        useTerminalActivityStore
          .getState()
          .runningWorktreeKeys.has(WORKTREE_KEY),
      ).toBe(true);

      store.handleRunningChanged(
        runningEvent({
          terminalId: 't1',
          kind: 'claude-code',
          processName: '/Applications/Canopy.app/Contents/Resources/bin/claude',
        }),
      );

      const next = useTerminalActivityStore.getState();
      expect(next.entriesByWorktree[WORKTREE_KEY]).toBeUndefined();
      expect(next.baselineEstablished.has('t1')).toBe(false);
      expect(next.runningWorktreeKeys.has(WORKTREE_KEY)).toBe(false);
      expect(next.unseenWorktreeKeys.has(WORKTREE_KEY)).toBe(false);
      expect(next.unseenFailureWorktreeKeys.has(WORKTREE_KEY)).toBe(false);
    });

    it('clears user-close suppression when a Claude Code terminal exits', () => {
      const store = useTerminalActivityStore.getState();
      store.markUserInitiatedClose('t1');

      store.handleExit(
        exitEvent({
          terminalId: 't1',
          kind: 'claude-code',
          exitCode: null,
          signal: '9',
        }),
      );

      const next = useTerminalActivityStore.getState();
      expect(next.userInitiatedCloseTerminalIds.has('t1')).toBe(false);
      expect(next.unseenFailureWorktreeKeys.has(WORKTREE_KEY)).toBe(false);
    });

    it('removes stale activity when the Claude terminal index is populated later', () => {
      useTerminalActivityStore
        .getState()
        .handleRunningChanged(runningEvent({ terminalId: 't1' }));

      useClaudeTerminalStore.setState({
        terminalIdIndex: { t1: `${WORKTREE_KEY}/chat-1` },
      });

      const next = useTerminalActivityStore.getState();
      expect(next.entriesByWorktree[WORKTREE_KEY]).toBeUndefined();
      expect(next.baselineEstablished.has('t1')).toBe(false);
      expect(next.runningWorktreeKeys.has(WORKTREE_KEY)).toBe(false);
      expect(next.unseenWorktreeKeys.has(WORKTREE_KEY)).toBe(false);
      expect(next.unseenFailureWorktreeKeys.has(WORKTREE_KEY)).toBe(false);
    });

    it('clears user-close suppression when the Claude terminal index is populated later', () => {
      const store = useTerminalActivityStore.getState();
      store.handleRunningChanged(runningEvent({ terminalId: 't1' }));
      store.markUserInitiatedClose('t1');

      useClaudeTerminalStore.setState({
        terminalIdIndex: { t1: `${WORKTREE_KEY}/chat-1` },
      });

      const next = useTerminalActivityStore.getState();
      expect(next.entriesByWorktree[WORKTREE_KEY]).toBeUndefined();
      expect(next.baselineEstablished.has('t1')).toBe(false);
      expect(next.runningWorktreeKeys.has(WORKTREE_KEY)).toBe(false);
      expect(next.unseenWorktreeKeys.has(WORKTREE_KEY)).toBe(false);
      expect(next.unseenFailureWorktreeKeys.has(WORKTREE_KEY)).toBe(false);
      expect(next.userInitiatedCloseTerminalIds.has('t1')).toBe(false);
    });
  });

  it('does not mark unseen when the worktree is currently selected', () => {
    useNavigationStore.getState().navigate('main');
    useChatStore.setState({
      selectedWorktree: { projectId: PROJECT_ID, worktreeId: WORKTREE_ID },
    });

    useTerminalActivityStore
      .getState()
      .handleExit(exitEvent({ terminalId: 't1', exitCode: 0, signal: null }));

    expect(
      useTerminalActivityStore.getState().unseenWorktreeKeys.has(WORKTREE_KEY),
    ).toBe(false);
  });
});
