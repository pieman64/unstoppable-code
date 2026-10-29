import {
  clampPanelTitle,
  migratePanelLayout,
  isPanelCollapsedState,
  isPanelInstanceRecord,
  isPipelineExecutionPanelInstance,
  isSubagentChatPanelInstance,
  isSessionBreakdownPanelInstance,
  isSubagentKind,
  isSerializedPanelNode,
  isSerializedPanelGrid,
  isSerializablePanelLayoutFile,
  PANEL_INSTANCE_KEY_MAX_LENGTH,
  PANEL_INSTANCE_MAX_KEYS,
  PANEL_INSTANCE_VALUE_MAX_LENGTH,
  PANEL_KINDS,
  PANEL_TITLE_MAX_LENGTH,
  PIPELINE_EXECUTION_PANEL_ID_MAX_LENGTH,
  SINGLETON_PANEL_KINDS,
  SESSION_BREAKDOWN_PANEL_ID_MAX_LENGTH,
  SUBAGENT_CHAT_PANEL_ID_MAX_LENGTH,
  SUBAGENT_KINDS,
  type ISerializedPanelGrid,
  type ISerializedPanelLeafNode,
  type ISerializedPanelNode,
  type SerializablePanelLayoutFile,
  type SerializedPoppedPanelWindow,
} from '../index';

function makeLeaf(
  groupId: string,
  panelId: string,
  size = 400,
): ISerializedPanelLeafNode {
  return {
    type: 'leaf',
    groupId,
    panels: [{ panelId, kind: 'chat' }],
    activePanelId: panelId,
    size,
  };
}

function makeValidFile(): SerializablePanelLayoutFile {
  return {
    version: 1,
    grid: {
      root: {
        type: 'branch',
        size: 800,
        children: [
          makeLeaf('group-a', 'panel-1', 600),
          makeLeaf('group-b', 'panel-2', 600),
        ],
      },
      orientation: 0,
      width: 1200,
      height: 800,
    },
    activeGroupId: 'group-a',
    mostRecentActiveGroupIds: ['group-a', 'group-b'],
  };
}

/**
 * A valid 3-level tree: branch → [leaf, branch → [leaf, branch → [leaf, leaf]]].
 */
