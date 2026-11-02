/** @jest-environment jsdom */

import {
  makeWorktreePanelKey,
  usePanelLayoutStore,
  type WorktreePanelLayout,
} from '@/stores/panelLayoutStore';
import type { PanelKind } from '@canopy/protocol';
import {
  CHAT_SIBLING_CONTENT_KINDS,
  createChatSiblingGroupToRight,
  pickReusableChatSiblingGroupId,
  resolveChatPanelAnchor,
  rollbackCreatedChatSiblingGroup,
} from '../sibling-panel-placement';

const KEY = makeWorktreePanelKey('project-1', 'worktree-1');

afterEach(() => {
  usePanelLayoutStore.getState().disposeLayout(KEY);
});

test('does not collapse a full-height right rail that hosts a chat', () => {
  const store = usePanelLayoutStore.getState();
  store.initializeLayout(KEY, {
    orientation: 'horizontal',
    groups: [
      { kind: 'chat', groupId: 'group-origin', panelId: 'panel-origin' },
      { kind: 'chat', groupId: 'group-right', panelId: 'panel-right' },
    ],
    containerSize: { width: 1200, height: 800 },
  });

  const created = createChatSiblingGroupToRight(KEY, 'group-origin');

  expect(created).not.toBeNull();
  expect(created?.collapsedGroupId).toBeNull();
  expect(
    usePanelLayoutStore.getState().layouts[KEY].groups['group-right'].collapsed,
  ).toBeUndefined();
});

test('collapses the right rail when creating a sibling from a maximized chat', () => {
  const store = usePanelLayoutStore.getState();
  store.initializeLayout(KEY, {
    orientation: 'horizontal',
    groups: [
      { kind: 'chat', groupId: 'group-origin', panelId: 'panel-origin' },
      { kind: 'file-diff', groupId: 'group-right', panelId: 'panel-right' },
    ],
    containerSize: { width: 1200, height: 800 },
  });
  store.maximizeGroup(KEY, 'group-origin', true);

  const created = createChatSiblingGroupToRight(KEY, 'group-origin');

  expect(created).not.toBeNull();
  expect(created?.collapsedGroupId).toBe('group-right');
  expect(created?.previouslyMaximizedGroupId).toBe('group-origin');
  const layout = usePanelLayoutStore.getState().layouts[KEY];
  expect(layout.maximizedGroupId).toBeNull();
  expect(layout.groups['group-right'].collapsed).toBeDefined();
});

test('restores maximize and rail state when maximized sibling placement rolls back', () => {
  const store = usePanelLayoutStore.getState();
  store.initializeLayout(KEY, {
    orientation: 'horizontal',
    groups: [
      { kind: 'chat', groupId: 'group-origin', panelId: 'panel-origin' },
      { kind: 'file-diff', groupId: 'group-right', panelId: 'panel-right' },
    ],
    containerSize: { width: 1200, height: 800 },
  });
  store.maximizeGroup(KEY, 'group-origin', true);
  const created = createChatSiblingGroupToRight(KEY, 'group-origin');
  expect(created).not.toBeNull();
  if (created === null) {
    throw new Error('Expected sibling group creation to succeed');
  }

  rollbackCreatedChatSiblingGroup(KEY, created);

  const layout = usePanelLayoutStore.getState().layouts[KEY];
  expect(layout.maximizedGroupId).toBe('group-origin');
  expect(layout.groups['group-right'].collapsed).toBeUndefined();
  expect(layout.groups[created.groupId]).toBeUndefined();
});

test('reuses a group holding pipeline run panels as the content sibling', () => {
  const store = usePanelLayoutStore.getState();
  store.initializeLayout(KEY, {
    orientation: 'horizontal',
    groups: [
      {
        kind: 'chat',
        groupId: 'group-origin',
        panelId: 'panel-origin',
        instance: { chatTabId: 'chat-origin' },
      },
      {
        kind: 'pipeline-execution',
        groupId: 'group-runs',
        panelId: 'panel-pipeline-run-1',
        instance: { executionId: 'run-1' },
      },
      {
        kind: 'terminal',
        groupId: 'group-terminal',
        panelId: 'panel-terminal',
      },
    ],
    containerSize: { width: 1200, height: 800 },
  });
  store.focusGroup(KEY, 'group-terminal');
  store.focusGroup(KEY, 'group-runs');
  store.focusGroup(KEY, 'group-origin');

  const layout = usePanelLayoutStore.getState().layouts[KEY];
  expect(pickReusableChatSiblingGroupId(layout, 'group-origin')).toBe(
    'group-runs',
  );

  // A group that also holds a chat is never a reusable content sibling.
  expect(
    usePanelLayoutStore.getState().addTab(KEY, 'group-runs', 'chat', {
      instance: { chatTabId: 'chat-other' },
    }),
  ).not.toBeNull();
  expect(
    pickReusableChatSiblingGroupId(
      usePanelLayoutStore.getState().layouts[KEY],
      'group-origin',
    ),
  ).toBeNull();
});

