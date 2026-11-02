import { migratePanelLayout } from '@canopy/protocol';
import type {
  ISerializedPanelEntry,
  SerializablePanelLayoutFile,
} from '@canopy/protocol/panels';
import {
  retargetTemplateForWorktree,
  templateHasChatHost,
  templatizeLayoutForDefault,
} from '../default-layout-template';
import type { ChatTabPanelSeed } from '../chat-panel-binding';

// horizontal [ vertical [ chat(collapsed? no) , terminal ], activity ]
function buildCapturedLayout(): SerializablePanelLayoutFile {
  return {
    version: 1,
    grid: {
      root: {
        type: 'branch',
        size: 1200,
        children: [
          {
            type: 'branch',
            size: 864,
            children: [
              {
                type: 'leaf',
                groupId: 'group-chat',
                size: 560,
                panels: [
                  {
                    panelId: 'panel-chat-abc',
                    kind: 'chat',
                    instance: { chatTabId: 'abc' },
                    title: 'Chat',
                  },
                  {
                    panelId: 'panel-file-def',
                    kind: 'file-diff',
                    instance: { fileTabId: 'def', filePath: '/x.ts' },
                  },
                ],
                activePanelId: 'panel-chat-abc',
              },
              {
                type: 'leaf',
                groupId: 'group-terminal',
                size: 240,
                panels: [{ panelId: 'panel-terminal', kind: 'terminal' }],
                activePanelId: 'panel-terminal',
              },
            ],
          },
          {
            type: 'leaf',
            groupId: 'group-activity',
            size: 336,
            panels: [{ panelId: 'panel-activity', kind: 'activity-section' }],
            activePanelId: 'panel-activity',
            collapsed: { edge: 'right', expandedSize: 336 },
          },
          {
            type: 'leaf',
            groupId: 'group-pull-request',
            size: 240,
            panels: [
              {
                panelId: 'panel-pull-request',
                kind: 'activity-card',
                title: 'Pull requests',
                instance: { sectionId: 'pull-request' },
              },
            ],
            activePanelId: 'panel-pull-request',
          },
          {
            type: 'leaf',
            groupId: 'group-pipeline-runs',
            size: 240,
            panels: [
              {
                panelId: 'panel-pipeline-runs',
                kind: 'activity-card',
                title: 'Pipeline runs',
                instance: { sectionId: 'pipeline-runs' },
              },
            ],
            activePanelId: 'panel-pipeline-runs',
          },
        ],
      },
      orientation: 1,
      width: 1200,
      height: 800,
    },
    activeGroupId: 'group-chat',
    mostRecentActiveGroupIds: ['group-chat', 'group-terminal'],
  };
}

type SerializedPanelLeaf = Extract<
  SerializablePanelLayoutFile['grid']['root'],
  { type: 'leaf' }
>;

function withUpdatedLeaf(
  layout: SerializablePanelLayoutFile,
  groupId: string,
  update: (leaf: SerializedPanelLeaf) => SerializedPanelLeaf,
): SerializablePanelLayoutFile {
  const updateNode = (
    node: SerializablePanelLayoutFile['grid']['root'],
  ): SerializablePanelLayoutFile['grid']['root'] => {
    if (node.type === 'leaf') {
      return node.groupId === groupId ? update(node) : node;
    }
    return { ...node, children: node.children.map(updateNode) };
  };

  return {
    ...layout,
    grid: { ...layout.grid, root: updateNode(layout.grid.root) },
  };
}

function leavesOf(file: SerializablePanelLayoutFile): Array<{
  groupId: string;
  kinds: string[];
  collapsed: boolean;
}> {
  const out: Array<{ groupId: string; kinds: string[]; collapsed: boolean }> =
    [];
  const walk = (node: SerializablePanelLayoutFile['grid']['root']): void => {
    if (node.type === 'leaf') {
      out.push({
        groupId: node.groupId,
        kinds: node.panels.map((p) => p.kind),
        collapsed: node.collapsed !== undefined,
      });
      return;
    }
    node.children.forEach(walk);
  };
  walk(file.grid.root);
  return out;
}

