/**
 * @jest-environment jsdom
 */
import type { SessionViewModel } from '@canopy/app-core';
import {
  compareDesktopSidebarParity,
  parseWorktreeSelectionKey,
  routeShadowSelection,
} from '../DesktopSidebarShadowPanel';

const snapshot = {
  standaloneChats: [
    {
      localId: 'entry/with/slashes',
      projectLocalId: 'workspace-cowork',
      title: 'Entry',
    },
  ],
  // `routeShadowSelection` resolves a `kind: 'workspace'` selection against
  // this list to tell a flat cowork workspace (routes to the chat page) from a
  // tree-layout one (a code workspace, which has no chat page to route to).
  workspaces: [
    { localId: 'workspace-cowork', type: 'cowork', layout: 'flat' },
    { localId: 'workspace-code', type: 'single-repo', layout: 'tree' },
  ],
} as SessionViewModel;

function makeActions(): {
  navigate: jest.Mock;
  openStandaloneChat: jest.Mock;
  selectWorkspace: jest.Mock;
  selectWorktree: jest.Mock;
} {
  return {
    navigate: jest.fn(),
    openStandaloneChat: jest.fn(),
    selectWorkspace: jest.fn(),
    selectWorktree: jest.fn(),
  };
}

describe('DesktopSidebarShadowPanel selection routing', () => {
  it('routes project selection to the chat project', () => {
    const actions = makeActions();

    routeShadowSelection(
      { kind: 'workspace', workspaceLocalId: 'workspace-cowork' },
      snapshot,
      actions,
    );

    expect(actions.selectWorkspace).toHaveBeenCalledWith('workspace-cowork');
    expect(actions.navigate).toHaveBeenCalledWith('chat');
  });

  it('ignores a code workspace selection, which has no chat page', () => {
    const actions = makeActions();

    routeShadowSelection(
      { kind: 'workspace', workspaceLocalId: 'workspace-code' },
      snapshot,
      actions,
    );

    expect(actions.selectWorkspace).not.toHaveBeenCalled();
    expect(actions.navigate).not.toHaveBeenCalled();
  });

  it('routes worktree selection to the native worktree surface', () => {
    const actions = makeActions();

    routeShadowSelection(
      {
        kind: 'worktree',
        workspaceLocalId: 'workspace-code',
        worktreeLocalId: 'feature/with/slashes',
      },
      snapshot,
      actions,
    );

    expect(actions.selectWorktree).toHaveBeenCalledWith(
      'workspace-code',
      'feature/with/slashes',
    );
    expect(actions.navigate).toHaveBeenCalledWith('main');
  });

  it('routes standalone chat selection through its owning project', () => {
    const actions = makeActions();

    routeShadowSelection(
      { kind: 'standalone-chat', standaloneChatId: 'entry/with/slashes' },
      snapshot,
      actions,
    );

    expect(actions.openStandaloneChat).toHaveBeenCalledWith(
      'workspace-cowork',
      'entry/with/slashes',
    );
    expect(actions.navigate).toHaveBeenCalledWith('chat');
  });
});

describe('parseWorktreeSelectionKey', () => {
  it('splits once and preserves separators in the worktree id', () => {
    expect(parseWorktreeSelectionKey('workspace/feature/with/slashes')).toEqual(
      {
        kind: 'worktree',
        workspaceLocalId: 'workspace',
        worktreeLocalId: 'feature/with/slashes',
      },
    );
  });

  it.each([null, '', 'missing-separator', '/worktree', 'workspace/'])(
    'rejects malformed key %p',
    (key) => {
      expect(parseWorktreeSelectionKey(key)).toBeNull();
    },
  );
});

describe('compareDesktopSidebarParity', () => {
  it('pins ordering, selection, and per-row status-class parity', () => {
    const paritySnapshot = {
      workspaces: [{ localId: 'workspace-b' }, { localId: 'workspace-a' }],
      worktrees: [
        {
          localId: 'worktree-b',
          workspaceLocalId: 'workspace-a',
          status: 'active',
          isStreaming: true,
        },
        {
          localId: 'worktree-a',
          workspaceLocalId: 'workspace-a',
          status: 'active',
        },
      ],
    } as SessionViewModel;

    const mismatches = compareDesktopSidebarParity({
      snapshot: paritySnapshot,
      sortedProjects: [
        {
          id: 'workspace-a',
          type: 'single-repo',
          worktrees: [{ id: 'worktree-a' }, { id: 'worktree-b' }],
        },
        { id: 'workspace-b', type: 'cowork', worktrees: [] },
      ],
      nativeSelection: 'workspace-a/worktree-a',
      sharedSelection: 'workspace-a/worktree-b',
      worktreeStatusMap: new Map([
        ['workspace-a/worktree-a', 'idle'],
        ['workspace-a/worktree-b', 'idle'],
      ]),
    });

    expect(mismatches.map(({ field }) => field)).toEqual([
      'workspace-order',
      'worktree-order',
      'selection',
      'status-class',
    ]);
    expect(mismatches.find(({ field }) => field === 'worktree-order')).toEqual(
      expect.objectContaining({ id: 'workspace-a' }),
    );
    expect(mismatches.find(({ field }) => field === 'selection')).toEqual(
      expect.objectContaining({
        native: 'workspace-a/worktree-a',
        shadow: 'workspace-a/worktree-b',
      }),
    );
    expect(mismatches.find(({ field }) => field === 'status-class')).toEqual(
      expect.objectContaining({ id: 'workspace-a/worktree-b' }),
    );
  });
});
