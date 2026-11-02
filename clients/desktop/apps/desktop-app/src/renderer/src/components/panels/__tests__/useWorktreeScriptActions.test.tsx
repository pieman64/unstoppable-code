/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CanopyClientProvider } from '@canopy/app-state';
import type { CanopyClient } from '@canopy/app-core';
import type { WorktreeTopBarPinnedAction } from '@canopy/ui-app';
import type {
  ScriptAction,
  ScriptActionsSnapshot,
} from '@canopy/protocol/script-actions';

const mockAddToast = jest.fn();
const mockReveal = jest.fn();
const mockRevealExisting = jest.fn();
const mockChatState = {
  worktreeChats: {
    'p/w': {
      activeTabId: 'tab-1',
      tabs: [{ id: 'tab-1', selectedRepoId: 'repo-b' }],
    },
  },
};

jest.mock('@/hooks/useCurrentUiStateReporter', () => ({
  useCurrentUiStateReporter: jest.fn(),
}));
jest.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (state: typeof mockChatState) => unknown): unknown =>
    selector(mockChatState),
}));
jest.mock('@/stores/githubStore', () => ({
  useGitHubStore: {
    getState: (): { addToast: jest.Mock } => ({ addToast: mockAddToast }),
  },
}));
jest.mock('@/stores/globalFocusShortcutStore', () => ({
  useGlobalFocusShortcutStore: (
    selector: (state: { status: null }) => unknown,
  ): unknown => selector({ status: null }),
}));
jest.mock('@/lib/globalFocusShortcut', () => ({
  rendererShortcutPlatform: (): string => 'darwin',
}));
jest.mock('@/lib/terminal-dimensions', () => ({
  computeColsRowsForPixels: (): null => null,
}));
jest.mock('@/lib/script-actions-terminal-host', () => ({
  desktopTerminalRunHost: (): {
    hydrate: () => Promise<void>;
    reveal: jest.Mock;
  } => ({
    hydrate: (): Promise<void> => Promise.resolve(),
    reveal: mockReveal,
  }),
  get revealDesktopTerminal(): typeof mockRevealExisting {
    return mockRevealExisting;
  },
}));

import { useWorktreeScriptActions } from '../useWorktreeScriptActions';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function action(overrides: Partial<ScriptAction>): ScriptAction {
  return {
    id: 'dev',
    kind: 'detected',
    name: 'dev',
    command: 'pnpm run dev',
    multiline: false,
    repoId: 'repo-a',
    repoName: 'canopy',
    packagePath: 'apps/web',
    target: { kind: 'repository', repoId: 'repo-a' },
    source: {
      kind: 'package-json',
      file: 'package.json',
      entry: 'dev',
      line: 1,
    },
    revision: 'r1',
    status: 'approved',
    shortcut: null,
    pinned: true,
    ...overrides,
  };
}

const SNAPSHOT: ScriptActionsSnapshot = {
  actions: [
    action({ id: 'dev', shortcut: 'CommandOrControl+Shift+Y' }),
    action({ id: 'pending', name: 'pending', status: 'pending' }),
    action({
      id: 'alias:gs',
      kind: 'alias',
      name: 'gs',
      command: 'git status',
      repoId: null,
      repoName: null,
      packagePath: null,
      target: { kind: 'selected-repository' },
      source: { kind: 'shell-alias', file: '~/.zshrc', entry: 'gs', line: 1 },
    }),
  ],
  pendingCount: 1,
  shellAliasScanEnabled: true,
  scanStatus: 'complete',
  scannedAt: null,
  diagnostics: [],
};

function fakeClient(spawn: jest.Mock): CanopyClient {
  const client = {
    capabilities: { scriptActions: true, terminalPty: true },
    query: jest.fn((name: string) =>
      Promise.resolve(name === 'scriptActions.list' ? SNAPSHOT : []),
    ),
    command: jest.fn((name: string, args: unknown): Promise<unknown> => {
      if (name === 'scriptActions.rescan') return Promise.resolve(SNAPSHOT);
      return name === 'terminal.spawn'
        ? Promise.resolve().then((): unknown => spawn(args))
        : Promise.resolve('written');
    }),
    subscribe: jest.fn(() => (): void => undefined),
  };
  return client as unknown as CanopyClient;
}

describe('useWorktreeScriptActions', () => {
  let container: HTMLDivElement;
  let root: Root;
  let pins: readonly WorktreeTopBarPinnedAction[];
  let spawn: jest.Mock;
  let client: CanopyClient;

  function Probe({ active }: { active: boolean }): null {
    pins = useWorktreeScriptActions({
      projectId: 'p',
      worktreeId: 'w',
      active,
    });
    return null;
  }

  async function render(active: boolean): Promise<void> {
    await act(async () => {
      root.render(
        <CanopyClientProvider client={client}>
          <Probe active={active} />
        </CanopyClientProvider>,
      );
      await Promise.resolve();
    });
  }

  function press(): void {
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          code: 'KeyY',
          key: 'Y',
          metaKey: true,
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    spawn = jest.fn(() =>
      Promise.resolve({ id: 't1', projectId: 'p', worktreeId: 'w' }),
    );
    client = fakeClient(spawn);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('pins only approved actions and runs them in the right repository', async () => {
    await render(true);
    expect(pins.map((pin) => pin.id)).toEqual(['dev', 'alias:gs']);
    expect(pins[0]).toMatchObject({
      target: 'canopy/apps/web',
      shortcut: '⌘⇧Y',
    });
    await act(async () => {
      pins[1]?.onRun();
      await Promise.resolve();
    });
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({ selectedRepoId: 'repo-b' }),
    );
    expect(mockReveal).toHaveBeenCalled();
  });

  it('dispatches a bound shortcut only while the worktree is active', async () => {
    await render(false);
    expect(pins).toEqual([]);
    press();
    expect(spawn).not.toHaveBeenCalled();

    await render(true);
    await act(async () => {
      press();
      await Promise.resolve();
    });
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        selectedRepoId: 'repo-a',
        relativeCwd: 'apps/web',
      }),
    );
  });

  it('reports a failed run in a toast', async () => {
    spawn.mockRejectedValue(new Error('Invalid relative terminal directory.'));
    await render(true);
    await act(async () => {
      pins[0]?.onRun();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mockAddToast).toHaveBeenCalledWith(
      "Couldn't run dev. Invalid relative terminal directory.",
      'error',
      undefined,
      expect.objectContaining({ category: 'Terminal', projectId: 'p' }),
    );
  });
});
