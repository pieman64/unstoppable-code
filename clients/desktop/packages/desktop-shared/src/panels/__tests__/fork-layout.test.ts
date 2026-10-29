import type { SerializablePanelLayoutFile } from '@canopy/protocol/panels';
import { forkPanelLayoutForTabs } from '../fork-layout';

const source: SerializablePanelLayoutFile = {
  version: 1,
  grid: {
    orientation: 1,
    width: 1200,
    height: 800,
    root: {
      type: 'branch',
      size: 800,
      children: [
        {
          type: 'leaf',
          groupId: 'group-one',
          size: 700,
          panels: [
            {
              panelId: 'panel-file-file-old',
              kind: 'file-diff',
              title: 'index.ts',
              instance: {
                fileTabId: 'file-old',
                filePath: '/source/index.ts',
              },
            },
            {
              panelId: 'panel-chat-chat-old',
              kind: 'chat',
              title: 'Chat',
              instance: { chatTabId: 'chat-old' },
            },
          ],
          activePanelId: 'panel-file-file-old',
        },
        {
          type: 'leaf',
          groupId: 'group-two',
          size: 500,
          panels: [
            {
              panelId: 'terminal-panel',
              kind: 'terminal',
            },
          ],
          activePanelId: 'terminal-panel',
        },
      ],
    },
  },
  activeGroupId: 'group-one',
  mostRecentActiveGroupIds: ['group-one', 'group-two'],
};

