/** @jest-environment jsdom */

/** Open and reveal the new panels against the real panel-layout store. */
import {
  findPanelByInstanceKey,
  makeAuxPanelLayoutKey,
  makeWorktreePanelKey,
  usePanelLayoutStore,
  type DefaultLayoutDescriptor,
} from '@/stores/panelLayoutStore';
import type { SubagentChatPanelTarget } from '../subagent-panel-identity';
import {
  findSubagentChatPanel,
  findSubagentsPanel,
  openSubagentChatPanel,
  openSubagentsPanel,
} from '../subagent-panel-open';
import { subagentChatPanelInstanceKey } from '../subagent-panel-identity';

jest.mock('../persistence-bridge', () => ({
  ensureWorktreePanelLayout: jest.fn(() => Promise.resolve()),
}));

const PROJECT_ID = 'project-1';
const WORKTREE_ID = 'worktree-1';
const KEY = makeWorktreePanelKey(PROJECT_ID, WORKTREE_ID);
const SCOPE = { projectId: PROJECT_ID, worktreeId: WORKTREE_ID };
const AUX_KEY = makeAuxPanelLayoutKey(KEY, 'aux-1');
const TARGET: SubagentChatPanelTarget = {
  rootChatId: 'root-chat',
  subagentId: 'subagent-1',
  subagentKind: 'managed',
  title: 'Inspect the repository',
};
const WORKFLOW_TARGET: SubagentChatPanelTarget = {
  rootChatId: 'root-chat',
  subagentId: 'workflow-agent:wf_1:agent-1',
  subagentKind: 'workflow-agent',
  title: 'Fact-check the report',
};

const LAYOUT: DefaultLayoutDescriptor = {
  orientation: 'horizontal',
  groups: [
    {
      kind: 'chat',
      groupId: 'group-chat',
      panelId: 'panel-chat-root-chat',
      instance: { chatTabId: 'root-chat' },
    },
    {
      kind: 'terminal',
      groupId: 'group-terminal',
      panelId: 'panel-terminal',
    },
  ],
  containerSize: { width: 1200, height: 800 },
};

function store(): ReturnType<typeof usePanelLayoutStore.getState> {
  return usePanelLayoutStore.getState();
}

function panelCount(kind: 'subagents' | 'subagent-chat'): number {
  return Object.values(store().layouts).reduce(
    (count, layout) =>
      count +
      Object.values(layout.groups).reduce(
        (groupCount, group) =>
          groupCount + group.tabs.filter((tab) => tab.kind === kind).length,
        0,
      ),
    0,
  );
}

beforeEach(() => {
  store().initializeLayout(KEY, LAYOUT);
});

afterEach(() => {
  for (const key of Object.keys(store().layouts)) {
    store().disposeLayout(key);
  }
});

describe('openSubagentsPanel', () => {
  it('places the singleton in the requested group', async () => {
    const result = await openSubagentsPanel(SCOPE, {
      intent: { groupId: 'group-terminal' },
    });

    expect(result).toEqual({
      status: 'placed',
      location: {
        layoutKey: KEY,
        groupId: 'group-terminal',
        panelId: 'panel-subagents',
      },
    });
    expect(findSubagentsPanel(SCOPE)).toEqual(
      result.status === 'placed' ? result.location : null,
    );
    expect(panelCount('subagents')).toBe(1);
  });

  it('reveals the singleton on a later open without duplicating it', async () => {
    const first = await openSubagentsPanel(SCOPE, {
      intent: { groupId: 'group-terminal' },
    });
    const second = await openSubagentsPanel(SCOPE, {
      intent: { groupId: 'group-chat' },
    });

    expect(first.status).toBe('placed');
    expect(second).toEqual({
      status: 'revealed',
      location: {
        layoutKey: KEY,
        groupId: 'group-terminal',
        panelId: 'panel-subagents',
      },
    });
    expect(panelCount('subagents')).toBe(1);
  });

  it('reveals a singleton in an auxiliary layout instead of duplicating it', async () => {
    store().initializeLayout(AUX_KEY, {
      orientation: 'horizontal',
      groups: [
        {
          kind: 'subagents',
          groupId: 'group-aux',
          panelId: 'panel-subagents-aux',
        },
      ],
      containerSize: { width: 900, height: 600 },
    });

    const result = await openSubagentsPanel(SCOPE, {
      intent: { groupId: 'group-chat' },
    });

    expect(result).toEqual({
      status: 'revealed',
      location: {
        layoutKey: AUX_KEY,
        groupId: 'group-aux',
        panelId: 'panel-subagents-aux',
      },
    });
    expect(panelCount('subagents')).toBe(1);
    expect(store().layouts[KEY].groups['group-chat'].tabs).toHaveLength(1);
  });
});

