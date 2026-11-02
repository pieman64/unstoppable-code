/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CanopyCapabilities } from '@canopy/app-core';
import type { SpaceNotificationMenuState } from '@canopy/ui-shared/components';
import type { SidebarSurfaceSnapshot } from '../../SidebarSurface';
import { worktreeRowKey } from '../../workspace-sections-model';
import {
  useSidebarWorktreeBulk,
  type SidebarWorktreeBulk,
  type UseSidebarWorktreeBulkInput,
} from '../use-sidebar-worktree-bulk';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const capabilities: CanopyCapabilities = {
  localExecution: false,
  terminalPty: false,
  fileSystemAccess: 'read',
  voice: false,
  settingsScope: 'api-keys-only',
  pipelines: 'crud-only',
  routing: 'url',
  overviewNotifications: false,
  workspaceCreation: 'remote-clone',
  workspaceReordering: false,
  worktreeReordering: false,
  workspaceSettings: false,
  worktreeRemoval: 'archive',
  worktreeRetention: 'archive-or-delete',
  worktreeMetadata: true,
};

const snapshot = {
  workspaces: [
    { localId: 'ws', name: 'Workspace', type: 'single-repo' as const },
  ],
  worktrees: [
    {
      localId: 'wt-1',
      workspaceLocalId: 'ws',
      branch: 'one',
      order: 0,
      pinned: true,
    },
    { localId: 'wt-2', workspaceLocalId: 'ws', branch: 'two', order: 1 },
  ],
  standaloneChats: [],
} satisfies SidebarSurfaceSnapshot;

const READY: SpaceNotificationMenuState = {
  status: 'ready',
  override: null,
  selectionKnown: true,
};

const ONE = worktreeRowKey('ws', 'wt-1');
const TWO = worktreeRowKey('ws', 'wt-2');

describe('useSidebarWorktreeBulk state actions', () => {
  let container: HTMLDivElement;
  let root: Root;
  let latest: SidebarWorktreeBulk | undefined;

  function Probe(props: UseSidebarWorktreeBulkInput): JSX.Element {
    latest = useSidebarWorktreeBulk(props);
    return <span />;
  }

  function render(
    over: Partial<UseSidebarWorktreeBulkInput> = {},
    nextSnapshot: SidebarSurfaceSnapshot = snapshot,
  ): SidebarWorktreeBulk {
    act(() =>
      root.render(
        <Probe
          enabled
          snapshot={nextSnapshot}
          navigation={undefined}
          capabilitiesOf={() => capabilities}
          remove={() => Promise.resolve()}
          branchChoice={false}
          {...over}
        />,
      ),
    );
    if (latest === undefined) throw new Error('Not rendered');
    return latest;
  }

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    latest = undefined;
  });

  it('reports pin, hide, and notifications where the host wires them', () => {
    const { binding } = render({
      setWorktreePinned: jest.fn(),
      hideWorktree: jest.fn(),
      getNotificationState: () => READY,
      setNotificationChoice: jest.fn(),
    });
    expect(binding.rowStateFor?.(ONE)).toEqual({
      pinned: true,
      hideable: true,
      notifications: READY,
    });
    expect(binding.rowStateFor?.(TWO)).toEqual({
      pinned: false,
      hideable: true,
      notifications: READY,
    });
    expect(binding.rowStateFor?.(worktreeRowKey('ws', 'gone'))).toBeUndefined();
  });

  it('offers nothing a host did not wire', () => {
    const { binding } = render({ getNotificationState: () => READY });
    expect(binding.rowStateFor?.(ONE)).toEqual({});
  });

  it('commands-disabled rows offer no pin or hide, but keep notifications', () => {
    const { binding } = render({
      isWorkspaceCommandDisabled: () => true,
      setWorktreePinned: jest.fn(),
      hideWorktree: jest.fn(),
      getNotificationState: () => READY,
      setNotificationChoice: jest.fn(),
    });
    expect(binding.rowStateFor?.(ONE)).toEqual({ notifications: READY });
  });

  it('offers no hide for a row whose host cannot persist visibility', () => {
    const { binding } = render({
      // A cloud Cowork task refuses `hidden` and reports no worktreeMetadata.
      capabilitiesOf: (localId) =>
        localId === 'wt-2'
          ? { ...capabilities, worktreeMetadata: false }
          : capabilities,
      hideWorktree: jest.fn(),
    });
    expect(binding.rowStateFor?.(ONE)).toEqual({ hideable: true });
    expect(binding.rowStateFor?.(TWO)).toEqual({});
  });

  it('drops notifications that can never load', () => {
    const { binding } = render({
      getNotificationState: () => ({
        status: 'failed',
        override: null,
        selectionKnown: false,
      }),
      setNotificationChoice: jest.fn(),
    });
    expect(binding.rowStateFor?.(ONE)).toEqual({});
  });

  it('runs each action through the host command for that row', () => {
    const setWorktreePinned = jest.fn();
    const hideWorktree = jest.fn();
    const setNotificationChoice = jest.fn();
    const { binding } = render({
      setWorktreePinned,
      hideWorktree,
      getNotificationState: () => READY,
      setNotificationChoice,
    });
    const target = binding.targetFor(TWO);
    if (target === undefined) throw new Error('Missing target');
    void binding.applyStateAction?.(target, { kind: 'pin', pinned: true });
    void binding.applyStateAction?.(target, { kind: 'hide' });
    void binding.applyStateAction?.(target, {
      kind: 'notifications',
      choice: 'mute',
    });
    void binding.applyStateAction?.(target, { kind: 'done', done: true });
    expect(setWorktreePinned).toHaveBeenCalledWith('ws', 'wt-2', true);
    expect(hideWorktree).toHaveBeenCalledWith('ws', 'wt-2');
    expect(setNotificationChoice).toHaveBeenCalledWith('ws', 'wt-2', 'mute');
  });

  it('requests only a choice that was never read', () => {
    const requestNotificationState = jest.fn();
    const states: Record<string, SpaceNotificationMenuState> = {
      'wt-1': { status: 'ready', override: null, selectionKnown: false },
      'wt-2': READY,
    };
    const { binding } = render({
      getNotificationState: (_ws, wt) => states[wt],
      setNotificationChoice: jest.fn(),
      requestNotificationState,
    });
    binding.requestRowState?.(ONE);
    binding.requestRowState?.(TWO);
    expect(requestNotificationState.mock.calls).toEqual([['ws', 'wt-1']]);
  });

  it('requests a never-read choice the host reports as loading', () => {
    // Web reports a space it has never read as loading before any read
    // starts; the host's own refresh skips a read already in flight.
    const requestNotificationState = jest.fn();
    const { binding } = render({
      getNotificationState: () => ({
        status: 'loading',
        override: null,
        selectionKnown: false,
      }),
      setNotificationChoice: jest.fn(),
      requestNotificationState,
    });
    binding.requestRowState?.(TWO);
    expect(requestNotificationState.mock.calls).toEqual([['ws', 'wt-2']]);
  });
});
