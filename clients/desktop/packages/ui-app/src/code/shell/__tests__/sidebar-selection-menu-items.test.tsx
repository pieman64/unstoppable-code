/** @jest-environment jsdom */
import type {
  SpaceNotificationMenuState,
  WorktreeMenuItem,
} from '@canopy/ui-shared/components';
import {
  batchActionAvailability,
  bulkStateActions,
  deriveSelectionMenuItems,
  rowNeedsStateAction,
  selectionToggleMenuItem,
  withSelectionGroupItems,
} from '../sidebar-selection-menu-items';

const CHATS = { singular: 'chat', plural: 'chats' };

describe('deriveSelectionMenuItems', () => {
  it('labels the bulk actions with the unit and leaves out an action no row offers', () => {
    const items = deriveSelectionMenuItems({
      count: 3,
      availability: {
        archive: { enabled: true },
        delete: { enabled: false, offered: false },
      },
      unitLabel: CHATS,
      onBulkRemoval: jest.fn(),
      onClearSelection: jest.fn(),
    });
    expect(items.map((item) => [item.key, item.label])).toEqual([
      ['bulk-archive', 'Archive 3 chats'],
      ['clear-selection', 'Clear selection'],
    ]);
  });

  it('disables with the reason when an action is offered but blocked', () => {
    const onBulkRemoval = jest.fn();
    const items = deriveSelectionMenuItems({
      count: 2,
      availability: {
        archive: { enabled: true },
        delete: {
          enabled: false,
          disabledReason: "Some selected chats can't be deleted",
        },
      },
      unitLabel: CHATS,
      onBulkRemoval,
    });
    const del = items.find((item) => item.key === 'bulk-delete');
    expect(del?.disabled).toBe(true);
    expect(del?.tooltip).toBe("Some selected chats can't be deleted");
    expect(items.some((item) => item.key === 'clear-selection')).toBe(false);
    items[0]?.onSelect?.();
    expect(onBulkRemoval).toHaveBeenCalledWith('archive');
  });
});

describe('batchActionAvailability', () => {
  it('names the unit in disabled reasons', () => {
    const availability = batchActionAvailability(
      [
        { removal: 'archive' },
        { removal: 'archive', retention: 'archive-or-delete' },
      ],
      CHATS,
    );
    expect(availability.delete).toEqual({
      enabled: false,
      disabledReason: "Some selected chats can't be deleted",
    });
    expect(
      batchActionAvailability(
        [{ removal: 'archive', commandsDisabled: true }],
        CHATS,
      ).archive.disabledReason,
    ).toBe("Some selected chats can't be changed right now");
  });
});

describe('selectionToggleMenuItem', () => {
  it('reads Select or Deselect with the platform shortcut', () => {
    expect(
      selectionToggleMenuItem({ multiSelected: false, onToggle: jest.fn() })
        .label,
    ).toBe('Select');
    const deselect = selectionToggleMenuItem({
      multiSelected: true,
      onToggle: jest.fn(),
    });
    expect(deselect.label).toBe('Deselect');
    expect(deselect.shortcut).toMatch(/^(⌘ Click|Ctrl Click)$/);
  });
});

const READY: SpaceNotificationMenuState = {
  status: 'ready',
  override: null,
  selectionKnown: true,
};