describe('openSubagentChatPanel', () => {
  it('opens a workflow agent as a bound chat panel', async () => {
    const result = await openSubagentChatPanel(SCOPE, WORKFLOW_TARGET);

    expect(result.status).toBe('placed');
    expect(panelCount('subagent-chat')).toBe(1);
    expect(findSubagentChatPanel(SCOPE, WORKFLOW_TARGET)).not.toBeNull();
  });

  it('places an auto-opened subagent beside its root chat panel', async () => {
    const result = await openSubagentChatPanel(SCOPE, TARGET);

    expect(result.status).toBe('placed');
    if (result.status !== 'placed') return;
    expect(result.location.layoutKey).toBe(KEY);
    expect(result.location.groupId).not.toBe('group-chat');
    expect(result.location.groupId).not.toBe('group-terminal');
    expect(
      store().layouts[KEY].groups[result.location.groupId]?.tabs,
    ).toContainEqual(
      expect.objectContaining({
        kind: 'subagent-chat',
        title: 'Inspect the repository',
        instance: {
          rootChatId: 'root-chat',
          subagentId: 'subagent-1',
          subagentKind: 'managed',
        },
      }),
    );
  });

  it('reveals the existing panel for the same subagent without moving it', async () => {
    const first = await openSubagentChatPanel(SCOPE, TARGET);
    store().focusGroup(KEY, 'group-chat');
    const before = Object.fromEntries(
      Object.entries(store().layouts[KEY].groups).map(([groupId, group]) => [
        groupId,
        group.tabs.map((tab) => tab.panelId),
      ]),
    );

    const second = await openSubagentChatPanel(SCOPE, {
      ...TARGET,
      title: 'A newer title does not rename an open tab',
    });

    expect(first.status).toBe('placed');
    if (first.status !== 'placed') return;
    expect(second).toEqual({ status: 'revealed', location: first.location });
    expect(
      Object.fromEntries(
        Object.entries(store().layouts[KEY].groups).map(([groupId, group]) => [
          groupId,
          group.tabs.map((tab) => tab.panelId),
        ]),
      ),
    ).toEqual(before);
    expect(panelCount('subagent-chat')).toBe(1);
    const tab = store().layouts[first.location.layoutKey]?.groups[
      first.location.groupId
    ]?.tabs.find((candidate) => candidate.panelId === first.location.panelId);
    expect(tab?.title).toBe('Inspect the repository');
  });

  it('reveals a subagent chat already open in an auxiliary layout', async () => {
    store().initializeLayout(AUX_KEY, {
      orientation: 'horizontal',
      groups: [
        {
          kind: 'subagent-chat',
          groupId: 'group-aux',
          panelId: 'panel-subagent-aux',
          title: TARGET.title,
          instance: {
            rootChatId: TARGET.rootChatId,
            subagentId: TARGET.subagentId,
            subagentKind: TARGET.subagentKind,
          },
        },
      ],
      containerSize: { width: 900, height: 600 },
    });

    const result = await openSubagentChatPanel(SCOPE, TARGET);

    expect(result).toEqual({
      status: 'revealed',
      location: {
        layoutKey: AUX_KEY,
        groupId: 'group-aux',
        panelId: 'panel-subagent-aux',
      },
    });
    expect(panelCount('subagent-chat')).toBe(1);
  });

  it('keeps distinct subagent identities as distinct panels', async () => {
    const first = await openSubagentChatPanel(SCOPE, TARGET);
    const second = await openSubagentChatPanel(SCOPE, {
      ...TARGET,
      subagentId: 'subagent-2',
      title: 'Review tests',
    });

    expect(first.status).toBe('placed');
    expect(second.status).toBe('placed');
    expect(panelCount('subagent-chat')).toBe(2);
    expect(findSubagentChatPanel(SCOPE, TARGET)).not.toBeNull();
    expect(
      findSubagentChatPanel(SCOPE, {
        rootChatId: TARGET.rootChatId,
        subagentId: 'subagent-2',
      }),
    ).not.toBeNull();
  });

  it('fails invalid bindings without changing the layout', async () => {
    const before = store().layouts[KEY];

    await expect(
      openSubagentChatPanel(SCOPE, { ...TARGET, rootChatId: ' ' }),
    ).resolves.toEqual({ status: 'failed' });

    expect(store().layouts[KEY]).toBe(before);
    expect(panelCount('subagent-chat')).toBe(0);
  });

  it('finds an existing panel by its pair identity across the family', () => {
    store().initializeLayout(AUX_KEY, {
      orientation: 'horizontal',
      groups: [
        {
          kind: 'subagent-chat',
          groupId: 'group-aux',
          panelId: 'panel-subagent-aux',
          title: TARGET.title,
          instance: {
            rootChatId: TARGET.rootChatId,
            subagentId: TARGET.subagentId,
            subagentKind: TARGET.subagentKind,
          },
        },
      ],
      containerSize: { width: 900, height: 600 },
    });

    expect(findSubagentChatPanel(SCOPE, TARGET)).toEqual({
      layoutKey: AUX_KEY,
      groupId: 'group-aux',
      panelId: 'panel-subagent-aux',
    });
    expect(
      findPanelByInstanceKey(KEY, subagentChatPanelInstanceKey(TARGET)),
    ).toEqual(findSubagentChatPanel(SCOPE, TARGET));
  });
});