describe('templatizeLayoutForDefault', () => {
  it('drops worktree-bound panels while preserving activity cards, geometry, and collapse', () => {
    const template = templatizeLayoutForDefault(buildCapturedLayout());
    const leaves = leavesOf(template);
    const chat = leaves.find((l) => l.groupId === 'group-chat');
    const terminal = leaves.find((l) => l.groupId === 'group-terminal');
    const activity = leaves.find((l) => l.groupId === 'group-activity');
    const pullRequest = leaves.find((l) => l.groupId === 'group-pull-request');
    const pipelineRuns = leaves.find(
      (l) => l.groupId === 'group-pipeline-runs',
    );
    expect(chat?.kinds).toEqual([]); // chat + file-diff removed
    expect(terminal?.kinds).toEqual(['terminal']);
    expect(activity?.kinds).toEqual(['activity-section']);
    expect(pullRequest?.kinds).toEqual(['activity-card']);
    expect(pipelineRuns?.kinds).toEqual(['activity-card']);
    expect(activity?.collapsed).toBe(true); // collapse state preserved
    expect(template.poppedOut).toBeUndefined();
  });

  it('preserves portable activity-card section bindings', () => {
    const template = templatizeLayoutForDefault(buildCapturedLayout());
    expect(JSON.stringify(template)).toContain('"sectionId":"pull-request"');
    expect(JSON.stringify(template)).toContain('"sectionId":"pipeline-runs"');
  });

  it('keeps Subagents but omits a subagent chat bound to the captured worktree', () => {
    const base = buildCapturedLayout();
    const root = base.grid.root;
    if (root.type !== 'branch') throw new Error('expected branch root');
    const activity = root.children[1];
    if (activity.type !== 'leaf') throw new Error('expected activity leaf');
    const captured: SerializablePanelLayoutFile = {
      ...base,
      grid: {
        ...base.grid,
        root: {
          ...root,
          children: root.children.map((child) =>
            child === activity
              ? {
                  ...activity,
                  panels: [
                    ...activity.panels,
                    { panelId: 'panel-subagents', kind: 'subagents' },
                    {
                      panelId: 'panel-subagent-chat',
                      kind: 'subagent-chat',
                      instance: {
                        rootChatId: 'chat-1',
                        subagentId: 'agent-1',
                        subagentKind: 'claude-native',
                      },
                    },
                  ],
                }
              : child,
          ),
        },
      },
    };

    const template = templatizeLayoutForDefault(captured);
    expect(
      leavesOf(template).find((leaf) => leaf.groupId === 'group-activity')
        ?.kinds,
    ).toEqual(['activity-section', 'subagents']);
    expect(JSON.stringify(template)).not.toContain('agent-1');
    expect(migratePanelLayout(template)).not.toBeNull();
  });

  it('produces a template that passes migratePanelLayout', () => {
    const template = templatizeLayoutForDefault(buildCapturedLayout());
    expect(migratePanelLayout(template)).not.toBeNull();
  });

  it("preserves a collapse but strips Canopy's `auto` flag (CAN-2836)", () => {
    // A user who saves a layout as the default while the rail still carries
    // Canopy's SEEDED collapse is making a deliberate choice about that
    // collapsed state. Carrying `auto: true` into the saved default would make
    // every worktree that later adopts it auto-expand the rail once — undoing
    // the very layout the user chose.
    const captured = withUpdatedLeaf(
      buildCapturedLayout(),
      'group-activity',
      (leaf): SerializedPanelLeaf => ({
        ...leaf,
        collapsed: {
          edge: 'right',
          expandedSize: 336,
          auto: true,
        },
      }),
    );

    const template = templatizeLayoutForDefault(captured);
    const templateRoot = template.grid.root;
    if (templateRoot.type !== 'branch') {
      throw new Error('expected template branch root');
    }
    const templateActivity = templateRoot.children[1];
    if (templateActivity.type !== 'leaf') {
      throw new Error('expected template activity leaf');
    }
    // The collapse itself survives — only its provenance is re-keyed.
    expect(templateActivity.collapsed).toEqual({
      edge: 'right',
      expandedSize: 336,
    });
    expect(templateActivity.collapsed?.auto).toBeUndefined();
    expect(JSON.stringify(template)).not.toContain('"auto"');
  });

  it('leaves an uncollapsed leaf without a `collapsed` key', () => {
    const template = templatizeLayoutForDefault(buildCapturedLayout());
    const templateRoot = template.grid.root;
    if (templateRoot.type !== 'branch') {
      throw new Error('expected template branch root');
    }
    const nested = templateRoot.children[0];
    if (nested.type !== 'branch') throw new Error('expected nested branch');
    const chatLeaf = nested.children[0];
    if (chatLeaf.type !== 'leaf') throw new Error('expected leaf');
    expect('collapsed' in chatLeaf).toBe(false);
  });

  it('turns a bound terminal into a portable placeholder', () => {
    const captured = withUpdatedLeaf(
      buildCapturedLayout(),
      'group-terminal',
      (leaf): SerializedPanelLeaf => ({
        ...leaf,
        panels: [
          {
            panelId: 'panel-terminal-session-1',
            kind: 'terminal',
            title: 'zsh',
            instance: { terminalId: 'terminal-session-1' },
          },
        ],
        activePanelId: 'panel-terminal-session-1',
        collapsed: { edge: 'bottom', expandedSize: 240 },
      }),
    );

    const template = templatizeLayoutForDefault(captured);
    const templateRoot = template.grid.root;
    if (templateRoot.type !== 'branch') {
      throw new Error('expected template branch root');
    }
    const templateNested = templateRoot.children[0];
    if (templateNested.type !== 'branch') {
      throw new Error('expected template nested branch');
    }
    const templateTerminal = templateNested.children[1];
    if (templateTerminal.type !== 'leaf') {
      throw new Error('expected template terminal leaf');
    }

    expect(templateTerminal.panels).toEqual([
      {
        panelId: 'panel-terminal-session-1',
        kind: 'terminal',
        title: 'zsh',
      },
    ]);
    expect(templateTerminal.activePanelId).toBe('panel-terminal-session-1');
    expect(templateTerminal.collapsed).toEqual({
      edge: 'bottom',
      expandedSize: 240,
    });
    expect(migratePanelLayout(template)).not.toBeNull();
  });

  it('retains at most one portable placeholder for multiple bound terminals', () => {
    const captured = withUpdatedLeaf(
      buildCapturedLayout(),
      'group-terminal',
      (leaf): SerializedPanelLeaf => ({
        ...leaf,
        panels: [
          {
            panelId: 'panel-terminal-session-1',
            kind: 'terminal',
            title: 'zsh',
            instance: { terminalId: 'terminal-session-1' },
          },
          {
            panelId: 'panel-terminal-session-2',
            kind: 'terminal',
            title: 'zsh',
            instance: { terminalId: 'terminal-session-2' },
          },
        ],
        activePanelId: 'panel-terminal-session-2',
      }),
    );

    const template = templatizeLayoutForDefault(captured);
    const templateRoot = template.grid.root;
    if (templateRoot.type !== 'branch') {
      throw new Error('expected template branch root');
    }
    const templateNested = templateRoot.children[0];
    if (templateNested.type !== 'branch') {
      throw new Error('expected template nested branch');
    }
    const templateTerminal = templateNested.children[1];
    if (templateTerminal.type !== 'leaf') {
      throw new Error('expected template terminal leaf');
    }

    expect(templateTerminal.panels).toEqual([
      {
        panelId: 'panel-terminal-session-1',
        kind: 'terminal',
        title: 'zsh',
      },
    ]);
    expect(templateTerminal.activePanelId).toBe('panel-terminal-session-1');
    expect(migratePanelLayout(template)).not.toBeNull();
  });

  it.each(['', '   '])(
    'prefers an existing %j terminal placeholder over an earlier bound terminal',
    (terminalId) => {
      const captured = withUpdatedLeaf(
        buildCapturedLayout(),
        'group-terminal',
        (leaf): SerializedPanelLeaf => ({
          ...leaf,
          panels: [
            {
              panelId: 'panel-terminal-bound',
              kind: 'terminal',
              instance: { terminalId: 'terminal-session-1' },
            },
            {
              panelId: 'panel-terminal-placeholder',
              kind: 'terminal',
              instance: { terminalId },
            },
          ],
        }),
      );

      const template = templatizeLayoutForDefault(captured);
      const templateRoot = template.grid.root;
      if (templateRoot.type !== 'branch') {
        throw new Error('expected template branch root');
      }
      const templateNested = templateRoot.children[0];
      if (templateNested.type !== 'branch') {
        throw new Error('expected template nested branch');
      }
      const templateTerminal = templateNested.children[1];
      if (templateTerminal.type !== 'leaf') {
        throw new Error('expected template terminal leaf');
      }

      expect(templateTerminal.panels).toEqual([
        {
          panelId: 'panel-terminal-placeholder',
          kind: 'terminal',
        },
      ]);
    },
  );

  it('omits concrete Browser tabs (session ids cannot retarget across worktrees)', () => {
    const captured = buildCapturedLayout();
    const root = captured.grid.root;
    if (root.type !== 'branch') throw new Error('expected branch root');
    const nested = root.children[0];
    if (nested.type !== 'branch') throw new Error('expected nested branch');
    const terminalLeaf = nested.children[1];
    if (terminalLeaf.type !== 'leaf') throw new Error('expected leaf');
    // Mixed-content group: terminal + a bound Browser tab.
    (terminalLeaf.panels as ISerializedPanelEntry[]).push({
      panelId: 'panel-browser-b1',
      kind: 'browser',
      instance: { browserId: 'b1' },
    });

    const template = templatizeLayoutForDefault(captured);
    const leaves = leavesOf(template);
    const terminal = leaves.find((l) => l.groupId === 'group-terminal');
    // The Browser tab is dropped; the surrounding mixed-content group (and
    // its geometry) survives.
    expect(terminal?.kinds).toEqual(['terminal']);
    expect(migratePanelLayout(template)).not.toBeNull();
  });

  it('omits pipeline run tabs (a run belongs to the captured worktree)', () => {
    const withPanelInLeaf = (
      node: SerializablePanelLayoutFile['grid']['root'],
      groupId: string,
      panel: ISerializedPanelEntry,
    ): SerializablePanelLayoutFile['grid']['root'] =>
      node.type === 'leaf'
        ? node.groupId === groupId
          ? { ...node, panels: [...node.panels, panel] }
          : node
        : {
            ...node,
            children: node.children.map((child) =>
              withPanelInLeaf(child, groupId, panel),
            ),
          };
    const captured = buildCapturedLayout();
    const withRun: SerializablePanelLayoutFile = {
      ...captured,
      grid: {
        ...captured.grid,
        root: withPanelInLeaf(captured.grid.root, 'group-terminal', {
          panelId: 'panel-pipeline-run-1',
          kind: 'pipeline-execution',
          instance: { executionId: 'run-1' },
        }),
      },
    };
    expect(
      leavesOf(withRun).find((leaf) => leaf.groupId === 'group-terminal')
        ?.kinds,
    ).toEqual(['terminal', 'pipeline-execution']);

    const template = templatizeLayoutForDefault(withRun);

    expect(
      leavesOf(template).find((leaf) => leaf.groupId === 'group-terminal')
        ?.kinds,
    ).toEqual(['terminal']);
    expect(
      leavesOf(template).some((leaf) =>
        leaf.kinds.includes('pipeline-execution'),
      ),
    ).toBe(false);
    expect(migratePanelLayout(template)).not.toBeNull();
  });

  it('omits plan and plan-diagram panels (tracked plans are worktree-local)', () => {
    const captured: SerializablePanelLayoutFile = {
      version: 1,
      grid: {
        root: {
          type: 'branch',
          size: 1200,
          children: [
            {
              type: 'leaf',
              groupId: 'group-chat',
              size: 500,
              panels: [
                {
                  panelId: 'panel-chat-abc',
                  kind: 'chat',
                  instance: { chatTabId: 'abc' },
                },
                {
                  panelId: 'panel-plan-plan-1',
                  kind: 'plan',
                  title: 'Plan one',
                  instance: { planId: 'plan-1' },
                },
              ],
              activePanelId: 'panel-plan-plan-1',
            },
            {
              type: 'leaf',
              groupId: 'group-plan-diagram',
              size: 400,
              panels: [
                {
                  panelId: 'panel-plan-diagram-plan-1',
                  kind: 'plan-diagram',
                  title: 'Plan one (Diagram)',
                  instance: { planId: 'plan-1' },
                },
              ],
              activePanelId: 'panel-plan-diagram-plan-1',
            },
            {
              type: 'leaf',
              groupId: 'group-activity',
              size: 300,
              panels: [
                { panelId: 'panel-activity', kind: 'activity-section' },
                {
                  panelId: 'panel-plan-plan-2',
                  kind: 'plan',
                  instance: { planId: 'plan-2' },
                },
              ],
              activePanelId: 'panel-plan-plan-2',
            },
          ],
        },
        orientation: 1,
        width: 1200,
        height: 800,
      },
      activeGroupId: 'group-plan-diagram',
      mostRecentActiveGroupIds: [
        'group-plan-diagram',
        'group-chat',
        'group-activity',
      ],
    };

    const template = templatizeLayoutForDefault(captured);
    const leaves = leavesOf(template);
    expect(leaves).toEqual([
      { groupId: 'group-chat', kinds: [], collapsed: false },
      { groupId: 'group-plan-diagram', kinds: [], collapsed: false },
      {
        groupId: 'group-activity',
        kinds: ['activity-section'],
        collapsed: false,
      },
    ]);
    const root = template.grid.root;
    if (root.type !== 'branch') throw new Error('expected branch root');
    // Geometry survives; active ids point at surviving panels (or none).
    expect(root.children.map((child) => child.size)).toEqual([500, 400, 300]);
    expect(
      root.children.map((child) =>
        child.type === 'leaf' ? child.activePanelId : 'branch',
      ),
    ).toEqual([null, null, 'panel-activity']);
    expect(JSON.stringify(template)).not.toContain('planId');
    expect(migratePanelLayout(template)).not.toBeNull();
    expect(templateHasChatHost(template)).toBe(true);
  });
});