describe('pickReusableChatSiblingGroupId', () => {
  /**
   * Origin chat group plus four candidates. MRU after setup (most recent
   * first): browser, diagram, file, terminal, then the origin.
   */
  function initCandidates(): void {
    const store = usePanelLayoutStore.getState();
    store.initializeLayout(KEY, {
      orientation: 'horizontal',
      groups: [
        { kind: 'chat', groupId: 'group-origin', panelId: 'panel-origin' },
        {
          kind: 'terminal',
          groupId: 'group-terminal',
          panelId: 'panel-terminal',
        },
        {
          kind: 'file-diff',
          groupId: 'group-file',
          panelId: 'panel-file',
          instance: { fileTabId: 'file-1' },
        },
        {
          kind: 'change-diagram',
          groupId: 'group-diagram',
          panelId: 'panel-diagram',
        },
        {
          kind: 'browser',
          groupId: 'group-browser',
          panelId: 'panel-browser',
          instance: { browserId: 'browser-1' },
        },
      ],
      containerSize: { width: 1600, height: 800 },
    });
    for (const groupId of [
      'group-origin',
      'group-terminal',
      'group-file',
      'group-diagram',
      'group-browser',
    ]) {
      store.focusGroup(KEY, groupId);
    }
  }

  function layout(): WorktreePanelLayout {
    return usePanelLayoutStore.getState().layouts[KEY];
  }

  test('defaults to the file, browser, Change Diagram, visuals, pipeline, plan, and subagent kinds', () => {
    expect(Array.from(CHAT_SIBLING_CONTENT_KINDS).sort()).toEqual([
      'browser',
      'change-diagram',
      'chat-visuals',
      'file-diff',
      'pipeline-execution',
      'plan',
      'plan-diagram',
      'subagent-chat',
      'subagents',
    ]);
  });

  test('reuses a group holding plan content like any other content group', () => {
    usePanelLayoutStore.getState().initializeLayout(KEY, {
      orientation: 'horizontal',
      groups: [
        {
          kind: 'chat',
          groupId: 'group-origin',
          panelId: 'panel-chat',
          instance: { chatTabId: 'chat-1' },
        },
        {
          kind: 'plan',
          groupId: 'group-plan',
          panelId: 'panel-plan-plan-1',
          instance: { planId: 'plan-1' },
        },
        {
          kind: 'plan-diagram',
          groupId: 'group-plan-diagram',
          panelId: 'panel-plan-diagram-plan-2',
          instance: { planId: 'plan-2' },
        },
      ],
      containerSize: { width: 1600, height: 800 },
    });
    usePanelLayoutStore.getState().focusGroup(KEY, 'group-plan-diagram');
    usePanelLayoutStore.getState().focusGroup(KEY, 'group-plan');

    expect(pickReusableChatSiblingGroupId(layout(), 'group-origin')).toBe(
      'group-plan',
    );
    expect(pickReusableChatSiblingGroupId(layout(), 'group-plan')).toBe(
      'group-plan-diagram',
    );
  });

  test('picks the most recently used content group other than the origin', () => {
    initCandidates();

    expect(pickReusableChatSiblingGroupId(layout(), 'group-origin')).toBe(
      'group-browser',
    );
    expect(pickReusableChatSiblingGroupId(layout(), 'group-browser')).toBe(
      'group-diagram',
    );
  });

  test('skips content groups that also hold a chat', () => {
    initCandidates();
    usePanelLayoutStore.getState().addTab(KEY, 'group-browser', 'chat', {
      instance: { chatTabId: 'chat-2' },
      activate: false,
    });

    expect(pickReusableChatSiblingGroupId(layout(), 'group-origin')).toBe(
      'group-diagram',
    );
  });

  test('ignores groups without reusable content', () => {
    const store = usePanelLayoutStore.getState();
    store.initializeLayout(KEY, {
      orientation: 'horizontal',
      groups: [
        { kind: 'chat', groupId: 'group-origin', panelId: 'panel-origin' },
        {
          kind: 'terminal',
          groupId: 'group-terminal',
          panelId: 'panel-terminal',
        },
        {
          kind: 'activity-section',
          groupId: 'group-activity',
          panelId: 'panel-activity',
        },
      ],
      containerSize: { width: 1200, height: 800 },
    });

    expect(pickReusableChatSiblingGroupId(layout(), 'group-origin')).toBeNull();
  });

  test('accepts a custom reusable content-kind set', () => {
    initCandidates();
    const kinds: ReadonlySet<PanelKind> = new Set<PanelKind>([
      'terminal',
      'file-diff',
    ]);

    expect(
      pickReusableChatSiblingGroupId(layout(), 'group-origin', kinds),
    ).toBe('group-file');
    expect(
      pickReusableChatSiblingGroupId(
        layout(),
        'group-origin',
        new Set<PanelKind>(['terminal']),
      ),
    ).toBe('group-terminal');
  });
});

