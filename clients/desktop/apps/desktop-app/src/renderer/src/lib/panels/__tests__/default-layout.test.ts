/** @jest-environment jsdom */

/**
 * CAN-2836 — the seeded default layout hides the right sidebar.
 *
 * `ensureDefaultWorktreeLayout` is the fallback builder used for a worktree
 * with no restorable persisted layout and no saved default, so it is the one
 * place the "new chat" default lives. The activity rail now seeds COLLAPSED
 * (collapsed-but-reopenable, exactly like the terminal group), while a
 * worktree that already has a layout keeps whatever rail state it is showing.
 */

import {
  makeWorktreePanelKey,
  usePanelLayoutStore,
} from '@/stores/panelLayoutStore';
import { useChatStore } from '@/stores/chatStore';
import { ensureDefaultWorktreeLayout } from '../default-layout';
import {
  DEFAULT_ACTIVITY_GROUP_ID,
  DEFAULT_ACTIVITY_PANEL_ID,
  DEFAULT_CHAT_GROUP_ID,
  DEFAULT_TERMINAL_GROUP_ID,
} from '../panel-group-ids';

const KEY = makeWorktreePanelKey('project-1', 'worktree-1');
/** Cowork keys its panel layouts by work-entry id in the worktreeId slot. */
const COWORK_KEY = makeWorktreePanelKey('cowork-workspace-1', 'entry-1');

function layoutFor(
  key: string,
): ReturnType<typeof usePanelLayoutStore.getState>['layouts'][string] {
  return usePanelLayoutStore.getState().layouts[key];
}

afterEach(() => {
  usePanelLayoutStore.getState().disposeLayout(KEY);
  usePanelLayoutStore.getState().disposeLayout(COWORK_KEY);
  useChatStore.setState({ worktreeChats: {} });
});

test('seeds the activity rail collapsed to the right edge', () => {
  ensureDefaultWorktreeLayout(KEY);

  const activity = layoutFor(KEY).groups[DEFAULT_ACTIVITY_GROUP_ID];
  expect(activity.collapsed?.edge).toBe('right');
});

test('a newly seeded cowork chat also starts with the rail collapsed', () => {
  // Cowork runs through the same seeder — no parallel layout path exists.
  ensureDefaultWorktreeLayout(COWORK_KEY);

  expect(
    layoutFor(COWORK_KEY).groups[DEFAULT_ACTIVITY_GROUP_ID].collapsed?.edge,
  ).toBe('right');
});

test('keeps the collapsed rail in the layout so the user can reopen it', () => {
  ensureDefaultWorktreeLayout(KEY);

  // Hidden means collapsed, not removed: the activity panel is still seeded
  // into the group, so the collapsed bar has something to reopen.
  const activity = layoutFor(KEY).groups[DEFAULT_ACTIVITY_GROUP_ID];
  expect(activity.tabs).toEqual([
    expect.objectContaining({
      panelId: DEFAULT_ACTIVITY_PANEL_ID,
      kind: 'activity-section',
    }),
  ]);

  expect(
    usePanelLayoutStore
      .getState()
      .expandGroup(KEY, DEFAULT_ACTIVITY_GROUP_ID, { focus: false }),
  ).toBe(true);
  expect(
    layoutFor(KEY).groups[DEFAULT_ACTIVITY_GROUP_ID].collapsed,
  ).toBeUndefined();
});

test('reopening the rail restores its default width', () => {
  ensureDefaultWorktreeLayout(KEY);

  // Collapsing at seed time (rather than seeding a narrow group) is what
  // records the rail's ~28% default as its expanded size.
  const collapsed = layoutFor(KEY).groups[DEFAULT_ACTIVITY_GROUP_ID].collapsed;
  expect(collapsed?.expandedSize).toBeGreaterThan(200);
});

test('still seeds the terminal group collapsed', () => {
  ensureDefaultWorktreeLayout(KEY);

  expect(
    layoutFor(KEY).groups[DEFAULT_TERMINAL_GROUP_ID].collapsed,
  ).toBeDefined();
  expect(layoutFor(KEY).activeGroupId).toBe(DEFAULT_CHAT_GROUP_ID);
});

test('marks the seeded rail collapse as auto so it can reopen itself', () => {
  ensureDefaultWorktreeLayout(KEY);

  expect(layoutFor(KEY).groups[DEFAULT_ACTIVITY_GROUP_ID].collapsed?.auto).toBe(
    true,
  );
});

test('does not mark the seeded terminal collapse as auto', () => {
  // The terminal is deliberately out of scope: only the activity rail reopens
  // itself when the worktree produces work.
  ensureDefaultWorktreeLayout(KEY);

  expect(
    layoutFor(KEY).groups[DEFAULT_TERMINAL_GROUP_ID].collapsed?.auto,
  ).toBeUndefined();
});

test('a collapse the user performs by hand carries no auto flag', () => {
  ensureDefaultWorktreeLayout(KEY);
  const store = usePanelLayoutStore.getState();
  store.expandGroup(KEY, DEFAULT_ACTIVITY_GROUP_ID, { focus: false });

  // The user re-collapsing the rail spends nothing and grants nothing: the
  // fresh descriptor has no `auto`, so the rail stays shut forever.
  expect(store.collapseGroup(KEY, DEFAULT_ACTIVITY_GROUP_ID)).toBe(true);

  const collapsed = layoutFor(KEY).groups[DEFAULT_ACTIVITY_GROUP_ID].collapsed;
  expect(collapsed?.edge).toBe('right');
  expect(collapsed?.auto).toBeUndefined();
});

test('a rail the user opened themselves is not re-collapsed', () => {
  // A new chat tab inside an existing worktree re-enters the seeder, which
  // no-ops because the worktree already has a layout. The user's own choice
  // therefore survives.
  ensureDefaultWorktreeLayout(KEY);
  usePanelLayoutStore
    .getState()
    .expandGroup(KEY, DEFAULT_ACTIVITY_GROUP_ID, { focus: false });

  ensureDefaultWorktreeLayout(KEY);

  expect(
    layoutFor(KEY).groups[DEFAULT_ACTIVITY_GROUP_ID].collapsed,
  ).toBeUndefined();
});
