import type {
  ISerializedPanelGrid,
  SerializablePanelLayoutFile,
} from '@canopy/protocol';
import { migratePanelLayout } from '@canopy/protocol';
import { withoutEphemeralPanels } from '../ephemeral-panels';

function grid(
  extrasPanels: { panelId: string; kind: 'new-tab' | 'file-explorer' }[],
  activePanelId: string | null,
): ISerializedPanelGrid {
  return {
    orientation: 1,
    width: 900,
    height: 600,
    root: {
      type: 'branch',
      size: 900,
      children: [
        {
          type: 'leaf',
          groupId: 'group-chat',
          size: 600,
          panels: [{ panelId: 'panel-chat', kind: 'chat' }],
          activePanelId: 'panel-chat',
        },
        {
          type: 'leaf',
          groupId: 'group-extras',
          size: 300,
          panels: extrasPanels,
          activePanelId,
        },
      ],
    },
  };
}

function file(
  layoutGrid: ISerializedPanelGrid,
  poppedOut?: SerializablePanelLayoutFile['poppedOut'],
): SerializablePanelLayoutFile {
  return {
    version: 1,
    grid: layoutGrid,
    activeGroupId: 'group-chat',
    mostRecentActiveGroupIds: ['group-chat'],
    ...(poppedOut !== undefined ? { poppedOut } : {}),
  };
}

function kindsOf(layout: SerializablePanelLayoutFile): string[] {
  const out: string[] = [];
  const visit = (node: ISerializedPanelGrid['root']): void => {
    if (node.type === 'leaf') {
      out.push(...node.panels.map((panel) => panel.kind));
    } else {
      node.children.forEach(visit);
    }
  };
  visit(layout.grid.root);
  for (const window of layout.poppedOut ?? []) visit(window.grid.root);
  return out;
}

describe('withoutEphemeralPanels', () => {
  it('returns the same file when it holds no New tab', () => {
    const layout = file(
      grid([{ panelId: 'panel-files', kind: 'file-explorer' }], 'panel-files'),
    );
    expect(withoutEphemeralPanels(layout)).toBe(layout);
  });

  it('drops New tabs and re-points the active tab', () => {
    const stripped = withoutEphemeralPanels(
      file(
        grid(
          [
            { panelId: 'panel-new', kind: 'new-tab' },
            { panelId: 'panel-files', kind: 'file-explorer' },
          ],
          'panel-new',
        ),
      ),
    );
    expect(kindsOf(stripped)).toEqual(['chat', 'file-explorer']);
    const root = stripped.grid.root;
    const extras = root.type === 'branch' ? root.children[1] : root;
    expect(extras.type === 'leaf' ? extras.activePanelId : null).toBe(
      'panel-files',
    );
  });

  it('keeps an emptied leaf and drops an emptied popped-out window', () => {
    const stripped = withoutEphemeralPanels(
      file(grid([{ panelId: 'panel-new', kind: 'new-tab' }], 'panel-new'), [
        {
          windowId: 'aux-1',
          grid: grid([{ panelId: 'panel-new-2', kind: 'new-tab' }], null),
          bounds: { x: 0, y: 0, width: 800, height: 600 },
          sourceGroupId: 'group-extras',
        },
        {
          windowId: 'aux-2',
          grid: {
            orientation: 1,
            width: 800,
            height: 600,
            root: {
              type: 'leaf',
              groupId: 'group-aux',
              size: 800,
              panels: [{ panelId: 'panel-new-3', kind: 'new-tab' }],
              activePanelId: 'panel-new-3',
            },
          },
          bounds: { x: 0, y: 0, width: 800, height: 600 },
          sourceGroupId: 'group-extras',
        },
      ]),
    );
    expect(kindsOf(stripped)).toEqual(['chat', 'chat']);
    expect(stripped.poppedOut?.map((window) => window.windowId)).toEqual([
      'aux-1',
    ]);
    const root = stripped.grid.root;
    const extras = root.type === 'branch' ? root.children[1] : root;
    expect(extras.type === 'leaf' ? extras.activePanelId : 'x').toBeNull();
  });

  it('writes nothing a reader without the new-tab kind would reject', () => {
    const stripped = withoutEphemeralPanels(
      file(grid([{ panelId: 'panel-new', kind: 'new-tab' }], 'panel-new')),
    );
    expect(JSON.stringify(stripped)).not.toContain('new-tab');
    expect(migratePanelLayout(stripped)).not.toBeNull();
  });
});
