/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CanopyClientProvider } from '@canopy/app-state';
import type { CanopyClient } from '@canopy/app-core';
import type { ScriptAction } from '@canopy/protocol/script-actions';

let mockSelection: { projectId: string; worktreeId: string } | null = {
  projectId: 'p',
  worktreeId: 'w',
};
jest.mock('@/stores/chatStore', () => ({
  useChatStore: (
    selector: (state: { selectedWorktree: typeof mockSelection }) => unknown,
  ): unknown => selector({ selectedWorktree: mockSelection }),
}));
jest.mock('@/lib/globalFocusShortcut', () => ({
  rendererShortcutPlatform: (): string => 'darwin',
}));

import { ScriptShortcutsSection } from '../ScriptShortcutsSection';

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
    packagePath: null,
    target: { kind: 'repository', repoId: 'repo-a' },
    source: {
      kind: 'package-json',
      file: 'package.json',
      entry: 'dev',
      line: 1,
    },
    revision: 'r1',
    status: 'approved',
    shortcut: 'CommandOrControl+Shift+Y',
    pinned: false,
    ...overrides,
  };
}

function client(actions: ScriptAction[]): CanopyClient {
  return {
    capabilities: { scriptActions: true, terminalPty: true },
    query: (): Promise<unknown> =>
      Promise.resolve({
        actions,
        pendingCount: 0,
        shellAliasScanEnabled: false,
        scanStatus: 'complete',
        scannedAt: null,
        diagnostics: [],
      }),
    subscribe: (): (() => void) => (): void => undefined,
  } as unknown as CanopyClient;
}

describe('ScriptShortcutsSection', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mockSelection = { projectId: 'p', worktreeId: 'w' };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render(actions: ScriptAction[]): Promise<void> {
    await act(async () => {
      root.render(
        <CanopyClientProvider client={client(actions)}>
          <ScriptShortcutsSection />
        </CanopyClientProvider>,
      );
      await Promise.resolve();
    });
  }

  it("lists the current worktree's script shortcuts and why inactive ones do not run", async () => {
    await render([
      action({}),
      action({
        id: 'lint',
        name: 'lint',
        shortcut: 'Alt+L',
        shortcutConflict: 'Already used by test',
      }),
      action({
        id: 'gone',
        name: 'gone',
        shortcut: 'Alt+G',
        status: 'pending',
      }),
      action({ id: 'none', name: 'none', shortcut: null }),
    ]);
    const rows = Array.from(
      container.querySelectorAll('[data-testid^="script-shortcut-row-"]'),
    );
    expect(rows.map((row) => row.getAttribute('data-testid'))).toEqual([
      'script-shortcut-row-dev',
      'script-shortcut-row-lint',
      'script-shortcut-row-gone',
    ]);
    expect(rows[0]?.textContent).toContain('pnpm run dev');
    expect(rows[1]?.textContent).toContain('Already used by test');
    expect(rows[2]?.textContent).toContain('Review this script');
  });

  it('renders nothing without a selected worktree or bindings', async () => {
    await render([action({ shortcut: null })]);
    expect(
      container.querySelector('[data-testid="settings-script-shortcuts"]'),
    ).toBeNull();
    mockSelection = null;
    await render([action({})]);
    expect(
      container.querySelector('[data-testid="settings-script-shortcuts"]'),
    ).toBeNull();
  });
});