function makeDeepGrid(): ISerializedPanelGrid {
  return {
    root: {
      type: 'branch',
      size: 900,
      children: [
        makeLeaf('group-1', 'panel-1', 300),
        {
          type: 'branch',
          size: 600,
          children: [
            makeLeaf('group-2', 'panel-2', 450),
            {
              type: 'branch',
              size: 450,
              visible: true,
              children: [
                makeLeaf('group-3', 'panel-3', 200),
                makeLeaf('group-4', 'panel-4', 250),
              ],
            },
          ],
        },
      ],
    },
    orientation: 1,
    width: 1600,
    height: 900,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Recursively finds the first leaf node under `root` (test fixtures always have one). */
function findFirstLeaf(root: ISerializedPanelNode): ISerializedPanelLeafNode {
  return root.type === 'leaf' ? root : findFirstLeaf(root.children[0]);
}

/**
 * Walks a deep-cloned, not-yet-validated grid tree (still `unknown` — the
 * clone may be mid-mangling by a test) looking for the leaf with `groupId`,
 * and merges `patch` onto it in place.
 */
function patchLeafInNode(
  node: unknown,
  groupId: string,
  patch: Record<string, unknown>,
): boolean {
  if (Array.isArray(node)) {
    return node.some((child) => patchLeafInNode(child, groupId, patch));
  }
  if (!isRecord(node)) return false;
  if (node.type === 'leaf' && node.groupId === groupId) {
    Object.assign(node, patch);
    return true;
  }
  if (node.type === 'branch') {
    return patchLeafInNode(node.children, groupId, patch);
  }
  return false;
}

/**
 * Deep-clones `file` and merges `patch` onto the leaf identified by
 * `groupId`. Returns `unknown` (not `SerializablePanelLayoutFile`) so tests
 * can apply intentionally malformed patches without casts.
 */
function withLeafPatched(
  file: SerializablePanelLayoutFile,
  groupId: string,
  patch: Record<string, unknown>,
): unknown {
  const cloned: unknown = JSON.parse(JSON.stringify(file));
  if (isRecord(cloned) && isRecord(cloned.grid)) {
    patchLeafInNode(cloned.grid.root, groupId, patch);
  }
  return cloned;
}

describe('migratePanelLayout', () => {
  it('accepts a valid v1 file and round-trips it by identity', () => {
    const file = makeValidFile();
    const result = migratePanelLayout(file);
    expect(result).toBe(file);
    expect(result).toEqual(makeValidFile());
  });

  it('accepts a single-leaf root grid', () => {
    const file: SerializablePanelLayoutFile = {
      version: 1,
      grid: {
        root: makeLeaf('group-only', 'panel-only', 800),
        orientation: 1,
        width: 800,
        height: 600,
      },
      activeGroupId: 'group-only',
      mostRecentActiveGroupIds: [],
    };
    expect(migratePanelLayout(file)).toBe(file);
  });

  it('rejects null, undefined, and non-object values', () => {
    expect(migratePanelLayout(null)).toBeNull();
    expect(migratePanelLayout(undefined)).toBeNull();
    expect(migratePanelLayout('layout')).toBeNull();
    expect(migratePanelLayout(42)).toBeNull();
    expect(migratePanelLayout([makeValidFile()])).toBeNull();
  });

  it('rejects wrong or forward versions', () => {
    expect(migratePanelLayout({ ...makeValidFile(), version: 0 })).toBeNull();
    expect(migratePanelLayout({ ...makeValidFile(), version: 2 })).toBeNull();
    expect(migratePanelLayout({ ...makeValidFile(), version: '1' })).toBeNull();
    expect(migratePanelLayout({ ...makeValidFile(), version: 1.5 })).toBeNull();
  });

  it('rejects a missing or malformed grid', () => {
    const withoutGrid: Record<string, unknown> = { ...makeValidFile() };
    delete withoutGrid.grid;
    expect(migratePanelLayout(withoutGrid)).toBeNull();
    expect(migratePanelLayout({ ...makeValidFile(), grid: null })).toBeNull();
    expect(
      migratePanelLayout({
        ...makeValidFile(),
        grid: {
          root: makeLeaf('g', 'p'),
          orientation: 2,
          width: 10,
          height: 10,
        },
      }),
    ).toBeNull();
  });

  it('rejects a node with a bad discriminant', () => {
    expect(
      migratePanelLayout({
        ...makeValidFile(),
        grid: {
          root: {
            type: 'twig',
            groupId: 'g',
            panels: [],
            activePanelId: null,
            size: 1,
          },
          orientation: 0,
          width: 100,
          height: 100,
        },
      }),
    ).toBeNull();
  });

  it('rejects a leaf with a non-string groupId', () => {
    expect(
      migratePanelLayout({
        ...makeValidFile(),
        grid: {
          root: {
            type: 'leaf',
            groupId: 42,
            panels: [{ panelId: 'panel-1', kind: 'chat' }],
            activePanelId: 'panel-1',
            size: 100,
          },
          orientation: 0,
          width: 100,
          height: 100,
        },
      }),
    ).toBeNull();
  });

  it('rejects a leaf carrying branch children', () => {
    expect(
      migratePanelLayout({
        ...makeValidFile(),
        grid: {
          root: {
            type: 'leaf',
            groupId: 'group-a',
            panels: [{ panelId: 'panel-1', kind: 'chat' }],
            activePanelId: 'panel-1',
            size: 100,
            children: [makeLeaf('group-b', 'panel-2')],
          },
          orientation: 0,
          width: 100,
          height: 100,
        },
      }),
    ).toBeNull();
  });

  it('rejects a panel entry with an unknown kind', () => {
    expect(
      migratePanelLayout({
        ...makeValidFile(),
        grid: {
          root: {
            type: 'leaf',
            groupId: 'group-a',
            panels: [{ panelId: 'panel-1', kind: 'holograph' }],
            activePanelId: 'panel-1',
            size: 100,
          },
          orientation: 0,
          width: 100,
          height: 100,
        },
      }),
    ).toBeNull();
  });

  it('accepts the optional additive panel entry title, including over-length values', () => {
    function fileWithTitle(title: unknown): Record<string, unknown> {
      return {
        ...makeValidFile(),
        grid: {
          root: {
            type: 'leaf',
            groupId: 'group-a',
            panels: [{ panelId: 'panel-1', kind: 'chat', title }],
            activePanelId: 'panel-1',
            size: 400,
          },
          orientation: 0,
          width: 800,
          height: 600,
        },
      };
    }

    const titled = fileWithTitle('My Chat');
    expect(migratePanelLayout(titled)).toBe(titled);

    // Empty string is a valid (if useless) title — type-only validation.
    const empty = fileWithTitle('');
    expect(migratePanelLayout(empty)).toBe(empty);

    // Length is normalized by readers/writers via clampPanelTitle, never a
    // rejection reason: an over-length title must not cost the whole layout.
    const long = fileWithTitle('x'.repeat(PANEL_TITLE_MAX_LENGTH + 100));
    expect(migratePanelLayout(long)).toBe(long);

    // Popped-out aux grids share the same leaf shape, so titled entries are
    // valid there too.
    const poppedFile: SerializablePanelLayoutFile = {
      ...makeValidFile(),
      poppedOut: [
        {
          windowId: 'aux-window-1',
          grid: {
            root: {
              type: 'leaf',
              groupId: 'group-aux',
              panels: [
                { panelId: 'panel-aux', kind: 'terminal', title: 'Build' },
              ],
              activePanelId: 'panel-aux',
              size: 500,
            },
            orientation: 0,
            width: 640,
            height: 480,
          },
          bounds: { x: 10, y: 20, width: 640, height: 480 },
          sourceGroupId: 'group-a',
        },
      ],
    };
    expect(migratePanelLayout(poppedFile)).toBe(poppedFile);
  });

  it('rejects a panel entry with a non-string title', () => {
    for (const badTitle of [42, null, {}, ['title']]) {
      expect(
        migratePanelLayout({
          ...makeValidFile(),
          grid: {
            root: {
              type: 'leaf',
              groupId: 'group-a',
              panels: [{ panelId: 'panel-1', kind: 'chat', title: badTitle }],
              activePanelId: 'panel-1',
              size: 400,
            },
            orientation: 0,
            width: 800,
            height: 600,
          },
        }),
      ).toBeNull();
    }
  });

  it('accepts the optional additive panel entry pinned flag and round-trips it', () => {
    function fileWithPinned(pinned: unknown): Record<string, unknown> {
      return {
        ...makeValidFile(),
        grid: {
          root: {
            type: 'leaf',
            groupId: 'group-a',
            panels: [
              {
                panelId: 'panel-1',
                kind: 'chat',
                instance: { chatTabId: 'chat-1' },
                pinned,
              },
            ],
            activePanelId: 'panel-1',
            size: 400,
          },
          orientation: 0,
          width: 800,
          height: 600,
        },
      };
    }

    const pinned = fileWithPinned(true);
    expect(migratePanelLayout(pinned)).toBe(pinned);
    const unpinned = fileWithPinned(false);
    expect(migratePanelLayout(unpinned)).toBe(unpinned);
  });

  it('rejects a panel entry with a non-boolean pinned flag', () => {
    for (const badPinned of [1, 'true', null, {}, ['pinned']]) {
      expect(
        migratePanelLayout({
          ...makeValidFile(),
          grid: {
            root: {
              type: 'leaf',
              groupId: 'group-a',
              panels: [{ panelId: 'panel-1', kind: 'chat', pinned: badPinned }],
              activePanelId: 'panel-1',
              size: 400,
            },
            orientation: 0,
            width: 800,
            height: 600,
          },
        }),
      ).toBeNull();
    }
  });

  it('accepts the two per-entity panel kinds (file-explorer, activity-card)', () => {
    const file = {
      ...makeValidFile(),
      grid: {
        root: {
          type: 'branch',
          size: 800,
          children: [
            {
              type: 'leaf',
              groupId: 'group-a',
              panels: [{ panelId: 'panel-1', kind: 'file-explorer' }],
              activePanelId: 'panel-1',
              size: 400,
            },
            {
              type: 'leaf',
              groupId: 'group-b',
              panels: [
                {
                  panelId: 'panel-2',
                  kind: 'activity-card',
                  instance: { sectionId: 'changed-files' },
                },
              ],
              activePanelId: 'panel-2',
              size: 400,
            },
          ],
        },
        orientation: 1,
        width: 800,
        height: 600,
      },
    };
    expect(migratePanelLayout(file)).toBe(file);
  });

  describe('panel entry instance validation', () => {
    function fileWithInstance(instance: unknown): Record<string, unknown> {
      return {
        ...makeValidFile(),
        grid: {
          root: {
            type: 'leaf',
            groupId: 'group-a',
            panels: [{ panelId: 'panel-1', kind: 'chat', instance }],
            activePanelId: 'panel-1',
            size: 400,
          },
          orientation: 0,
          width: 800,
          height: 600,
        },
      };
    }

    it('accepts a valid flat string→string instance map', () => {
      const valid = fileWithInstance({ chatTabId: 'chat-1' });
      expect(migratePanelLayout(valid)).toBe(valid);
      expect(isPanelInstanceRecord({ chatTabId: 'chat-1' })).toBe(true);
      expect(isPanelInstanceRecord({})).toBe(true);
    });

    it('rejects non-object instance values', () => {
      for (const bad of ['chat-1', 42, null, ['chatTabId']]) {
        expect(isPanelInstanceRecord(bad)).toBe(false);
        expect(migratePanelLayout(fileWithInstance(bad))).toBeNull();
      }
    });

    it('rejects non-string instance values', () => {
      for (const bad of [42, null, {}, ['x'], true]) {
        expect(migratePanelLayout(fileWithInstance({ key: bad }))).toBeNull();
      }
    });

    it('rejects instance maps with more than the max key count', () => {
      const atLimit: Record<string, string> = {};
      for (let index = 0; index < PANEL_INSTANCE_MAX_KEYS; index += 1) {
        atLimit[`key-${index}`] = 'value';
      }
      const okFile = fileWithInstance(atLimit);
      expect(migratePanelLayout(okFile)).toBe(okFile);

      const overLimit = { ...atLimit, overflow: 'value' };
      expect(migratePanelLayout(fileWithInstance(overLimit))).toBeNull();
    });

    it('rejects over-length keys and values instead of clamping (identity bindings)', () => {
      const longKey = 'k'.repeat(PANEL_INSTANCE_KEY_MAX_LENGTH + 1);
      expect(
        migratePanelLayout(fileWithInstance({ [longKey]: 'value' })),
      ).toBeNull();

      const longValue = 'v'.repeat(PANEL_INSTANCE_VALUE_MAX_LENGTH + 1);
      expect(
        migratePanelLayout(fileWithInstance({ chatTabId: longValue })),
      ).toBeNull();

      // At the caps exactly, the file stays valid.
      const maxKey = 'k'.repeat(PANEL_INSTANCE_KEY_MAX_LENGTH);
      const maxValue = 'v'.repeat(PANEL_INSTANCE_VALUE_MAX_LENGTH);
      const okFile = fileWithInstance({ [maxKey]: maxValue });
      expect(migratePanelLayout(okFile)).toBe(okFile);
    });
  });

  describe('browser panel instance contract', () => {
    function browserPanel(
      panelId: string,
      browserId: string,
    ): ISerializedPanelLeafNode['panels'][number] {
      return {
        panelId,
        kind: 'browser',
        instance: { browserId },
      };
    }

    it('requires exactly one non-empty browserId instance binding', () => {
      const invalidInstances = [
        undefined,
        {},
        { browserId: '' },
        { browserId: '   ' },
        {
          browserId: 'browser-1',
          extra: 'value',
        },
      ];
      for (const instance of invalidInstances) {
        expect(
          migratePanelLayout({
            ...makeValidFile(),
            grid: {
              root: {
                type: 'leaf',
                groupId: 'group-browser',
                panels: [
                  { panelId: 'panel-browser', kind: 'browser', instance },
                ],
                activePanelId: 'panel-browser',
                size: 400,
              },
              orientation: 0,
              width: 800,
              height: 600,
            },
            activeGroupId: 'group-browser',
          }),
        ).toBeNull();
      }
    });

    it('allows multiple distinct browser sessions in the main layout', () => {
      const file: SerializablePanelLayoutFile = {
        ...makeValidFile(),
        grid: {
          root: {
            type: 'branch',
            size: 800,
            children: [
              {
                type: 'leaf',
                groupId: 'group-browser-a',
                panels: [browserPanel('panel-browser-a', 'browser-a')],
                activePanelId: 'panel-browser-a',
                size: 400,
              },
              {
                type: 'leaf',
                groupId: 'group-browser-b',
                panels: [browserPanel('panel-browser-b', 'browser-b')],
                activePanelId: 'panel-browser-b',
                size: 400,
              },
            ],
          },
          orientation: 1,
          width: 800,
          height: 600,
        },
        activeGroupId: 'group-browser-a',
      };
      expect(migratePanelLayout(file)).toBe(file);
    });

    it('rejects duplicate browser bindings across main-layout groups', () => {
      const file = {
        ...makeValidFile(),
        grid: {
          root: {
            type: 'branch',
            size: 800,
            children: [
              {
                type: 'leaf',
                groupId: 'group-browser-a',
                panels: [browserPanel('panel-browser-a', 'browser-shared')],
                activePanelId: 'panel-browser-a',
                size: 400,
              },
              {
                type: 'leaf',
                groupId: 'group-browser-b',
                panels: [browserPanel('panel-browser-b', 'browser-shared')],
                activePanelId: 'panel-browser-b',
                size: 400,
              },
            ],
          },
          orientation: 1 as const,
          width: 800,
          height: 600,
        },
      };
      expect(migratePanelLayout(file)).toBeNull();
    });

    it('rejects browser panels in popped-out auxiliary windows', () => {
      const file = {
        ...makeValidFile(),
        poppedOut: [
          {
            windowId: 'aux-browser',
            grid: {
              root: {
                type: 'leaf',
                groupId: 'group-browser-aux',
                panels: [browserPanel('panel-browser', 'browser-1')],
                activePanelId: 'panel-browser',
                size: 500,
              },
              orientation: 0,
              width: 640,
              height: 480,
            },
            bounds: { x: 10, y: 20, width: 640, height: 480 },
            sourceGroupId: 'group-a',
          },
        ],
      };
      expect(migratePanelLayout(file)).toBeNull();
    });
  });

  describe('pipeline-execution panel instance contract', () => {
    function runPanel(
      panelId: string,
      instance: unknown,
    ): Record<string, unknown> {
      return { panelId, kind: 'pipeline-execution', instance };
    }

    function runLeaf(
      groupId: string,
      panels: readonly Record<string, unknown>[],
      activePanelId: string | null = null,
    ): Record<string, unknown> {
      return { type: 'leaf', groupId, panels, activePanelId, size: 400 };
    }

    function mainFile(
      ...leaves: readonly Record<string, unknown>[]
    ): Record<string, unknown> {
      return {
        ...makeValidFile(),
        grid: {
          root: {
            type: 'branch',
            size: 800,
            children: [makeLeaf('group-a', 'panel-1', 400), ...leaves],
          },
          orientation: 1,
          width: 800,
          height: 600,
        },
      };
    }

    function poppedWindow(
      windowId: string,
      leaf: Record<string, unknown>,
    ): Record<string, unknown> {
      return {
        windowId,
        grid: { root: leaf, orientation: 0, width: 640, height: 480 },
        bounds: { x: 10, y: 20, width: 640, height: 480 },
        sourceGroupId: 'group-a',
      };
    }

    it('is a repeatable, non-singleton wire kind', () => {
      expect(PANEL_KINDS).toContain('pipeline-execution');
      expect(SINGLETON_PANEL_KINDS.has('pipeline-execution')).toBe(false);
    });

    it('accepts exactly one trimmed, non-empty, bounded executionId', () => {
      expect(isPipelineExecutionPanelInstance({ executionId: 'run-1' })).toBe(
        true,
      );
      const atCap = 'e'.repeat(PIPELINE_EXECUTION_PANEL_ID_MAX_LENGTH);
      expect(isPipelineExecutionPanelInstance({ executionId: atCap })).toBe(
        true,
      );
      for (const invalid of [
        undefined,
        null,
        'run-1',
        ['run-1'],
        {},
        { executionId: '' },
        { executionId: '   ' },
        { executionId: ' run-1' },
        { executionId: 'run-1\n' },
        { executionId: 42 },
        { executionId: `${atCap}e` },
        { executionId: 'run-1', jobId: 'job-1' },
        { runId: 'run-1' },
      ]) {
        expect(isPipelineExecutionPanelInstance(invalid)).toBe(false);
      }
    });

    it('keeps distinct runs in the main grid and in popped-out windows', () => {
      const file = {
        ...mainFile(
          runLeaf('group-runs', [
            runPanel('panel-pipeline-run-1', { executionId: 'run-1' }),
            runPanel('panel-pipeline-run-2', { executionId: 'run-2' }),
          ]),
        ),
        // Unlike `browser`, run panels may live in auxiliary windows.
        poppedOut: [
          poppedWindow(
            'aux-run',
            runLeaf('group-aux-run', [
              runPanel('panel-pipeline-run-3', { executionId: 'run-3' }),
            ]),
          ),
        ],
      };
      expect(isSerializablePanelLayoutFile(file)).toBe(true);
      expect(migratePanelLayout(file)).toBe(file);
    });

    it('drops only the malformed run entries instead of rejecting the file', () => {
      const file = {
        ...mainFile(
          runLeaf(
            'group-runs',
            [
              runPanel('panel-unbound', undefined),
              runPanel('panel-pipeline-run-1', { executionId: 'run-1' }),
              runPanel('panel-padded', { executionId: ' run-2 ' }),
            ],
            'panel-unbound',
          ),
        ),
        poppedOut: [
          poppedWindow(
            'aux-run',
            runLeaf('group-aux-run', [
              runPanel('panel-extra-key', {
                executionId: 'run-4',
                jobId: 'job-1',
              }),
              { panelId: 'panel-aux-chat', kind: 'chat' },
            ]),
          ),
        ],
      };
      // Strict entry validation still rejects the raw shape...
      expect(isSerializablePanelLayoutFile(file)).toBe(false);

      // ...but migration keeps the layout, minus just those entries.
      const migrated = migratePanelLayout(file);
      expect(migrated).not.toBeNull();
      if (migrated === null) return;
      const root = migrated.grid.root;
      expect(root.type).toBe('branch');
      if (root.type !== 'branch') return;
      const runs = root.children[1];
      expect(runs.type === 'leaf' ? runs.panels : []).toEqual([
        {
          panelId: 'panel-pipeline-run-1',
          kind: 'pipeline-execution',
          instance: { executionId: 'run-1' },
        },
      ]);
      // The desktop reader normalizes a dangling active id; migration leaves it.
      expect(runs.type === 'leaf' ? runs.activePanelId : null).toBe(
        'panel-unbound',
      );
      expect(root.children[0]).toEqual(makeLeaf('group-a', 'panel-1', 400));
      const auxRoot = migrated.poppedOut?.[0]?.grid.root;
      expect(auxRoot?.type === 'leaf' ? auxRoot.panels : []).toEqual([
        { panelId: 'panel-aux-chat', kind: 'chat' },
      ]);
      expect(migrated.activeGroupId).toBe('group-a');
    });

    it('still rejects the file for every other kind of corruption', () => {
      const file = mainFile(
        runLeaf('group-runs', [
          runPanel('panel-unbound', undefined),
          { panelId: 'panel-bad-title', kind: 'chat', title: 42 },
        ]),
      );
      expect(migratePanelLayout(file)).toBeNull();
    });
  });

  describe('subagent panel kinds', () => {
    function subagentPanel(
      panelId: string,
      instance: unknown,
    ): Record<string, unknown> {
      return { panelId, kind: 'subagent-chat', instance };
    }

    function subagentLeaf(
      groupId: string,
      panels: readonly Record<string, unknown>[],
      activePanelId: string | null = null,
    ): Record<string, unknown> {
      return { type: 'leaf', groupId, panels, activePanelId, size: 400 };
    }

    function mainFile(
      ...leaves: readonly Record<string, unknown>[]
    ): Record<string, unknown> {
      return {
        ...makeValidFile(),
        grid: {
          root: {
            type: 'branch',
            size: 800,
            children: [makeLeaf('group-a', 'panel-1', 400), ...leaves],
          },
          orientation: 1,
          width: 800,
          height: 600,
        },
      };
    }

    const binding = {
      rootChatId: 'chat-root',
      subagentId: 'delegation-1',
      subagentKind: 'managed',
    };

    it('registers subagents as a singleton and subagent-chat as repeatable', () => {
      expect(PANEL_KINDS).toEqual(
        expect.arrayContaining(['subagents', 'subagent-chat']),
      );
      expect(SINGLETON_PANEL_KINDS.has('subagents')).toBe(true);
      expect(SINGLETON_PANEL_KINDS.has('subagent-chat')).toBe(false);
    });

    it('exposes the closed, frozen subagent kind list', () => {
      expect(SUBAGENT_KINDS).toEqual([
        'managed',
        'claude-native',
        'codex-native',
        'workflow-agent',
      ]);
      expect(Object.isFrozen(SUBAGENT_KINDS)).toBe(true);
      for (const kind of SUBAGENT_KINDS) {
        expect(isSubagentKind(kind)).toBe(true);
      }
      for (const invalid of [
        undefined,
        null,
        '',
        'Managed',
        'native',
        'workflow-run',
        'workflow-phase',
        1,
      ]) {
        expect(isSubagentKind(invalid)).toBe(false);
      }
    });

    it('accepts exactly the three trimmed, non-empty, bounded binding keys', () => {
      expect(isSubagentChatPanelInstance(binding)).toBe(true);
      expect(
        isSubagentChatPanelInstance({
          ...binding,
          subagentKind: 'workflow-agent',
        }),
      ).toBe(true);
      const atCap = 's'.repeat(SUBAGENT_CHAT_PANEL_ID_MAX_LENGTH);
      expect(
        isSubagentChatPanelInstance({
          rootChatId: atCap,
          subagentId: atCap,
          subagentKind: 'codex-native',
        }),
      ).toBe(true);
      for (const invalid of [
        undefined,
        null,
        'chat-root',
        [binding],
        {},
        { rootChatId: 'chat-root', subagentId: 'delegation-1' },
        { ...binding, rootChatId: '' },
        { ...binding, rootChatId: ' chat-root' },
        { ...binding, subagentId: 'delegation-1\n' },
        { ...binding, subagentId: '   ' },
        { ...binding, subagentId: 42 },
        { ...binding, subagentId: `${atCap}s` },
        { ...binding, rootChatId: `${atCap}s` },
        { ...binding, subagentKind: 'native' },
        { ...binding, subagentKind: '' },
        { ...binding, extra: 'x' },
      ]) {
        expect(isSubagentChatPanelInstance(invalid)).toBe(false);
      }
    });

    it('round-trips a layout holding both kinds, including in a popped-out window', () => {
      const file = {
        ...mainFile(
          subagentLeaf('group-subagents', [
            { panelId: 'panel-subagents', kind: 'subagents' },
            subagentPanel('panel-subagent-chat-1', binding),
          ]),
        ),
        poppedOut: [
          {
            windowId: 'aux-subagent',
            grid: {
              root: subagentLeaf('group-aux-subagent', [
                subagentPanel('panel-subagent-chat-2', {
                  rootChatId: 'chat-root',
                  subagentId: 'toolu_1',
                  subagentKind: 'claude-native',
                }),
              ]),
              orientation: 0,
              width: 640,
              height: 480,
            },
            bounds: { x: 10, y: 20, width: 640, height: 480 },
            sourceGroupId: 'group-a',
          },
        ],
      };
      expect(isSerializablePanelLayoutFile(file)).toBe(true);
      expect(migratePanelLayout(file)).toBe(file);
    });

    it('drops only the malformed subagent-chat entries instead of rejecting the file', () => {
      const file = mainFile(
        subagentLeaf(
          'group-subagents',
          [
            subagentPanel('panel-unbound', undefined),
            { panelId: 'panel-subagents', kind: 'subagents' },
            subagentPanel('panel-subagent-chat-1', binding),
            subagentPanel('panel-bad-kind', {
              ...binding,
              subagentId: 'delegation-2',
              subagentKind: 'other',
            }),
            subagentPanel('panel-padded', {
              ...binding,
              subagentId: ' delegation-3 ',
            }),
          ],
          'panel-unbound',
        ),
      );
      expect(isSerializablePanelLayoutFile(file)).toBe(false);

      const migrated = migratePanelLayout(file);
      expect(migrated).not.toBeNull();
      if (migrated === null) return;
      const root = migrated.grid.root;
      if (root.type !== 'branch') {
        throw new Error('expected a branch root');
      }
      const leaf = root.children[1];
      expect(leaf.type === 'leaf' ? leaf.panels : []).toEqual([
        { panelId: 'panel-subagents', kind: 'subagents' },
        {
          panelId: 'panel-subagent-chat-1',
          kind: 'subagent-chat',
          instance: binding,
        },
      ]);
      expect(root.children[0]).toEqual(makeLeaf('group-a', 'panel-1', 400));
    });
  });

  describe('plan panel instance contract (shape only)', () => {
    function planLeaf(
      groupId: string,
      panels: ISerializedPanelLeafNode['panels'],
    ): ISerializedPanelLeafNode {
      return {
        type: 'leaf',
        groupId,
        panels,
        activePanelId: panels[0]?.panelId ?? null,
        size: 400,
      };
    }

    it('accepts plan and plan-diagram entries with or without a planId in the main grid', () => {
      const file: SerializablePanelLayoutFile = {
        ...makeValidFile(),
        grid: {
          root: {
            type: 'branch',
            size: 800,
            children: [
              planLeaf('group-plan', [
                {
                  panelId: 'panel-plan',
                  kind: 'plan',
                  title: 'Ship it',
                  instance: { planId: 'plan-1' },
                },
                // Missing / blank / duplicate bindings are pruned by the
                // desktop layout store, not rejected here.
                { panelId: 'panel-plan-unbound', kind: 'plan' },
                {
                  panelId: 'panel-plan-blank',
                  kind: 'plan',
                  instance: { planId: '  ' },
                },
                {
                  panelId: 'panel-plan-dup',
                  kind: 'plan',
                  instance: { planId: 'plan-1' },
                },
              ]),
              planLeaf('group-diagram', [
                {
                  panelId: 'panel-plan-diagram',
                  kind: 'plan-diagram',
                  instance: { planId: 'plan-1' },
                },
                { panelId: 'panel-plan-diagram-unbound', kind: 'plan-diagram' },
              ]),
            ],
          },
          orientation: 1,
          width: 800,
          height: 600,
        },
        activeGroupId: 'group-plan',
        mostRecentActiveGroupIds: ['group-plan', 'group-diagram'],
      };
      expect(migratePanelLayout(file)).toBe(file);
    });

    it('accepts plan entries inside popped-out auxiliary windows', () => {
      const popped: SerializedPoppedPanelWindow = {
        windowId: 'aux-plan',
        grid: {
          root: planLeaf('group-plan-aux', [
            {
              panelId: 'panel-plan-aux',
              kind: 'plan',
              instance: { planId: 'plan-2' },
            },
            { panelId: 'panel-plan-diagram-aux', kind: 'plan-diagram' },
          ]),
          orientation: 0,
          width: 640,
          height: 480,
        },
        bounds: { x: 10, y: 20, width: 640, height: 480 },
        sourceGroupId: 'group-a',
      };
      const file: SerializablePanelLayoutFile = {
        ...makeValidFile(),
        poppedOut: [popped],
      };
      expect(migratePanelLayout(file)).toBe(file);
    });

    it('rejects a plan entry whose instance value is not a string', () => {
      for (const kind of ['plan', 'plan-diagram']) {
        for (const bad of [42, null, { nested: 'plan-1' }, ['plan-1']]) {
          expect(
            migratePanelLayout({
              ...makeValidFile(),
              grid: {
                root: {
                  type: 'leaf',
                  groupId: 'group-plan',
                  panels: [
                    { panelId: 'panel-plan', kind, instance: { planId: bad } },
                  ],
                  activePanelId: 'panel-plan',
                  size: 400,
                },
                orientation: 0,
                width: 800,
                height: 600,
              },
              activeGroupId: 'group-plan',
            }),
          ).toBeNull();
        }
      }
    });

    it('does not make either plan kind a worktree singleton', () => {
      expect(PANEL_KINDS).toEqual(
        expect.arrayContaining(['plan', 'plan-diagram']),
      );
      expect([...SINGLETON_PANEL_KINDS].sort()).toEqual([
        'activity-section',
        'change-diagram',
        'cost',
        'file-explorer',
        'ledger',
        'subagents',
      ]);
      expect(SINGLETON_PANEL_KINDS.has('plan')).toBe(false);
      expect(SINGLETON_PANEL_KINDS.has('plan-diagram')).toBe(false);
    });
  });

  describe('Cost panel kinds', () => {
    it('registers cost as a singleton and Session breakdown as repeatable', () => {
      expect(PANEL_KINDS).toEqual(
        expect.arrayContaining(['cost', 'session-breakdown']),
      );
      expect(SINGLETON_PANEL_KINDS.has('cost')).toBe(true);
      expect(SINGLETON_PANEL_KINDS.has('session-breakdown')).toBe(false);
    });

    it('accepts exactly one trimmed, non-empty, bounded chatId', () => {
      expect(isSessionBreakdownPanelInstance({ chatId: 'chat-1' })).toBe(true);
      const atLimit = 'c'.repeat(SESSION_BREAKDOWN_PANEL_ID_MAX_LENGTH);
      expect(isSessionBreakdownPanelInstance({ chatId: atLimit })).toBe(true);

      for (const invalid of [
        undefined,
        null,
        {},
        { chatId: '' },
        { chatId: ' ' },
        { chatId: ' chat-1' },
        { chatId: 'chat-1 ' },
        { chatId: `${atLimit}c` },
        { chatId: 'chat-1', extra: 'unexpected' },
      ]) {
        expect(isSessionBreakdownPanelInstance(invalid)).toBe(false);
      }
    });

    it('drops a malformed breakdown entry and keeps the valid panel', () => {
      const file: SerializablePanelLayoutFile = {
        version: 1,
        grid: {
          root: {
            type: 'leaf',
            groupId: 'group-a',
            panels: [
              {
                panelId: 'panel-bad-breakdown',
                kind: 'session-breakdown',
                instance: { chatId: '  ' },
              },
              { panelId: 'panel-chat', kind: 'chat' },
            ],
            activePanelId: 'panel-chat',
            size: 800,
          },
          orientation: 0,
          width: 800,
          height: 600,
        },
        activeGroupId: 'group-a',
        mostRecentActiveGroupIds: ['group-a'],
      };

      const migrated = migratePanelLayout(file);
      expect(migrated).not.toBeNull();
      if (migrated === null) {
        throw new Error('A malformed Session breakdown should be dropped.');
      }
      expect(findFirstLeaf(migrated.grid.root).panels).toEqual([
        { panelId: 'panel-chat', kind: 'chat' },
      ]);
    });
  });

  it('rejects a non-array mostRecentActiveGroupIds', () => {
    expect(
      migratePanelLayout({
        ...makeValidFile(),
        mostRecentActiveGroupIds: 'group-a',
      }),
    ).toBeNull();
    expect(
      migratePanelLayout({
        ...makeValidFile(),
        mostRecentActiveGroupIds: ['group-a', 7],
      }),
    ).toBeNull();
  });

  it('accepts a valid 3-level nested branch/leaf tree', () => {
    const file: SerializablePanelLayoutFile = {
      version: 1,
      grid: makeDeepGrid(),
      activeGroupId: 'group-3',
      mostRecentActiveGroupIds: ['group-3', 'group-1'],
    };
    expect(migratePanelLayout(file)).toBe(file);
  });

  it('rejects the whole file when one deep leaf is corrupt', () => {
    const corruptDeepLeaf = {
      type: 'leaf',
      groupId: null,
      panels: [{ panelId: 'panel-4', kind: 'browser' }],
      activePanelId: 'panel-4',
      size: 250,
    };
    expect(
      migratePanelLayout({
        version: 1,
        grid: {
          root: {
            type: 'branch',
            size: 900,
            children: [
              makeLeaf('group-1', 'panel-1', 300),
              {
                type: 'branch',
                size: 600,
                children: [
                  makeLeaf('group-2', 'panel-2', 450),
                  {
                    type: 'branch',
                    size: 450,
                    children: [
                      makeLeaf('group-3', 'panel-3', 200),
                      corruptDeepLeaf,
                    ],
                  },
                ],
              },
            ],
          },
          orientation: 1,
          width: 1600,
          height: 900,
        },
        activeGroupId: 'group-1',
        mostRecentActiveGroupIds: ['group-1'],
      }),
    ).toBeNull();
  });

  it('accepts an absent poppedOut and a valid poppedOut', () => {
    const withoutPoppedOut = makeValidFile();
    expect(migratePanelLayout(withoutPoppedOut)).toBe(withoutPoppedOut);

    const poppedOut: readonly SerializedPoppedPanelWindow[] = [
      {
        windowId: 'aux-window-1',
        grid: {
          root: makeLeaf('group-aux', 'panel-aux', 500),
          orientation: 0,
          width: 640,
          height: 480,
        },
        bounds: { x: -100, y: 40, width: 640, height: 480 },
        sourceGroupId: 'group-a',
      },
    ];
    const withPoppedOut: SerializablePanelLayoutFile = {
      ...makeValidFile(),
      poppedOut,
    };
    expect(migratePanelLayout(withPoppedOut)).toBe(withPoppedOut);
  });

  it('accepts the optional additive poppedOut focus fields (Phase 9)', () => {
    const entry: SerializedPoppedPanelWindow = {
      windowId: 'aux-window-1',
      grid: {
        root: makeLeaf('group-aux', 'panel-aux', 500),
        orientation: 0,
        width: 640,
        height: 480,
      },
      bounds: { x: 10, y: 20, width: 640, height: 480 },
      sourceGroupId: 'group-a',
      returnTarget: {
        anchorGroupId: 'group-main',
        direction: 'down',
        size: 240,
      },
      activeGroupId: 'group-aux',
      mostRecentActiveGroupIds: ['group-aux'],
    };
    const file: SerializablePanelLayoutFile = {
      ...makeValidFile(),
      poppedOut: [entry],
    };
    expect(migratePanelLayout(file)).toBe(file);
  });

  it('rejects invalid values in the optional poppedOut focus fields', () => {
    const base = {
      windowId: 'aux-window-1',
      grid: {
        root: makeLeaf('group-aux', 'panel-aux', 500),
        orientation: 0,
        width: 640,
        height: 480,
      },
      bounds: { x: 10, y: 20, width: 640, height: 480 },
      sourceGroupId: 'group-a',
    };
    expect(
      migratePanelLayout({
        ...makeValidFile(),
        poppedOut: [{ ...base, activeGroupId: '' }],
      }),
    ).toBeNull();
    expect(
      migratePanelLayout({
        ...makeValidFile(),
        poppedOut: [
          { ...base, returnTarget: { anchorGroupId: '', direction: 'down' } },
        ],
      }),
    ).toBeNull();
    expect(
      migratePanelLayout({
        ...makeValidFile(),
        poppedOut: [
          {
            ...base,
            returnTarget: {
              anchorGroupId: 'group-main',
              direction: 'diagonal',
            },
          },
        ],
      }),
    ).toBeNull();
    expect(
      migratePanelLayout({
        ...makeValidFile(),
        poppedOut: [{ ...base, mostRecentActiveGroupIds: ['group-aux', 7] }],
      }),
    ).toBeNull();
  });

  it('rejects a malformed poppedOut', () => {
    expect(
      migratePanelLayout({ ...makeValidFile(), poppedOut: 'nope' }),
    ).toBeNull();
    expect(
      migratePanelLayout({
        ...makeValidFile(),
        poppedOut: [
          {
            windowId: 'aux-window-1',
            grid: {
              root: makeLeaf('group-aux', 'panel-aux', 500),
              orientation: 0,
              width: 640,
              height: 480,
            },
            bounds: { x: 0, y: 0, width: Number.NaN, height: 480 },
            sourceGroupId: 'group-a',
          },
        ],
      }),
    ).toBeNull();
    expect(
      migratePanelLayout({
        ...makeValidFile(),
        poppedOut: [{ windowId: 'aux-window-1' }],
      }),
    ).toBeNull();
  });

  it('never throws on hostile input', () => {
    expect(() => migratePanelLayout(Symbol('layout'))).not.toThrow();
    expect(() =>
      migratePanelLayout({
        version: 1,
        grid: { root: { type: 'branch', children: null } },
      }),
    ).not.toThrow();
  });
});

describe('clampPanelTitle', () => {
  it('returns titles at or under the cap unchanged and truncates the rest', () => {
    expect(clampPanelTitle('')).toBe('');
    expect(clampPanelTitle('Terminal')).toBe('Terminal');
    const atCap = 'x'.repeat(PANEL_TITLE_MAX_LENGTH);
    expect(clampPanelTitle(atCap)).toBe(atCap);
    expect(clampPanelTitle(`${atCap}overflow`)).toBe(atCap);
  });
});

describe('type guards', () => {
  it('isSerializedPanelNode validates branches and leaves recursively', () => {
    expect(isSerializedPanelNode(makeLeaf('group-a', 'panel-1'))).toBe(true);
    expect(isSerializedPanelNode(makeDeepGrid().root)).toBe(true);
    expect(
      isSerializedPanelNode({ type: 'branch', children: [], size: 1 }),
    ).toBe(false);
    expect(isSerializedPanelNode(null)).toBe(false);
  });

  it('isSerializedPanelGrid validates dimensions and orientation', () => {
    expect(isSerializedPanelGrid(makeDeepGrid())).toBe(true);
    expect(
      isSerializedPanelGrid({
        root: makeLeaf('g', 'p'),
        orientation: 0,
        width: Number.POSITIVE_INFINITY,
        height: 100,
      }),
    ).toBe(false);
  });

  it('isSerializablePanelLayoutFile matches migratePanelLayout for v1 shapes', () => {
    expect(isSerializablePanelLayoutFile(makeValidFile())).toBe(true);
    expect(
      isSerializablePanelLayoutFile({ ...makeValidFile(), version: 2 }),
    ).toBe(false);
  });
});

describe('collapsed leaf field', () => {
  test('accepts a leaf with a well-typed collapsed state', () => {
    const file = makeValidFile();
    const leaf = findFirstLeaf(file.grid.root);
    const withCollapsed = withLeafPatched(file, leaf.groupId, {
      collapsed: { edge: 'left', expandedSize: 240 },
    });
    expect(migratePanelLayout(withCollapsed)).toEqual(withCollapsed);
  });

  test('accepts a leaf without collapsed (additive field)', () => {
    const file = makeValidFile();
    expect(migratePanelLayout(file)).toEqual(file);
  });

  test('round-trips the auto flag (CAN-2836 reopen decision)', () => {
    const file = makeValidFile();
    const leaf = findFirstLeaf(file.grid.root);
    const withAuto = withLeafPatched(file, leaf.groupId, {
      collapsed: { edge: 'right', expandedSize: 360, auto: true },
    });
    expect(migratePanelLayout(withAuto)).toEqual(withAuto);
  });

  test('accepts a collapsed state without auto (additive field)', () => {
    const file = makeValidFile();
    const leaf = findFirstLeaf(file.grid.root);
    const withCollapsed = withLeafPatched(file, leaf.groupId, {
      collapsed: { edge: 'right', expandedSize: 360 },
    });
    expect(migratePanelLayout(withCollapsed)).toEqual(withCollapsed);
  });

  test.each([
    { collapsed: { edge: 'diagonal', expandedSize: 240 } },
    { collapsed: { edge: 'left', expandedSize: 0 } },
    { collapsed: { edge: 'left', expandedSize: Number.NaN } },
    { collapsed: { edge: 'left' } },
    { collapsed: 'left' },
    { collapsed: true },
    { collapsed: { edge: 'left', expandedSize: 240, auto: 'true' } },
    { collapsed: { edge: 'left', expandedSize: 240, auto: 1 } },
    { collapsed: { edge: 'left', expandedSize: 240, auto: null } },
  ])('rejects the file on malformed collapsed %j', (patch) => {
    const file = makeValidFile();
    const leaf = findFirstLeaf(file.grid.root);
    const mangled = withLeafPatched(file, leaf.groupId, patch);
    expect(migratePanelLayout(mangled)).toBeNull();
  });

  test('isPanelCollapsedState validates shape', () => {
    expect(isPanelCollapsedState({ edge: 'bottom', expandedSize: 120 })).toBe(
      true,
    );
    expect(isPanelCollapsedState({ edge: 'bottom', expandedSize: -1 })).toBe(
      false,
    );
    expect(isPanelCollapsedState(null)).toBe(false);
    expect(
      isPanelCollapsedState({ edge: 'bottom', expandedSize: 120, auto: true }),
    ).toBe(true);
    expect(
      isPanelCollapsedState({ edge: 'bottom', expandedSize: 120, auto: false }),
    ).toBe(true);
    expect(
      isPanelCollapsedState({ edge: 'bottom', expandedSize: 120, auto: 'yes' }),
    ).toBe(false);
  });
});

describe('collapsed branch restore extent', () => {
  test.each([undefined, 240])(
    'accepts the additive saved extent %p',
    (expandedSize) => {
      expect(
        isSerializedPanelNode({
          type: 'branch',
          size: 48,
          expandedSize,
          children: [makeLeaf('a', 'a'), makeLeaf('b', 'b')],
        }),
      ).toBe(true);
    },
  );
  test.each([-1, Number.NaN, Number.POSITIVE_INFINITY, '240', null])(
    'rejects a malformed saved branch extent %p',
    (expandedSize) => {
      expect(
        isSerializedPanelNode({
          type: 'branch',
          size: 48,
          expandedSize,
          children: [makeLeaf('a', 'a'), makeLeaf('b', 'b')],
        }),
      ).toBe(false);
    },
  );
});

describe('expanded sibling proportions', () => {
  test.each([undefined, [420, 380]])(
    'accepts saved sibling sizes %p',
    (expandedSizes) => {
      expect(
        isSerializedPanelNode({
          type: 'branch',
          size: 800,
          expandedSizes,
          children: [makeLeaf('a', 'a'), makeLeaf('b', 'b')],
        }),
      ).toBe(true);
    },
  );
  test.each([[], [420], [420, -1], [0, 0], [420, Number.NaN], '420,380', null])(
    'rejects malformed sibling sizes %p',
    (expandedSizes) => {
      expect(
        isSerializedPanelNode({
          type: 'branch',
          size: 800,
          expandedSizes,
          children: [makeLeaf('a', 'a'), makeLeaf('b', 'b')],
        }),
      ).toBe(false);
    },
  );
});