describe('bulkStateActions', () => {
  it('offers Pin while any row is unpinned and Unpin once all are pinned', () => {
    expect(bulkStateActions([{ pinned: true }, { pinned: false }]).pin).toEqual(
      {
        pinned: true,
      },
    );
    expect(bulkStateActions([{ pinned: true }, { pinned: true }]).pin).toEqual({
      pinned: false,
    });
  });

  it("leaves out an action one row's menu does not offer", () => {
    const actions = bulkStateActions([
      { pinned: false, done: false, hideable: true },
      { pinned: false },
    ]);
    expect(actions.pin).toEqual({ pinned: true });
    expect(actions.done).toBeUndefined();
    expect(actions.hide).toBeUndefined();
    expect(actions.notifications).toBeUndefined();
  });

  it('offers nothing for an empty selection or a row with no state', () => {
    expect(bulkStateActions([])).toEqual({});
    expect(bulkStateActions([{ pinned: true }, {}])).toEqual({});
  });

  it('checks a notification level only when every row shares it', () => {
    expect(
      bulkStateActions([
        { notifications: { ...READY, override: 'mute' } },
        { notifications: { ...READY, override: 'mute' } },
      ]).notifications,
    ).toEqual({ level: 'mute', loading: false });
    expect(
      bulkStateActions([
        { notifications: { ...READY, override: null } },
        { notifications: { ...READY, override: 'mute' } },
      ]).notifications,
    ).toEqual({ level: 'mixed', loading: false });
  });

  it('a row still loading disables the choices', () => {
    expect(
      bulkStateActions([
        { notifications: READY },
        {
          notifications: {
            status: 'loading',
            override: null,
            selectionKnown: false,
          },
        },
      ]).notifications,
    ).toEqual({ level: 'mixed', loading: true });
  });

  it('a settled row with no known choice gives its own reason, not Loading…', () => {
    // A space the server doesn't know: read, but with no choice to show.
    expect(
      bulkStateActions([
        { notifications: READY },
        {
          notifications: {
            status: 'ready',
            override: null,
            selectionKnown: false,
            disabledReason: 'Writes are closed',
          },
        },
      ]).notifications,
    ).toEqual({
      level: 'mixed',
      loading: false,
      disabledReason: 'Writes are closed',
    });
  });

  it('carries a read-only reason and drops the group when a row cannot load', () => {
    expect(
      bulkStateActions([
        { notifications: READY },
        { notifications: { ...READY, disabledReason: 'Sign in first' } },
      ]).notifications,
    ).toEqual({
      level: 'all',
      loading: false,
      disabledReason: 'Sign in first',
    });
    expect(
      bulkStateActions([
        { notifications: READY },
        {
          notifications: {
            status: 'failed',
            override: null,
            selectionKnown: false,
          },
        },
      ]).notifications,
    ).toBeUndefined();
  });

  it('a saving row keeps the level but blocks new choices', () => {
    expect(
      bulkStateActions([
        { notifications: READY },
        {
          notifications: { ...READY, status: 'saving', pendingChoice: 'mute' },
        },
      ]).notifications,
    ).toEqual({
      level: 'all',
      loading: false,
      disabledReason: 'A change is still saving',
    });
  });
});

describe('rowNeedsStateAction', () => {
  it('pins only the rows that need it', () => {
    const action = { kind: 'pin', pinned: true } as const;
    expect(rowNeedsStateAction({ pinned: false }, action)).toBe(true);
    expect(rowNeedsStateAction({ pinned: true }, action)).toBe(false);
    expect(rowNeedsStateAction({}, action)).toBe(false);
  });

  it('hides only rows that offer Hide', () => {
    expect(rowNeedsStateAction({ hideable: true }, { kind: 'hide' })).toBe(
      true,
    );
    expect(rowNeedsStateAction({ pinned: true }, { kind: 'hide' })).toBe(false);
  });

  it('treats All activity and a cleared override as the same level', () => {
    const action = { kind: 'notifications', choice: null } as const;
    expect(
      rowNeedsStateAction(
        { notifications: { ...READY, override: 'all' } },
        action,
      ),
    ).toBe(false);
    expect(
      rowNeedsStateAction(
        { notifications: { ...READY, override: 'mute' } },
        action,
      ),
    ).toBe(true);
  });
});