describe('retargetTemplateForWorktree', () => {
  const seed: ChatTabPanelSeed = {
    kind: 'chat',
    panelId: 'panel-chat-new',
    instance: { chatTabId: 'new' },
    title: 'Chat',
  };

  it('injects the new worktree chat into group-chat when a seed is present', () => {
    const template = templatizeLayoutForDefault(buildCapturedLayout());
    const file = retargetTemplateForWorktree(template, seed);
    expect(file).not.toBeNull();
    const chat = leavesOf(file as SerializablePanelLayoutFile).find(
      (l) => l.groupId === 'group-chat',
    );
    expect(chat?.kinds).toEqual(['chat']);
    expect(migratePanelLayout(file)).not.toBeNull();
  });

  it('leaves group-chat empty when no seed is available (sync bridge fills it)', () => {
    const template = templatizeLayoutForDefault(buildCapturedLayout());
    const file = retargetTemplateForWorktree(template, null);
    expect(file).not.toBeNull();
    const chat = leavesOf(file as SerializablePanelLayoutFile).find(
      (l) => l.groupId === 'group-chat',
    );
    expect(chat?.kinds).toEqual([]);
  });

  it('returns null when the template has no chat host group', () => {
    const template = templatizeLayoutForDefault(buildCapturedLayout());
    const noChatHost: SerializablePanelLayoutFile = {
      ...template,
      grid: {
        ...template.grid,
        root: {
          type: 'leaf',
          groupId: 'group-terminal',
          size: 1200,
          panels: [{ panelId: 'panel-terminal', kind: 'terminal' }],
          activePanelId: 'panel-terminal',
        },
      },
      activeGroupId: 'group-terminal',
      mostRecentActiveGroupIds: ['group-terminal'],
    };
    expect(retargetTemplateForWorktree(noChatHost, seed)).toBeNull();
  });
});

