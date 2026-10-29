/** @jest-environment jsdom */
import { act, type JSX } from 'react';
import { createRoot } from 'react-dom/client';
import type { TerminalCompletionNoticesOptions } from '@canopy/ui-app/terminal-core';
import { useTerminalCompletionToasts } from '../hooks/useTerminalCompletionToasts';

let mockOptions: TerminalCompletionNoticesOptions | undefined;
const mockAddToast = jest.fn<void, [string, string, () => void, unknown]>();
const mockSelectWorktree = jest.fn();
const mockNavigate = jest.fn();
const mockCanNavigate = jest.fn<boolean, unknown[]>(() => true);
let mockIndex: Record<string, string> = {};
jest.mock('@canopy/ui-app/terminal-core', () => ({
  useTerminalCompletionNotices: (
    options: TerminalCompletionNoticesOptions,
  ): void => {
    mockOptions = options;
  },
}));
jest.mock('@/stores/terminalActivityStore', () => ({}));
jest.mock('@/stores/chatStore', () => ({
  useChatStore: {
    getState: (): unknown => ({ selectWorktree: mockSelectWorktree }),
  },
}));
jest.mock('@/stores/githubStore', () => ({
  useGitHubStore: { getState: (): unknown => ({ addToast: mockAddToast }) },
}));
jest.mock('@/stores/projectsStore', () => ({
  useProjectsStore: {
    getState: (): unknown => ({
      projects: [{ id: 'p', name: 'Workspace' }],
      hasHydratedProjects: true,
    }),
  },
}));
jest.mock('@/stores/claudeTerminalStore', () => ({
  useClaudeTerminalStore: {
    getState: (): unknown => ({ terminalIdIndex: mockIndex }),
  },
}));
jest.mock('@/lib/worktreeNavigation', () => ({
  canNavigateToWorktreeFromSidebarItems: (...args: unknown[]): unknown =>
    mockCanNavigate(...args),
}));
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});
function Harness(): JSX.Element {
  useTerminalCompletionToasts(mockNavigate);
  return <div />;
}

it('keeps the live Claude index predicate and desktop toast navigation metadata', () => {
  const root = createRoot(document.createElement('div'));
  act(() => root.render(<Harness />));
  try {
    if (!mockOptions) throw new Error('Missing notices options');
    expect(mockOptions.isClaudeCodeTerminal({ terminalId: 't' })).toBe(false);
    mockIndex = { t: 'chat' };
    expect(mockOptions.isClaudeCodeTerminal({ terminalId: 't' })).toBe(true);
    expect(
      mockOptions.isClaudeCodeTerminal({
        terminalId: 'other',
        kind: 'claude-code',
      }),
    ).toBe(true);
    mockOptions.onNotice({
      terminalId: 't',
      projectId: 'p',
      worktreeId: 'w',
      message: 'Terminal exited cleanly',
      type: 'success',
    });
    expect(mockAddToast).toHaveBeenCalledWith(
      'Terminal exited cleanly',
      'success',
      expect.any(Function),
      {
        category: 'Terminal',
        workspaceName: 'Workspace',
        projectId: 'p',
        worktreeId: 'w',
      },
    );
    const click = mockAddToast.mock.calls[0]?.[2];
    click?.();
    expect(mockNavigate).toHaveBeenCalledWith('main');
    expect(mockSelectWorktree).toHaveBeenCalledWith('p', 'w');
    mockNavigate.mockClear();
    mockSelectWorktree.mockClear();
    mockCanNavigate.mockReturnValue(false);
    click?.();
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(mockSelectWorktree).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
  }
});
