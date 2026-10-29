import { bindTerminalClient } from '@canopy/app-state/terminal';
import { useTerminalStore } from '../stores/terminalStore';
import { useTerminalDrawerAttentionStore } from '../stores/terminalDrawerAttentionStore';
import { createFakeTerminalClient } from '../../../../../../packages/app-state/src/terminal/__tests__/fake-terminal-client';
import type { TerminalSession } from '@canopy/protocol/terminal';
const session: TerminalSession = {
  id: 'terminal',
  projectId: 'project',
  worktreeId: 'worktree',
  shell: 'zsh',
  shellBasename: 'zsh',
  cwd: '/',
  createdAt: 1,
};
describe('desktop terminal removal attention host', () => {
  it.each(['pane', 'group'])('clears attention after %s removal', (kind) => {
    const dispose = bindTerminalClient(createFakeTerminalClient().client);
    try {
      useTerminalStore.getState().addGroupWithTerminal(session);
      useTerminalDrawerAttentionStore.getState().applyRunning({
        terminalId: session.id,
        projectId: session.projectId,
        worktreeId: session.worktreeId,
        running: true,
        processName: 'sleep',
      });
      const group =
        useTerminalStore.getState().worktrees['project/worktree'].groups[0];
      if (kind === 'pane')
        useTerminalStore
          .getState()
          .removeTerminal('project', 'worktree', session.id);
      else
        useTerminalStore
          .getState()
          .removeGroup('project', 'worktree', group.id);
      expect(
        useTerminalDrawerAttentionStore.getState().worktrees['project/worktree']
          .terminals,
      ).toEqual({});
    } finally {
      dispose();
    }
  });
});
