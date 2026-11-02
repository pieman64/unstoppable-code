/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CanopyCapabilities } from '@canopy/app-core';
import type { SidebarItemGroup } from '@canopy/protocol/sidebar';
import {
  SidebarSurface,
  type SidebarSurfaceProps,
  type SidebarSurfaceSnapshot,
} from '../SidebarSurface';

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
};

function chatsSnapshot(
  entryIds: readonly string[] = ['a', 'b', 'c'],
  itemGroups: readonly SidebarItemGroup[] = [],
): SidebarSurfaceSnapshot {
  return {
    workspaces: [
      {
        localId: 'cowork-default',
        name: 'Chats',
        type: 'cowork',
        layout: 'flat',
        chatsHome: true,
        itemGroups: [...itemGroups],
      },
    ],
    worktrees: [],
    standaloneChats: entryIds.map((id, order) => ({
      localId: `chat-${id}`,
      projectLocalId: 'cowork-default',
      workEntryId: id,
      title: `Chat ${id}`,
      order,
      workEntryLastMessageAt: `2026-01-0${order + 1}T00:00:00.000Z`,
    })),
  };
}

describe('SidebarSurface Work Entry bulk selection (CAN-3975)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(
    props: Partial<SidebarSurfaceProps> = {},
    snapshot: SidebarSurfaceSnapshot = chatsSnapshot(),
  ): void {
    act(() => {
      root.render(
        <SidebarSurface
          variant="rail"
          snapshot={snapshot}
          selection={{ kind: 'workspace', workspaceLocalId: 'cowork-default' }}
          capabilities={capabilities}
          contentState="ready"
          onSelect={() => undefined}
          {...props}
        />,
      );
    });
  }

  async function flush(): Promise<void> {
    for (let index = 0; index < 4; index += 1) {
      await act(async () => {
        await Promise.resolve();
      });
    }
  }

  function row(id: string): HTMLElement {
    const element = container.querySelector<HTMLElement>(
      `[data-testid="portal-chats-work-entry-${id}"]`,
    );
    if (!element) throw new Error(`Missing row ${id}`);
    return element;
  }

  function maybeRow(id: string): HTMLElement | null {
    return container.querySelector<HTMLElement>(
      `[data-testid="portal-chats-work-entry-${id}"]`,
    );
  }

  function selected(id: string): boolean {
    return maybeRow(id)?.getAttribute('data-multiselected') === 'true';
  }

  function click(element: HTMLElement, init: MouseEventInit = {}): void {
    act(() => {
      element.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, ...init }),
      );
    });
  }

  /** Cmd-click on macOS, Ctrl-click elsewhere: both set, either platform. */
  function toggle(id: string): void {
    click(row(id), { metaKey: true, ctrlKey: true });
  }

  function openMenu(element: HTMLElement): void {
    act(() => {
      element.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
      );
    });
  }

  function byTestId(testId: string): HTMLElement | null {
    return document.body.querySelector<HTMLElement>(
      `[data-testid="${testId}"]`,
    );
  }

  function key(element: HTMLElement, init: KeyboardEventInit): void {
    act(() => {
      element.dispatchEvent(
        new KeyboardEvent('keydown', {
          bubbles: true,
          cancelable: true,
          ...init,
        }),
      );
    });
  }

  const wired = (
    over: Partial<SidebarSurfaceProps> = {},
  ): Partial<SidebarSurfaceProps> => ({
    onRemoveWorkEntryInBatch: jest.fn(() => Promise.resolve()),
    getWorkEntryBatchRemovalFacts: () => ({}),
    ...over,
  });

  it('offers no Select item and no tint without a host removal', () => {
    render();
    toggle('a');
    expect(selected('a')).toBe(false);
    openMenu(row('a'));
    expect(byTestId('portal-chats-work-entry-a-toggle-selection')).toBeNull();
  });

  it('selects, menus, confirms, and runs the host removal in order', async () => {
    const remove = jest.fn(() => Promise.resolve());
    render(wired({ onRemoveWorkEntryInBatch: remove }));
    toggle('a');
    toggle('b');
    expect(selected('a')).toBe(true);
    expect(selected('b')).toBe(true);
    openMenu(row('a'));
    const archive = byTestId('portal-chats-work-entry-a-bulk-archive');
    expect(archive?.textContent).toContain('Archive 2 chats');
    if (archive === null) throw new Error('Missing bulk archive');
    click(archive);
    await flush();
    const dialog = byTestId('work-entry-batch-removal-dialog');
    expect(dialog?.textContent).toContain('Archive 2 chats?');
    const confirm = byTestId('work-entry-batch-removal-dialog-confirm');
    if (confirm === null) throw new Error('Missing confirm');
    click(confirm);
    await flush();
    expect(remove.mock.calls).toEqual([
      ['cowork-default', 'a', { mode: 'archive' }],
      ['cowork-default', 'b', { mode: 'archive' }],
    ]);
    expect(selected('a')).toBe(false);
    expect(byTestId('work-entry-batch-removal-dialog')).toBeNull();
  });

  it('offers Select on one row through its menu', () => {
    render(wired());
    openMenu(row('a'));
    const item = byTestId('portal-chats-work-entry-a-toggle-selection');
    expect(item?.textContent).toContain('Select');
    if (item === null) throw new Error('Missing Select');
    click(item);
    expect(selected('a')).toBe(true);
  });

  it('keyboard: x toggles and Escape clears', () => {
    render(wired());
    key(row('a'), { key: 'x' });
    expect(selected('a')).toBe(true);
    key(row('a'), { key: 'Escape' });
    expect(selected('a')).toBe(false);
  });

  it('a plain click opens the entry and ends the selection', () => {
    const onSelect = jest.fn();
    render(wired({ onSelect }));
    toggle('a');
    click(row('b'));
    expect(selected('a')).toBe(false);
    expect(onSelect).toHaveBeenCalledWith({
      kind: 'standalone-chat',
      standaloneChatId: 'chat-b',
    });
  });

  it("a collapsed group's rows are not in a range", () => {
    render(
      wired(),
      chatsSnapshot(
        ['a', 'b', 'c'],
        [
          {
            id: 'grp',
            name: 'Later',
            color: 'neutral',
            collapsed: true,
            memberIds: ['b'],
          },
        ],
      ),
    );
    expect(maybeRow('b')).toBeNull();
    toggle('a');
    click(row('c'), { shiftKey: true });
    expect(selected('a')).toBe(true);
    expect(selected('c')).toBe(true);
    expect(maybeRow('b')).toBeNull();
  });

  it("a collapsed grouped section's selected row stays selectable", () => {
    render(
      wired({
        chatsSectionCollapsed: true,
        selection: { kind: 'standalone-chat', standaloneChatId: 'chat-a' },
      }),
      chatsSnapshot(
        ['a', 'b', 'c'],
        [
          {
            id: 'grp',
            name: 'Later',
            color: 'neutral',
            collapsed: false,
            memberIds: ['c'],
          },
        ],
      ),
    );
    expect(maybeRow('b')).toBeNull();
    toggle('a');
    expect(selected('a')).toBe(true);
  });

  it('a removed entry leaves the selection', () => {
    render(wired());
    toggle('a');
    toggle('b');
    render(wired(), chatsSnapshot(['a', 'c']));
    expect(selected('a')).toBe(true);
    toggle('c');
    expect(selected('a')).toBe(true);
    expect(selected('c')).toBe(true);
  });

  it('reports the dialog state', async () => {
    const onWorkEntryBatchRemovalStateChange = jest.fn();
    render(wired({ onWorkEntryBatchRemovalStateChange }));
    toggle('a');
    toggle('b');
    openMenu(row('a'));
    const archive = byTestId('portal-chats-work-entry-a-bulk-archive');
    if (archive === null) throw new Error('Missing bulk archive');
    click(archive);
    await flush();
    expect(onWorkEntryBatchRemovalStateChange).toHaveBeenNthCalledWith(1, {
      open: true,
      mode: 'archive',
      count: 2,
      phase: 'confirm',
    });
    const confirm = byTestId('work-entry-batch-removal-dialog-confirm');
    if (confirm === null) throw new Error('Missing confirm');
    click(confirm);
    await flush();
    expect(onWorkEntryBatchRemovalStateChange).toHaveBeenLastCalledWith(null);
  });

  it('selecting a worktree replaces a chat selection, and the reverse', () => {
    const base = chatsSnapshot();
    const snapshot = {
      ...base,
      workspaces: [
        ...base.workspaces,
        { localId: 'repo', name: 'Repo', type: 'single-repo' as const },
      ],
      worktrees: [
        {
          localId: 'w1',
          workspaceLocalId: 'repo',
          branch: 'w1-branch',
          order: 0,
        },
      ],
    };
    render(
      wired({ onRemoveWorktreeInBatch: jest.fn(() => Promise.resolve()) }),
      snapshot,
    );
    const worktreeFrame = (): HTMLElement => {
      const frame = container
        .querySelector('[data-worktree-id="w1"]')
        ?.closest<HTMLElement>('[data-sidebar-variant="bare"]');
      if (!frame) throw new Error('Missing worktree row');
      return frame;
    };
    const worktreeSelected = (): boolean =>
      container
        .querySelector('[data-worktree-id="w1"]')
        ?.getAttribute('data-multiselected') === 'true';
    toggle('a');
    toggle('b');
    click(worktreeFrame(), { metaKey: true, ctrlKey: true });
    expect(worktreeSelected()).toBe(true);
    expect(selected('a')).toBe(false);
    expect(selected('b')).toBe(false);
    toggle('c');
    expect(selected('c')).toBe(true);
    expect(worktreeSelected()).toBe(false);
  });

  it('pins and marks a selection through the host commands, in rail order', async () => {
    const onSetWorkEntryPinned = jest.fn(() => Promise.resolve());
    const onSetWorkEntryStatus = jest.fn(() => Promise.resolve());
    render(
      wired({
        getWorkEntryBulkState: () => ({ pinned: false, done: false }),
        onSetWorkEntryPinned,
        onSetWorkEntryStatus,
      }),
    );
    toggle('a');
    toggle('b');
    openMenu(row('a'));
    const pin = byTestId('portal-chats-work-entry-a-bulk-pin');
    expect(pin?.textContent).toContain('Pin 2 chats');
    const done = byTestId('portal-chats-work-entry-a-bulk-done');
    expect(done?.textContent).toContain('Mark 2 chats done');
    if (done === null) throw new Error('Missing bulk done');
    click(done);
    await flush();
    expect(onSetWorkEntryStatus.mock.calls).toEqual([
      ['cowork-default', 'a', 'done'],
      ['cowork-default', 'b', 'done'],
    ]);
    expect(onSetWorkEntryPinned).not.toHaveBeenCalled();
  });

  it('offers no Pin or Mark without the host commands', () => {
    render(wired());
    toggle('a');
    toggle('b');
    openMenu(row('a'));
    expect(byTestId('portal-chats-work-entry-a-bulk-archive')).not.toBeNull();
    expect(byTestId('portal-chats-work-entry-a-bulk-pin')).toBeNull();
    expect(byTestId('portal-chats-work-entry-a-bulk-done')).toBeNull();
  });
});