/** A captured layout whose chat lives in a non-`group-chat` group (`group-xyz`)
 * with no pre-existing `group-chat` leaf; `activeGroupId` and
 * `mostRecentActiveGroupIds` reference that same group. */
function buildLayoutWithChatInNonDefaultGroup(): SerializablePanelLayoutFile {
  return {
    version: 1,
    grid: {
      root: {
        type: 'branch',
        size: 1200,
        children: [
          {
            type: 'leaf',
            groupId: 'group-xyz',
            size: 800,
            panels: [
              {
                panelId: 'panel-chat-abc',
                kind: 'chat',
                instance: { chatTabId: 'abc' },
                title: 'Chat',
              },
            ],
            activePanelId: 'panel-chat-abc',
          },
          {
            type: 'leaf',
            groupId: 'group-terminal',
            size: 400,
            panels: [{ panelId: 'panel-terminal', kind: 'terminal' }],
            activePanelId: 'panel-terminal',
          },
        ],
      },
      orientation: 1,
      width: 1200,
      height: 800,
    },
    activeGroupId: 'group-xyz',
    mostRecentActiveGroupIds: ['group-xyz', 'group-terminal'],
  };
}

/** A captured layout with chat in `group-xyz` AND a separate, already-present
 * empty `group-chat` leaf — the collision the dedupe fix guards against. */
