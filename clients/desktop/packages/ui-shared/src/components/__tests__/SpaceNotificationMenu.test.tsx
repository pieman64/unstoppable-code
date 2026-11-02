/** @jest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { LoadingIndicatorStyleProvider } from '../LoadingIndicatorStyle';
import {
  SPACE_NOTIFICATION_MENU_COPY,
  SpaceNotificationMenuStatusLine,
  isSpaceNotificationMuted,
  spaceNotificationMenuChoices,
  spaceNotificationMenuStatus,
  spaceNotificationMenuUnavailable,
  type SpaceNotificationMenuState,
} from '../SpaceNotificationMenu';
import { WorkEntryRowMenuItems } from '../WorkEntryRow';
import {
  WorktreeActionsMenu,
  type WorktreeMenuItem,
} from '../WorktreeActionsMenu';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const ready: SpaceNotificationMenuState = {
  status: 'ready',
  override: null,
};

describe('SpaceNotificationMenuStatusLine while loading', () => {
  const loading = spaceNotificationMenuStatus({ ...ready, status: 'loading' });

  it('shows the loading copy by default', () => {
    expect(loading).toEqual({
      tone: 'default',
      text: 'Loading…',
      loading: true,
    });
    if (!loading) throw new Error('expected a status');
    const markup = renderToStaticMarkup(
      <SpaceNotificationMenuStatusLine status={loading} />,
    );
    expect(markup).toContain('Loading…');
    expect(markup).not.toContain('aria-label="Loading"');
  });

  it('shows a spinner in place of the copy under the spinner style', () => {
    if (!loading) throw new Error('expected a status');
    const markup = renderToStaticMarkup(
      <LoadingIndicatorStyleProvider value="spinner">
        <SpaceNotificationMenuStatusLine status={loading} />
      </LoadingIndicatorStyleProvider>,
    );
    expect(markup).toContain('aria-label="Loading"');
    expect(markup).not.toContain('Loading…');
  });
});

describe('spaceNotificationMenuChoices', () => {
  it('lists the three choices in order with All activity checked by default', () => {
    expect(
      spaceNotificationMenuChoices(ready).map((row) => [
        row.key,
        row.label,
        row.checked,
        row.disabled,
      ]),
    ).toEqual([
      ['notify-all', 'All activity', true, false],
      ['notify-attention', 'Needs my attention', false, false],
      ['notify-mute', 'Mute', false, false],
    ]);
  });

  it('saves All activity as no override', () => {
    const rows = spaceNotificationMenuChoices({ ...ready, override: 'mute' });
    expect(rows.find((row) => row.key === 'notify-all')?.choice).toBeNull();
  });

  it('checks All activity for an explicitly saved all', () => {
    const rows = spaceNotificationMenuChoices({ ...ready, override: 'all' });
    expect(rows.filter((row) => row.checked).map((row) => row.key)).toEqual([
      'notify-all',
    ]);
  });

  it('shows the acknowledged choice, not the pending one, while saving', () => {
    const rows = spaceNotificationMenuChoices({
      status: 'saving',
      override: 'attention',
      pendingChoice: 'mute',
    });
    expect(rows.filter((row) => row.checked).map((row) => row.key)).toEqual([
      'notify-attention',
    ]);
    expect(rows.filter((row) => row.pending).map((row) => row.key)).toEqual([
      'notify-mute',
    ]);
  });

  it('keeps the menu steady while saving: no greyed rows and no status line', () => {
    const state: SpaceNotificationMenuState = {
      status: 'saving',
      override: null,
      pendingChoice: 'attention',
    };
    const rows = spaceNotificationMenuChoices(state);
    // Disabled rows change ink and a status row changes the menu height, so
    // either one makes the menu flicker on every change.
    expect(rows.some((row) => row.disabled)).toBe(false);
    expect(spaceNotificationMenuStatus(state)).toBeUndefined();
    // No second save starts while one is in flight.
    expect(rows.some((row) => row.selectable)).toBe(false);
  });

  it('marks All activity pending for a save that clears the override', () => {
    const rows = spaceNotificationMenuChoices({
      status: 'saving',
      override: 'mute',
      pendingChoice: null,
    });
    expect(rows.find((row) => row.pending)?.key).toBe('notify-all');
  });

  it('only offers unchecked, enabled rows for selection when settled', () => {
    expect(
      spaceNotificationMenuChoices(ready).map((row) => row.selectable),
    ).toEqual([false, true, true]);
  });

  it('selects nothing and disables everything while loading', () => {
    const rows = spaceNotificationMenuChoices({ ...ready, status: 'loading' });
    expect(rows.some((row) => row.checked)).toBe(false);
    expect(rows.every((row) => row.disabled)).toBe(true);
  });

  it('shows the saved choice but disables changes with a reason', () => {
    const state: SpaceNotificationMenuState = {
      ...ready,
      override: 'mute',
      disabledReason: 'Changing this isn’t available yet',
    };
    const rows = spaceNotificationMenuChoices(state);
    expect(rows.find((row) => row.checked)?.key).toBe('notify-mute');
    expect(rows.every((row) => row.disabled)).toBe(true);
    expect(spaceNotificationMenuStatus(state)).toEqual({
      tone: 'default',
      text: 'Changing this isn’t available yet',
    });
  });

  it('reports a failure ahead of a disabled reason, and nothing when idle', () => {
    expect(spaceNotificationMenuStatus(ready)).toBeUndefined();
    expect(
      spaceNotificationMenuStatus({
        ...ready,
        status: 'failed',
        failure: 'Couldn’t save. Try again.',
        disabledReason: 'x',
      }),
    ).toEqual({ tone: 'failure', text: 'Couldn’t save. Try again.' });
  });
});

describe('spaceNotificationMenuUnavailable', () => {
  it('is true only for a failed first read', () => {
    expect(
      spaceNotificationMenuUnavailable({
        status: 'failed',
        override: null,
        selectionKnown: false,
      }),
    ).toBe(true);
    // A known choice whose save failed still shows the group and its error.
    expect(
      spaceNotificationMenuUnavailable({
        status: 'failed',
        override: 'mute',
        selectionKnown: true,
      }),
    ).toBe(false);
    expect(
      spaceNotificationMenuUnavailable({
        status: 'loading',
        override: null,
        selectionKnown: false,
      }),
    ).toBe(false);
  });

  it('keeps the load failure to one short line', () => {
    expect(SPACE_NOTIFICATION_MENU_COPY.loadFailed).toBe(
      'Couldn’t load notifications.',
    );
  });
});

describe('notification choices in menus', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
  });

  const byTestId = (id: string): HTMLElement | null =>
    document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

  it.each(['click', 'Enter', ' ', 'ArrowDown', 'ArrowUp'])(
    'opens notification-only loading and read-only menus via %s',
    (opening) => {
      const onOpen = jest.fn();
      const onSelect = jest.fn();
      const states: SpaceNotificationMenuState[] = [
        { ...ready, status: 'loading' },
        { ...ready, disabledReason: 'Changing this isn’t available yet' },
      ];
      for (const state of states) {
        const items: WorktreeMenuItem[] = spaceNotificationMenuChoices(
          state,
        ).map((choice, index) => ({
          ...choice,
          icon: null,
          role: 'menuitemradio',
          onSelect,
          testId: choice.key,
          sectionLabel: index === 0 ? 'Notifications' : undefined,
          sectionStatus:
            index === 2 ? spaceNotificationMenuStatus(state) : undefined,
          sectionStatusTestId: 'status',
        }));
        act(() =>
          root.render(
            <WorktreeActionsMenu
              accessibleLabel="Actions"
              triggerTestId="trigger"
              menuTestId="menu"
              onOpen={onOpen}
              items={items}
            />,
          ),
        );
        const trigger = byTestId('trigger');
        act(() => trigger?.focus());
        act(() => {
          if (opening === 'click') trigger?.click();
          else
            trigger?.dispatchEvent(
              new KeyboardEvent('keydown', { key: opening, bubbles: true }),
            );
        });
        const menu = byTestId('menu');
        expect(menu).not.toBeNull();
        expect(document.activeElement).toBe(menu);
        expect(byTestId('status')?.textContent).toBe(
          state.status === 'loading'
            ? 'Loading…'
            : 'Changing this isn’t available yet',
        );
        expect(
          menu?.querySelectorAll('[role="menuitemradio"]:disabled').length,
        ).toBe(3);
        act(() => {
          menu?.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
          );
        });
        expect(onSelect).not.toHaveBeenCalled();
        act(() => {
          menu?.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
          );
        });
        expect(byTestId('menu')).toBeNull();
        expect(document.activeElement).toBe(trigger);
      }
      expect(onOpen).toHaveBeenCalledTimes(2);
    },
  );

  it('renders Work Entry choices as radios and keeps the menu open on select', () => {
    const close = jest.fn();
    const onNotificationChoice = jest.fn();
    act(() =>
      root.render(
        <WorkEntryRowMenuItems
          menu={{
            close,
            testIdFor: (suffix: string): string => `entry${suffix}`,
          }}
          onRename={(): void => undefined}
          notifications={{ ...ready, override: 'attention' }}
          onNotificationChoice={onNotificationChoice}
        />,
      ),
    );
    expect(byTestId('entry-notify')?.getAttribute('role')).toBe('group');
    expect(byTestId('entry-notify')?.getAttribute('aria-label')).toBe(
      'Notifications',
    );
    const attention = byTestId('entry-notify-attention');
    expect(attention?.getAttribute('role')).toBe('menuitemradio');
    expect(attention?.getAttribute('aria-checked')).toBe('true');
    expect(byTestId('entry-notify-all')?.getAttribute('aria-checked')).toBe(
      'false',
    );
    act(() => byTestId('entry-notify-mute')?.click());
    expect(onNotificationChoice).toHaveBeenCalledWith('mute');
    act(() => byTestId('entry-notify-all')?.click());
    expect(onNotificationChoice).toHaveBeenLastCalledWith(null);
    // Re-selecting the current choice is not a save.
    act(() => attention?.click());
    expect(onNotificationChoice).toHaveBeenCalledTimes(2);
    expect(close).not.toHaveBeenCalled();
  });

  it('folds Work Entry choices into a Notifications submenu on request', () => {
    const close = jest.fn();
    const onNotificationChoice = jest.fn();
    act(() =>
      root.render(
        <WorkEntryRowMenuItems
          menu={{
            close,
            testIdFor: (suffix: string): string => `entry${suffix}`,
          }}
          onRename={(): void => undefined}
          notifications={{ ...ready, override: 'attention' }}
          notificationsPresentation="submenu"
          onNotificationChoice={onNotificationChoice}
        />,
      ),
    );
    // One row among the others: no choices and no heading until it opens.
    const trigger = byTestId('entry-notify-submenu');
    expect(trigger?.textContent).toBe('Notifications');
    expect(byTestId('entry-notify-mute')).toBeNull();
    act(() => trigger?.click());
    expect(byTestId('entry-notify')?.textContent).toBe(
      'All activityNeeds my attentionMute',
    );
    expect(
      byTestId('entry-notify-attention')?.getAttribute('aria-checked'),
    ).toBe('true');
    act(() => byTestId('entry-notify-mute')?.click());
    expect(onNotificationChoice).toHaveBeenCalledWith('mute');
    // The flyout and the menu stay open to show the outcome.
    expect(byTestId('entry-notify-mute')).not.toBeNull();
    expect(close).not.toHaveBeenCalled();
  });

  it('checks, saves and reports status for choices inside a worktree submenu', () => {
    const onSelect = jest.fn();
    const state: SpaceNotificationMenuState = {
      ...ready,
      override: 'mute',
      status: 'failed',
      selectionKnown: true,
    };
    const choices: WorktreeMenuItem[] = spaceNotificationMenuChoices(state).map(
      (choice, index) => ({
        ...choice,
        icon: null,
        role: 'menuitemradio',
        onSelect,
        testId: choice.key,
        sectionStatus:
          index === 2 ? spaceNotificationMenuStatus(state) : undefined,
        sectionStatusTestId: 'status',
      }),
    );
    act(() =>
      root.render(
        <WorktreeActionsMenu
          accessibleLabel="Actions"
          triggerTestId="trigger"
          menuTestId="menu"
          items={[
            {
              key: 'notifications',
              kind: 'submenu',
              label: 'Notifications',
              icon: null,
              submenu: choices,
            },
          ]}
        />,
      ),
    );
    act(() => byTestId('trigger')?.click());
    act(() => byTestId('notifications')?.click());
    expect(byTestId('notify-mute')?.getAttribute('role')).toBe('menuitemradio');
    expect(byTestId('notify-mute')?.getAttribute('aria-checked')).toBe('true');
    expect(byTestId('status')?.textContent).toBe(
      SPACE_NOTIFICATION_MENU_COPY.saveFailed,
    );
    act(() => byTestId('notify-attention')?.click());
    expect(onSelect).toHaveBeenCalledTimes(1);
    // A choice keeps both menus open so its outcome shows where it was made.
    expect(byTestId('menu')).not.toBeNull();
    expect(byTestId('notify-attention')).not.toBeNull();
  });

  it('omits the Work Entry group when the choice never loaded', () => {
    act(() =>
      root.render(
        <WorkEntryRowMenuItems
          menu={{
            close: jest.fn(),
            testIdFor: (suffix: string): string => `entry${suffix}`,
          }}
          notifications={{
            status: 'failed',
            override: null,
            selectionKnown: false,
            failure: SPACE_NOTIFICATION_MENU_COPY.loadFailed,
          }}
          onNotificationChoice={jest.fn()}
        />,
      ),
    );
    expect(byTestId('entry-notify')).toBeNull();
    expect(byTestId('entry-notify-all')).toBeNull();
  });

  it('keeps Work Entry rows steady while a save is in flight', () => {
    const onNotificationChoice = jest.fn();
    act(() =>
      root.render(
        <WorkEntryRowMenuItems
          menu={{
            close: jest.fn(),
            testIdFor: (suffix: string): string => `entry${suffix}`,
          }}
          notifications={{
            status: 'saving',
            override: null,
            pendingChoice: 'mute',
          }}
          onNotificationChoice={onNotificationChoice}
        />,
      ),
    );
    const mute = byTestId('entry-notify-mute');
    expect(mute?.hasAttribute('disabled')).toBe(false);
    expect(mute?.getAttribute('aria-checked')).toBe('false');
    expect(mute?.querySelector('.animate-loading-dot')).not.toBeNull();
    expect(mute?.getAttribute('aria-busy')).toBe('true');
    expect(byTestId('entry-notify-all')?.hasAttribute('aria-busy')).toBe(false);
    expect(byTestId('entry-notify-all')?.getAttribute('aria-checked')).toBe(
      'true',
    );
    expect(byTestId('entry-notify-status')).toBeNull();
    act(() => byTestId('entry-notify-attention')?.click());
    expect(onNotificationChoice).not.toHaveBeenCalled();
  });

  it('announces a Work Entry save failure and omits the group unwired', () => {
    act(() =>
      root.render(
        <WorkEntryRowMenuItems
          menu={{
            close: jest.fn(),
            testIdFor: (suffix: string): string => `entry${suffix}`,
          }}
          notifications={{ ...ready, status: 'failed', failure: 'Nope' }}
          onNotificationChoice={jest.fn()}
        />,
      ),
    );
    const status = byTestId('entry-notify-status');
    expect(status?.getAttribute('role')).toBe('alert');
    expect(status?.textContent).toBe('Nope');
    act(() =>
      root.render(
        <WorkEntryRowMenuItems
          menu={{ close: jest.fn(), testIdFor: (): string => 'x' }}
          onRename={(): void => undefined}
          notifications={ready}
        />,
      ),
    );
    expect(document.querySelector('[role="menuitemradio"]')).toBeNull();
  });

  it('reads on open and keeps the worktree menu open for a radio choice', () => {
    const onOpen = jest.fn();
    const onSelect = jest.fn();
    act(() =>
      root.render(
        <WorktreeActionsMenu
          accessibleLabel="Actions"
          triggerTestId="trigger"
          menuTestId="menu"
          onOpen={onOpen}
          items={[
            {
              key: 'notify-all',
              label: 'All activity',
              icon: null,
              role: 'menuitemradio',
              checked: true,
              sectionLabel: 'Notifications',
              testId: 'all',
            },
            {
              key: 'notify-mute',
              label: 'Mute',
              icon: null,
              role: 'menuitemradio',
              checked: false,
              onSelect,
              sectionStatus: { tone: 'failure', text: 'Nope' },
              sectionStatusTestId: 'status',
              testId: 'mute',
              busy: true,
            },
          ]}
        />,
      ),
    );
    expect(onOpen).not.toHaveBeenCalled();
    act(() => byTestId('trigger')?.click());
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(byTestId('menu')?.textContent).toContain('Notifications');
    expect(byTestId('all')?.getAttribute('aria-checked')).toBe('true');
    expect(byTestId('all')?.hasAttribute('aria-busy')).toBe(false);
    expect(byTestId('mute')?.getAttribute('aria-busy')).toBe('true');
    expect(byTestId('mute')?.getAttribute('aria-checked')).toBe('false');
    expect(byTestId('status')?.getAttribute('role')).toBe('alert');
    act(() => byTestId('mute')?.click());
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(byTestId('menu')).not.toBeNull();
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

describe('isSpaceNotificationMuted', () => {
  test('true only for a known, acknowledged Mute', () => {
    expect(isSpaceNotificationMuted({ ...ready, override: 'mute' })).toBe(true);
    expect(
      isSpaceNotificationMuted({
        ...ready,
        override: 'mute',
        selectionKnown: true,
      }),
    ).toBe(true);
  });

  test('an acknowledged Mute stays muted while a save away from it runs', () => {
    expect(
      isSpaceNotificationMuted({
        status: 'saving',
        override: 'mute',
        pendingChoice: null,
      }),
    ).toBe(true);
  });

  test('false while unknown, saving toward Mute, or not muted', () => {
    expect(isSpaceNotificationMuted(undefined)).toBe(false);
    expect(
      isSpaceNotificationMuted({ status: 'loading', override: 'mute' }),
    ).toBe(false);
    expect(
      isSpaceNotificationMuted({
        status: 'failed',
        override: 'mute',
        selectionKnown: false,
      }),
    ).toBe(false);
    expect(
      isSpaceNotificationMuted({
        status: 'saving',
        override: null,
        pendingChoice: 'mute',
      }),
    ).toBe(false);
    expect(isSpaceNotificationMuted({ ...ready, override: 'attention' })).toBe(
      false,
    );
    expect(isSpaceNotificationMuted({ ...ready, override: 'all' })).toBe(false);
    expect(isSpaceNotificationMuted(ready)).toBe(false);
  });
});