describe('forkPanelLayoutForTabs', () => {
  it('preserves topology and tab order while rebinding chat and file panels', () => {
    const result = forkPanelLayoutForTabs(
      source,
      new Map([
        [
          'file-old',
          {
            destinationTabId: 'file-new',
            destinationFilePath: '/destination/index.ts',
          },
        ],
        ['chat-old', { destinationTabId: 'chat-new' }],
      ]),
    );

    expect(result).not.toBeNull();
    expect(result?.grid.orientation).toBe(1);
    expect(result?.activeGroupId).toBe('group-one');
    expect(result?.mostRecentActiveGroupIds).toEqual([
      'group-one',
      'group-two',
    ]);
    const root = result?.grid.root;
    expect(root?.type).toBe('branch');
    if (!root || root.type !== 'branch') return;
    const first = root.children[0];
    expect(first?.type).toBe('leaf');
    if (!first || first.type !== 'leaf') return;
    expect(first.panels.map((panel) => panel.panelId)).toEqual([
      'panel-file-file-new',
      'panel-chat-chat-new',
    ]);
    expect(first.panels[0]?.instance).toEqual({
      fileTabId: 'file-new',
      filePath: '/destination/index.ts',
    });
    expect(first.panels[1]?.instance).toEqual({ chatTabId: 'chat-new' });
    expect(first.activePanelId).toBe('panel-file-file-new');
    expect(root.children[1]).toEqual(
      source.grid.root.type === 'branch'
        ? source.grid.root.children[1]
        : undefined,
    );
  });

  it('drops stale bound panels and chooses the first remaining active tab', () => {
    const result = forkPanelLayoutForTabs(source, new Map());
    const root = result?.grid.root;
    if (!root || root.type !== 'branch') throw new Error('expected branch');
    const first = root.children[0];
    if (!first || first.type !== 'leaf') throw new Error('expected leaf');
    expect(first.panels).toEqual([]);
    expect(first.activePanelId).toBeNull();
  });

  it('drops browser panels whose sessions belong to the source worktree', () => {
    const browserLayout: SerializablePanelLayoutFile = {
      version: 1,
      grid: {
        orientation: 1,
        width: 1200,
        height: 800,
        root: {
          type: 'leaf',
          groupId: 'group-one',
          size: 1200,
          panels: [
            {
              panelId: 'browser-panel',
              kind: 'browser',
              instance: { browserId: 'source-browser' },
            },
            {
              panelId: 'terminal-panel',
              kind: 'terminal',
            },
          ],
          activePanelId: 'browser-panel',
        },
      },
      activeGroupId: 'group-one',
      mostRecentActiveGroupIds: ['group-one'],
    };

    const result = forkPanelLayoutForTabs(browserLayout, new Map());
    const root = result?.grid.root;
    if (!root || root.type !== 'leaf') throw new Error('expected leaf');
    expect(root.panels).toEqual([
      {
        panelId: 'terminal-panel',
        kind: 'terminal',
      },
    ]);
    expect(root.activePanelId).toBe('terminal-panel');
  });

  it('drops pipeline run panels from the main grid and popped-out windows', () => {
    const runLayout: SerializablePanelLayoutFile = {
      version: 1,
      grid: {
        orientation: 1,
        width: 1200,
        height: 800,
        root: {
          type: 'leaf',
          groupId: 'group-one',
          size: 1200,
          panels: [
            {
              panelId: 'panel-pipeline-run-1',
              kind: 'pipeline-execution',
              instance: { executionId: 'run-1' },
            },
            { panelId: 'terminal-panel', kind: 'terminal' },
          ],
          activePanelId: 'panel-pipeline-run-1',
        },
      },
      activeGroupId: 'group-one',
      mostRecentActiveGroupIds: ['group-one'],
      poppedOut: [
        {
          windowId: 'aux-run',
          grid: {
            orientation: 0,
            width: 640,
            height: 480,
            root: {
              type: 'leaf',
              groupId: 'group-aux',
              size: 640,
              panels: [
                {
                  panelId: 'panel-pipeline-run-2',
                  kind: 'pipeline-execution',
                  instance: { executionId: 'run-2' },
                },
              ],
              activePanelId: 'panel-pipeline-run-2',
            },
          },
          bounds: { x: 0, y: 0, width: 640, height: 480 },
          sourceGroupId: 'group-one',
        },
      ],
    };

    const result = forkPanelLayoutForTabs(runLayout, new Map());
    const root = result?.grid.root;
    if (!root || root.type !== 'leaf') throw new Error('expected leaf');
    expect(root.panels).toEqual([
      { panelId: 'terminal-panel', kind: 'terminal' },
    ]);
    expect(root.activePanelId).toBe('terminal-panel');
    // The popped-out window held only a run, so the fork omits it entirely.
    expect(result).not.toHaveProperty('poppedOut');
  });

  it('keeps the unbound Subagents panel but drops source-bound subagent chats', () => {
    const layout: SerializablePanelLayoutFile = {
      version: 1,
      grid: {
        orientation: 1,
        width: 1200,
        height: 800,
        root: {
          type: 'leaf',
          groupId: 'group-one',
          size: 1200,
          panels: [
            {
              panelId: 'panel-subagent-chat-1',
              kind: 'subagent-chat',
              instance: {
                rootChatId: 'chat-1',
                subagentId: 'agent-1',
                subagentKind: 'managed',
              },
            },
            { panelId: 'panel-subagents', kind: 'subagents' },
          ],
          activePanelId: 'panel-subagent-chat-1',
        },
      },
      activeGroupId: 'group-one',
      mostRecentActiveGroupIds: ['group-one'],
      poppedOut: [
        {
          windowId: 'aux-subagent-chat',
          grid: {
            orientation: 0,
            width: 640,
            height: 480,
            root: {
              type: 'leaf',
              groupId: 'group-aux',
              size: 640,
              panels: [
                {
                  panelId: 'panel-subagent-chat-2',
                  kind: 'subagent-chat',
                  instance: {
                    rootChatId: 'chat-1',
                    subagentId: 'agent-2',
                    subagentKind: 'codex-native',
                  },
                },
              ],
              activePanelId: 'panel-subagent-chat-2',
            },
          },
          bounds: { x: 0, y: 0, width: 640, height: 480 },
          sourceGroupId: 'group-one',
        },
      ],
    };

    const result = forkPanelLayoutForTabs(layout, new Map());
    const root = result?.grid.root;
    if (!root || root.type !== 'leaf') throw new Error('expected leaf');
    expect(root.panels).toEqual([
      { panelId: 'panel-subagents', kind: 'subagents' },
    ]);
    expect(root.activePanelId).toBe('panel-subagents');
    expect(result).not.toHaveProperty('poppedOut');
  });

  it('drops plan and plan-diagram panels in the main grid and popped-out windows', () => {
    const planLayout: SerializablePanelLayoutFile = {
      version: 1,
      grid: {
        orientation: 1,
        width: 1200,
        height: 800,
        root: {
          type: 'leaf',
          groupId: 'group-one',
          size: 1200,
          panels: [
            {
              panelId: 'panel-plan-plan-1',
              kind: 'plan',
              title: 'Plan one',
              instance: { planId: 'plan-1' },
            },
            {
              panelId: 'terminal-panel',
              kind: 'terminal',
            },
          ],
          activePanelId: 'panel-plan-plan-1',
        },
      },
      activeGroupId: 'group-one',
      mostRecentActiveGroupIds: ['group-one'],
      poppedOut: [
        {
          windowId: 'aux-source',
          grid: {
            orientation: 0,
            width: 640,
            height: 480,
            root: {
              type: 'leaf',
              groupId: 'group-aux',
              size: 480,
              panels: [
                {
                  panelId: 'panel-plan-diagram-plan-1',
                  kind: 'plan-diagram',
                  instance: { planId: 'plan-1' },
                },
              ],
              activePanelId: 'panel-plan-diagram-plan-1',
            },
          },
          bounds: { x: 0, y: 0, width: 640, height: 480 },
          sourceGroupId: 'group-one',
        },
      ],
    };

    const nextAuxWindowId = jest.fn(() => 'aux-destination');
    const result = forkPanelLayoutForTabs(planLayout, new Map(), {
      nextAuxWindowId,
    });
    const root = result?.grid.root;
    if (!root || root.type !== 'leaf') throw new Error('expected leaf');
    expect(root.panels).toEqual([
      { panelId: 'terminal-panel', kind: 'terminal' },
    ]);
    expect(root.activePanelId).toBe('terminal-panel');
    // The popped-out window held only the plan diagram, so restoring it would
    // open an empty window: the fork omits it (and the field) entirely.
    expect(result).not.toHaveProperty('poppedOut');
    expect(nextAuxWindowId).not.toHaveBeenCalled();
  });

  it('keeps popped-out windows that still hold a panel and drops emptied ones', () => {
    const auxWindow = (
      windowId: string,
      panel: SerializablePanelLayoutFile['grid']['root'],
    ): NonNullable<SerializablePanelLayoutFile['poppedOut']>[number] => ({
      windowId,
      grid: { orientation: 0, width: 640, height: 480, root: panel },
      bounds: { x: 0, y: 0, width: 640, height: 480 },
      sourceGroupId: 'group-one',
    });
    const layout: SerializablePanelLayoutFile = {
      ...source,
      poppedOut: [
        auxWindow('aux-chat', {
          type: 'leaf',
          groupId: 'group-aux-chat',
          size: 480,
          panels: [
            {
              panelId: 'panel-chat-chat-old',
              kind: 'chat',
              instance: { chatTabId: 'chat-old' },
            },
          ],
          activePanelId: 'panel-chat-chat-old',
        }),
        auxWindow('aux-stale', {
          type: 'branch',
          size: 480,
          children: [
            {
              type: 'leaf',
              groupId: 'group-aux-file',
              size: 320,
              panels: [
                {
                  panelId: 'panel-file-file-closed',
                  kind: 'file-diff',
                  instance: { fileTabId: 'file-closed' },
                },
              ],
              activePanelId: 'panel-file-file-closed',
            },
            {
              type: 'leaf',
              groupId: 'group-aux-plan',
              size: 320,
              panels: [
                {
                  panelId: 'panel-plan-plan-1',
                  kind: 'plan',
                  instance: { planId: 'plan-1' },
                },
              ],
              activePanelId: 'panel-plan-plan-1',
            },
          ],
        }),
      ],
    };

    const result = forkPanelLayoutForTabs(
      layout,
      new Map([['chat-old', { destinationTabId: 'chat-new' }]]),
      { nextAuxWindowId: (sourceWindowId) => `${sourceWindowId}-copy` },
    );

    expect(result?.poppedOut?.map((entry) => entry.windowId)).toEqual([
      'aux-chat-copy',
    ]);
    const auxRoot = result?.poppedOut?.[0]?.grid.root;
    if (!auxRoot || auxRoot.type !== 'leaf') throw new Error('expected leaf');
    expect(auxRoot.panels.map((panel) => panel.panelId)).toEqual([
      'panel-chat-chat-new',
    ]);
  });
});