function buildCollisionLayout(
  includePortableActivityCard = false,
): SerializablePanelLayoutFile {
  return {
    version: 1,
    grid: {
      root: {
        type: 'branch',
        size: 1200,
        children: [
          {
            type: 'leaf',
            groupId: 'group-xyz',
            size: 400,
            panels: [
              {
                panelId: 'panel-chat-abc',
                kind: 'chat',
                instance: { chatTabId: 'abc' },
                title: 'Chat',
              },
              ...(includePortableActivityCard
                ? [
                    {
                      panelId: 'panel-summary',
                      kind: 'activity-card' as const,
                      instance: { sectionId: 'summary' },
                      title: 'Summary',
                    },
                  ]
                : []),
            ],
            activePanelId: 'panel-chat-abc',
          },
          {
            type: 'leaf',
            groupId: 'group-chat',
            size: 400,
            panels: [],
            activePanelId: null,
          },
          {
            type: 'leaf',
            groupId: 'group-terminal',
            size: 400,
            panels: [{ panelId: 'panel-terminal', kind: 'terminal' }],
            activePanelId: 'panel-terminal',
          },
        ],
      },
      orientation: 1,
      width: 1200,
      height: 800,
    },
    activeGroupId: 'group-xyz',
    mostRecentActiveGroupIds: ['group-xyz', 'group-terminal'],
  };
}

