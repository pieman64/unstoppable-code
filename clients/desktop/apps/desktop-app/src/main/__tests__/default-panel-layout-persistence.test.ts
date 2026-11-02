import { readFileSync, writeFileSync } from 'node:fs';
import type { PanelLayoutSurface } from '@canopy/desktop-shared/types';
import type { SerializablePanelLayoutFile } from '@canopy/protocol/panels';

jest.mock('node:fs', () => ({
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  mkdirSync: jest.fn(),
}));

jest.mock('../lib/paths', () => ({
  getDefaultPanelLayoutFilePath: (surface: PanelLayoutSurface): string =>
    surface === 'cowork'
      ? '/tmp/default-panel-layout.cowork.json'
      : '/tmp/default-panel-layout.json',
}));

import { defaultPanelLayoutStore } from '../panels/default-layout-persistence';

const mockRead = readFileSync as jest.MockedFunction<typeof readFileSync>;
const mockWrite = writeFileSync as jest.MockedFunction<typeof writeFileSync>;

function isVersionedLayoutWriteForTest(
  value: unknown,
): value is { version: number; layout: { activeGroupId: string } } {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  if (!('version' in value) || !('layout' in value)) {
    return false;
  }
  const layout: unknown = value.layout;
  if (typeof layout !== 'object' || layout === null) {
    return false;
  }
  return 'activeGroupId' in layout && typeof layout.activeGroupId === 'string';
}

const VALID_LAYOUT: SerializablePanelLayoutFile = {
  version: 1,
  grid: {
    root: {
      type: 'leaf',
      groupId: 'group-chat',
      panels: [{ panelId: 'panel-terminal', kind: 'terminal' }],
      activePanelId: 'panel-terminal',
      size: 800,
    },
    orientation: 1,
    width: 1200,
    height: 800,
  },
  activeGroupId: 'group-chat',
  mostRecentActiveGroupIds: ['group-chat'],
};

describe('defaultPanelLayoutStore', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns null when the file is missing', () => {
    mockRead.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    expect(defaultPanelLayoutStore.loadDefaultLayout('code')).toBeNull();
    expect(defaultPanelLayoutStore.loadDefaultLayout('cowork')).toBeNull();
  });

  it('round-trips a saved default through the { version, layout } wrapper', () => {
    defaultPanelLayoutStore.saveDefaultLayout('code', VALID_LAYOUT);
    expect(mockWrite).toHaveBeenCalledTimes(1);
    const written = mockWrite.mock.calls[0][1];
    const parsedJson: unknown = JSON.parse(
      typeof written === 'string' ? written : '',
    );
    if (!isVersionedLayoutWriteForTest(parsedJson)) {
      throw new Error('Expected versioned default layout write');
    }
    const parsed = parsedJson;
    expect(parsed.version).toBe(1);
    expect(parsed.layout.activeGroupId).toBe('group-chat');

    mockRead.mockReturnValue(JSON.stringify(parsed));
    const loaded = defaultPanelLayoutStore.loadDefaultLayout('code');
    expect(loaded).not.toBeNull();
    expect(loaded?.activeGroupId).toBe('group-chat');
  });

  it('keeps code and cowork defaults in separate files', () => {
    defaultPanelLayoutStore.saveDefaultLayout('code', VALID_LAYOUT);
    defaultPanelLayoutStore.saveDefaultLayout('cowork', VALID_LAYOUT);
    expect(mockWrite).toHaveBeenCalledTimes(2);
    expect(mockWrite.mock.calls[0][0]).toBe('/tmp/default-panel-layout.json');
    expect(mockWrite.mock.calls[1][0]).toBe(
      '/tmp/default-panel-layout.cowork.json',
    );

    // The code surface reads the legacy (pre-surface) filename, so defaults
    // saved before surfaces existed keep loading without migration.
    mockRead.mockImplementation((path) => {
      if (path === '/tmp/default-panel-layout.json') {
        return JSON.stringify({ version: 1, layout: VALID_LAYOUT });
      }
      throw new Error('ENOENT');
    });
    expect(defaultPanelLayoutStore.loadDefaultLayout('code')).not.toBeNull();
    expect(defaultPanelLayoutStore.loadDefaultLayout('cowork')).toBeNull();
  });

  it('drops a malformed plan panel instead of discarding the saved default', () => {
    const withBadPlan = {
      ...VALID_LAYOUT,
      grid: {
        ...VALID_LAYOUT.grid,
        root: {
          ...VALID_LAYOUT.grid.root,
          panels: [
            { panelId: 'panel-terminal', kind: 'terminal' },
            {
              panelId: 'panel-plan-bad',
              kind: 'plan',
              instance: { planId: 42 },
            },
          ],
          activePanelId: 'panel-plan-bad',
        },
      },
    };
    mockRead.mockReturnValue(
      JSON.stringify({ version: 1, layout: withBadPlan }),
    );
    const loaded = defaultPanelLayoutStore.loadDefaultLayout('code');
    expect(loaded).not.toBeNull();
    const root = loaded?.grid.root;
    expect(root?.type).toBe('leaf');
    if (root?.type !== 'leaf') {
      throw new Error('Expected a leaf root');
    }
    expect(root.panels.map((panel) => panel.panelId)).toEqual([
      'panel-terminal',
    ]);
    expect(root.activePanelId).toBe('panel-terminal');
  });

  it('still rejects a malformed non-plan panel in the saved default', () => {
    const withBadChat = {
      ...VALID_LAYOUT,
      grid: {
        ...VALID_LAYOUT.grid,
        root: {
          ...VALID_LAYOUT.grid.root,
          panels: [
            { panelId: 'panel-terminal', kind: 'terminal' },
            {
              panelId: 'panel-chat-bad',
              kind: 'chat',
              instance: { chatTabId: 7 },
            },
          ],
        },
      },
    };
    mockRead.mockReturnValue(
      JSON.stringify({ version: 1, layout: withBadChat }),
    );
    expect(defaultPanelLayoutStore.loadDefaultLayout('code')).toBeNull();
  });

  it('drops an invalid layout on save (never clobbers)', () => {
    const invalidLayout: SerializablePanelLayoutFile = {
      version: 1,
      grid: VALID_LAYOUT.grid,
      activeGroupId: 'x',
      mostRecentActiveGroupIds: [],
    };
    // Preserve this malformed input: save receives no grid at runtime.
    Reflect.deleteProperty(invalidLayout, 'grid');
    defaultPanelLayoutStore.saveDefaultLayout('code', invalidLayout);
    expect(mockWrite).not.toHaveBeenCalled();
  });
});