describe('resolveChatPanelAnchor (CAN-4789)', () => {
  /**
   * Two chat groups and a documents group. Chat A's group holds a file that
   * is selected over chat A; chat B is selected in its own group. MRU after
   * setup (most recent first): docs, chat-b, chat-a.
   */
  function initLayout(): WorktreePanelLayout {
    const store = usePanelLayoutStore.getState();
    store.initializeLayout(KEY, {
      orientation: 'horizontal',
      groups: [
        {
          kind: 'chat',
          groupId: 'group-chat-a',
          panelId: 'panel-chat-a',
          instance: { chatTabId: 'chat-a' },
        },
        {
          kind: 'chat',
          groupId: 'group-chat-b',
          panelId: 'panel-chat-b',
          instance: { chatTabId: 'chat-b' },
        },
        {
          kind: 'file-diff',
          groupId: 'group-docs',
          panelId: 'panel-doc',
          instance: { fileTabId: 'file-doc' },
        },
      ],
      containerSize: { width: 1600, height: 800 },
    });
    store.addTab(KEY, 'group-chat-a', 'file-diff', {
      panelId: 'panel-legacy-file',
      instance: { fileTabId: 'file-legacy' },
    });
    for (const groupId of ['group-chat-a', 'group-chat-b', 'group-docs']) {
      store.focusGroup(KEY, groupId);
    }
    return usePanelLayoutStore.getState().layouts[KEY];
  }

  test('prefers the first live preferred chat id', () => {
    const layout = initLayout();
    expect(resolveChatPanelAnchor(layout, ['chat-a', 'chat-b'])).toEqual({
      groupId: 'group-chat-a',
      panelId: 'panel-chat-a',
      chatTabId: 'chat-a',
    });
  });

  test('skips stale, missing, and file ids before using the next preference', () => {
    const layout = initLayout();
    expect(
      resolveChatPanelAnchor(layout, [
        null,
        undefined,
        'chat-from-another-worktree',
        'file-doc',
        'chat-b',
      ])?.chatTabId,
    ).toBe('chat-b');
  });

  test('falls back to the selected chat of the most recently used group', () => {
    const layout = initLayout();
    // chat-a is covered by the legacy file, so chat-b is the selected chat.
    expect(resolveChatPanelAnchor(layout, [])?.chatTabId).toBe('chat-b');
  });

  test('falls back to the first chat panel when no group has a chat selected', () => {
    initLayout();
    const store = usePanelLayoutStore.getState();
    store.addTab(KEY, 'group-chat-b', 'file-diff', {
      panelId: 'panel-legacy-b',
      instance: { fileTabId: 'file-legacy-b' },
    });
    store.focusGroup(KEY, 'group-chat-a');
    const layout = usePanelLayoutStore.getState().layouts[KEY];
    expect(resolveChatPanelAnchor(layout, [])?.chatTabId).toBe('chat-a');
  });

  test('covers groups missing from MRU in stable layout order', () => {
    const layout = initLayout();
    const withoutMru: WorktreePanelLayout = { ...layout, mruGroupIds: [] };
    expect(resolveChatPanelAnchor(withoutMru, [])?.chatTabId).toBe('chat-b');
  });

  test('never anchors to a non-chat panel and returns null without chats', () => {
    const store = usePanelLayoutStore.getState();
    store.initializeLayout(KEY, {
      orientation: 'horizontal',
      groups: [
        { kind: 'chat', groupId: 'group-chat', panelId: 'panel-legacy-chat' },
        {
          kind: 'file-diff',
          groupId: 'group-docs',
          panelId: 'panel-doc',
          instance: { fileTabId: 'file-doc' },
        },
      ],
      containerSize: { width: 1200, height: 800 },
    });
    const layout = usePanelLayoutStore.getState().layouts[KEY];
    // An instance-less legacy chat panel binds no chat and cannot anchor.
    expect(resolveChatPanelAnchor(layout, ['file-doc'])).toBeNull();
  });
});