/** A captured layout with only terminal/activity panels — no chat and no
 * pre-existing `group-chat` leaf. */
function buildChatlessLayout(): SerializablePanelLayoutFile {
  return {
    version: 1,
    grid: {
      root: {
        type: 'branch',
        size: 1200,
        children: [
          {
            type: 'leaf',
            groupId: 'group-terminal',
            size: 800,
            panels: [{ panelId: 'panel-terminal', kind: 'terminal' }],
            activePanelId: 'panel-terminal',
          },
          {
            type: 'leaf',
            groupId: 'group-activity',
            size: 400,
            panels: [{ panelId: 'panel-activity', kind: 'activity-section' }],
            activePanelId: 'panel-activity',
          },
        ],
      },
      orientation: 1,
      width: 1200,
      height: 800,
    },
    activeGroupId: 'group-terminal',
    mostRecentActiveGroupIds: ['group-terminal'],
  };
}

describe('findChatHostGroupId remap (via templatizeLayoutForDefault)', () => {
  it('renames the chat host leaf to group-chat and rewrites active/MRU group ids', () => {
    const template = templatizeLayoutForDefault(
      buildLayoutWithChatInNonDefaultGroup(),
    );
    const leaves = leavesOf(template);
    // The former `group-xyz` leaf no longer exists; it was renamed.
    expect(leaves.some((l) => l.groupId === 'group-xyz')).toBe(false);
    const chatGroupLeaves = leaves.filter((l) => l.groupId === 'group-chat');
    expect(chatGroupLeaves).toHaveLength(1);
    expect(chatGroupLeaves[0].kinds).toEqual([]); // chat panel stripped
    expect(template.activeGroupId).toBe('group-chat');
    expect(template.mostRecentActiveGroupIds).toEqual([
      'group-chat',
      'group-terminal',
    ]);
  });

  it('resolves a chat-host collision by keeping the existing group-chat leaf as the host', () => {
    const template = templatizeLayoutForDefault(buildCollisionLayout());
    const leaves = leavesOf(template);
    const chatGroupLeaves = leaves.filter((l) => l.groupId === 'group-chat');
    // Exactly one leaf owns group-chat — no duplicate.
    expect(chatGroupLeaves).toHaveLength(1);
    expect(template.activeGroupId).toBe('group-chat');
    expect(template.mostRecentActiveGroupIds).toEqual([
      'group-chat',
      'group-terminal',
    ]);
    expect(migratePanelLayout(template)).not.toBeNull();

    const seed: ChatTabPanelSeed = {
      kind: 'chat',
      panelId: 'panel-chat-new',
      instance: { chatTabId: 'new' },
      title: 'Chat',
    };
    const retargeted = retargetTemplateForWorktree(template, seed);
    expect(retargeted).not.toBeNull();
    const migrated =
      retargeted !== null ? migratePanelLayout(retargeted) : null;
    expect(migrated).not.toBeNull();

    // No panelId appears twice, and there is exactly one chat panel.
    const panelIds: string[] = [];
    const walkPanelIds = (
      node: SerializablePanelLayoutFile['grid']['root'],
    ): void => {
      if (node.type === 'leaf') {
        for (const panel of node.panels) {
          panelIds.push(panel.panelId);
        }
        return;
      }
      node.children.forEach(walkPanelIds);
    };
    walkPanelIds((retargeted as SerializablePanelLayoutFile).grid.root);
    const uniquePanelIds = new Set(panelIds);
    expect(uniquePanelIds.size).toBe(panelIds.length);
    expect(panelIds.filter((id) => id === 'panel-chat-new')).toHaveLength(1);
  });

  it('keeps a portable activity card in the original active group during a chat-host collision', () => {
    const template = templatizeLayoutForDefault(buildCollisionLayout(true));
    const leaves = leavesOf(template);
    expect(leaves.find((leaf) => leaf.groupId === 'group-xyz')?.kinds).toEqual([
      'activity-card',
    ]);
    expect(template.activeGroupId).toBe('group-xyz');

    const seed: ChatTabPanelSeed = {
      kind: 'chat',
      panelId: 'panel-chat-new',
      instance: { chatTabId: 'new' },
      title: 'Chat',
    };
    const retargeted = retargetTemplateForWorktree(template, seed);
    expect(retargeted).not.toBeNull();
    if (!retargeted) {
      throw new Error('Expected the template to retarget successfully');
    }
    const retargetedLeaves = leavesOf(retargeted);
    expect(
      retargetedLeaves.find((leaf) => leaf.groupId === 'group-chat')?.kinds,
    ).toEqual(['chat']);
    expect(
      retargetedLeaves.find((leaf) => leaf.groupId === 'group-xyz')?.kinds,
    ).toEqual(['activity-card']);
  });

  it('remaps an active chat group emptied by terminal placeholder deduplication', () => {
    const captured = withUpdatedLeaf(
      withUpdatedLeaf(buildCollisionLayout(), 'group-xyz', (leaf) => ({
        ...leaf,
        panels: [
          ...leaf.panels,
          {
            panelId: 'panel-terminal-bound',
            kind: 'terminal',
            instance: { terminalId: 'terminal-session-1' },
          },
        ],
      })),
      'group-chat',
      (leaf) => ({
        ...leaf,
        panels: [
          ...leaf.panels,
          {
            panelId: 'panel-terminal-placeholder',
            kind: 'terminal',
          },
        ],
        activePanelId: 'panel-terminal-placeholder',
      }),
    );

    const template = templatizeLayoutForDefault(captured);
    const leaves = leavesOf(template);

    expect(leaves.find((leaf) => leaf.groupId === 'group-xyz')?.kinds).toEqual(
      [],
    );
    expect(template.activeGroupId).toBe('group-chat');
    expect(template.mostRecentActiveGroupIds).toEqual([
      'group-chat',
      'group-terminal',
    ]);
  });
});

describe('templateHasChatHost', () => {
  it('is true for a normal templatized layout', () => {
    const template = templatizeLayoutForDefault(buildCapturedLayout());
    expect(templateHasChatHost(template)).toBe(true);
  });

  it('is false for a templatized chat-less layout (no chat, no group-chat leaf)', () => {
    const template = templatizeLayoutForDefault(buildChatlessLayout());
    expect(templateHasChatHost(template)).toBe(false);
  });
});