describe('deriveSelectionMenuItems with state actions', () => {
  it('orders Pin, Mark done, Notifications, Hide, then removal and Clear', () => {
    const onStateAction = jest.fn();
    const items = deriveSelectionMenuItems({
      count: 2,
      availability: {
        archive: { enabled: true },
        delete: { enabled: true },
      },
      unitLabel: CHATS,
      onBulkRemoval: jest.fn(),
      onClearSelection: jest.fn(),
      stateActions: {
        pin: { pinned: true },
        done: { done: false },
        hide: true,
        notifications: { level: 'mute', loading: false },
      },
      onStateAction,
      testIds: { bulkNotifications: 'n' },
    });
    expect(items.map((item) => [item.key, item.label])).toEqual([
      ['bulk-pin', 'Pin 2 chats'],
      ['bulk-done', 'Mark 2 chats active'],
      ['bulk-notifications', 'Notifications'],
      ['bulk-hide', 'Hide 2 chats'],
      ['bulk-archive', 'Archive 2 chats'],
      ['bulk-delete', 'Delete 2 chats'],
      ['clear-selection', 'Clear selection'],
    ]);
    expect(
      items.find((item) => item.key === 'bulk-hide')?.separatorBefore,
    ).toBe(true);
    expect(
      items.find((item) => item.key === 'bulk-archive')?.separatorBefore,
    ).toBeFalsy();
    const notifications = items.find(
      (item) => item.key === 'bulk-notifications',
    );
    const mute = notifications?.submenu?.find(
      (item) => item.key === 'bulk-notify-mute',
    );
    expect(mute?.checked).toBe(true);
    expect(mute?.onSelect).toBeUndefined();
    expect(mute?.testId).toBe('n-notify-mute');
    notifications?.submenu
      ?.find((item) => item.key === 'bulk-notify-attention')
      ?.onSelect?.();
    expect(onStateAction).toHaveBeenCalledWith({
      kind: 'notifications',
      choice: 'attention',
    });
    items[0]?.onSelect?.();
    expect(onStateAction).toHaveBeenCalledWith({ kind: 'pin', pinned: true });
  });

  it('disables every choice with Loading… while a row is loading', () => {
    const items = deriveSelectionMenuItems({
      count: 2,
      availability: { archive: { enabled: true }, delete: { enabled: true } },
      unitLabel: CHATS,
      onBulkRemoval: jest.fn(),
      stateActions: { notifications: { level: 'mixed', loading: true } },
      onStateAction: jest.fn(),
    });
    const submenu =
      items.find((item) => item.key === 'bulk-notifications')?.submenu ?? [];
    expect(submenu).toHaveLength(3);
    expect(submenu.every((item) => item.disabled === true)).toBe(true);
    expect(submenu.every((item) => item.tooltip === 'Loading…')).toBe(true);
    expect(submenu.some((item) => item.checked === true)).toBe(false);
  });

  it('separates removal from the state items when there is no Hide', () => {
    const items = deriveSelectionMenuItems({
      count: 2,
      availability: { archive: { enabled: true }, delete: { enabled: true } },
      unitLabel: CHATS,
      onBulkRemoval: jest.fn(),
      stateActions: { pin: { pinned: true } },
      onStateAction: jest.fn(),
    });
    expect(items.map((item) => item.key)).toEqual([
      'bulk-pin',
      'bulk-archive',
      'bulk-delete',
    ]);
    expect(items[1]?.separatorBefore).toBe(true);
    expect(items[2]?.separatorBefore).toBeFalsy();
  });

  it('Delete leads the removal group when Archive is not offered', () => {
    const items = deriveSelectionMenuItems({
      count: 2,
      availability: {
        archive: { enabled: false, offered: false },
        delete: { enabled: true },
      },
      unitLabel: CHATS,
      onBulkRemoval: jest.fn(),
      stateActions: { pin: { pinned: true } },
      onStateAction: jest.fn(),
    });
    expect(items.map((item) => item.key)).toEqual(['bulk-pin', 'bulk-delete']);
    expect(items[1]?.separatorBefore).toBe(true);
  });

  it('ignores state actions without a runner', () => {
    const items = deriveSelectionMenuItems({
      count: 2,
      availability: { archive: { enabled: true }, delete: { enabled: true } },
      unitLabel: CHATS,
      onBulkRemoval: jest.fn(),
      stateActions: { pin: { pinned: true }, hide: true },
    });
    expect(items.map((item) => item.key)).toEqual([
      'bulk-archive',
      'bulk-delete',
    ]);
  });
});

describe('withSelectionGroupItems', () => {
  const item = (
    key: 'bulk-pin' | 'bulk-archive' | 'sidebar-group-organize',
  ): WorktreeMenuItem => ({
    key,
    label: key,
    icon: null,
  });
  it('puts group items after Pin, or first when there is no Pin', () => {
    expect(
      withSelectionGroupItems(
        [item('bulk-pin'), item('bulk-archive')],
        [item('sidebar-group-organize')],
      ).map((entry) => entry.key),
    ).toEqual(['bulk-pin', 'sidebar-group-organize', 'bulk-archive']);
    expect(
      withSelectionGroupItems(
        [item('bulk-archive')],
        [item('sidebar-group-organize')],
      ).map((entry) => entry.key),
    ).toEqual(['sidebar-group-organize', 'bulk-archive']);
    expect(
      withSelectionGroupItems([item('bulk-archive')], []).map(
        (entry) => entry.key,
      ),
    ).toEqual(['bulk-archive']);
  });

  it('keeps the next group apart when the group items go first', () => {
    const groupItems = [item('sidebar-group-organize')];
    const derive = (hide: boolean): WorktreeMenuItem[] =>
      withSelectionGroupItems(
        deriveSelectionMenuItems({
          count: 2,
          availability: {
            archive: { enabled: true },
            delete: { enabled: true },
          },
          unitLabel: CHATS,
          onBulkRemoval: jest.fn(),
          stateActions: hide ? { hide: true } : {},
          onStateAction: jest.fn(),
        }),
        groupItems,
      );
    const separated = (items: readonly WorktreeMenuItem[]): string[] =>
      items
        .filter((entry) => entry.separatorBefore === true)
        .map((entry) => entry.key);
    expect(separated(derive(true))).toEqual(['bulk-hide']);
    expect(separated(derive(false))).toEqual(['bulk-archive']);
  });
});
