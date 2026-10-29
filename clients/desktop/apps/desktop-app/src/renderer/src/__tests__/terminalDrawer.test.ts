import {
  bindTerminalClient,
  useTerminalStore,
} from '@canopy/app-state/terminal';
import { createFakeTerminalClient } from '../../../../../../packages/app-state/src/terminal/__tests__/fake-terminal-client';
import {
  ensureTerminalDrawerExitSubscription,
  resetTerminalDrawerExitSubscriptionForTesting,
} from '../components/terminal/terminalDrawerExitSubscription';
import type { TerminalSession } from '@canopy/protocol/terminal';

const mockDisposeInstance = jest.fn();
jest.mock('@/lib/terminal-instances', () => ({
  disposeInstance: mockDisposeInstance,
  peekInstance: jest.fn(() => undefined),
}));

const session: TerminalSession = {
  id: 'term-1',
  projectId: 'proj-1',
  worktreeId: 'wt-1',
  shell: 'zsh',
  shellBasename: 'zsh',
  cwd: '/',
  createdAt: 1,
};
describe('TerminalDrawer exit integration', () => {
  it('keeps exited sessions and cached terminal instances alive', () => {
    const fake = createFakeTerminalClient();
    const dispose = bindTerminalClient(fake.client);
    try {
      useTerminalStore.getState().addGroupWithTerminal(session);
      resetTerminalDrawerExitSubscriptionForTesting();
      ensureTerminalDrawerExitSubscription();
      ensureTerminalDrawerExitSubscription();
      expect(fake.listenerCount('terminal.exit')).toBe(1);
      fake.emit('terminal.exit', {
        projectId: session.projectId,
        worktreeId: session.worktreeId,
        terminalId: session.id,
        exitCode: 0,
        signal: null,
        occurredAt: 'now',
      });
      expect(
        useTerminalStore.getState().worktrees['proj-1/wt-1'].sessions['term-1'],
      ).toMatchObject({ live: false, exitCode: 0, signal: null });
      expect(mockDisposeInstance).not.toHaveBeenCalled();
    } finally {
      resetTerminalDrawerExitSubscriptionForTesting();
      dispose();
    }
  });
});
