import type { CapabilityUnavailable } from '@canopy/protocol/capability-bundle';
import {
  capabilityUnavailableLabel,
  goneCapabilitySelections,
  withUnavailableRows,
  type UnavailableStatusRow,
} from '../selectionRows';

interface Row extends UnavailableStatusRow {
  name: string;
  synthesized?: true;
}

const dropbox: CapabilityUnavailable = {
  ref: {
    kind: 'mcpServer',
    serverId: 'dropbox',
    configId: 'default',
    via: { kind: 'direct' },
  },
  displayName: 'Dropbox',
  reason: 'removed_from_catalog',
  disposition: 'gone',
};
const canva: CapabilityUnavailable = {
  ref: {
    kind: 'mcpServer',
    serverId: 'canva',
    configId: 'default',
    via: { kind: 'direct' },
  },
  reason: 'desktop_only',
  disposition: 'unsupported',
};
const notes: CapabilityUnavailable = {
  ref: {
    kind: 'skill',
    sourceId: 'custom',
    skillName: 'notes',
    via: { kind: 'direct' },
  },
  reason: 'deleted',
  disposition: 'gone',
};

function project(
  rows: Row[],
  records: CapabilityUnavailable[],
  selected: string[],
): ReturnType<typeof withUnavailableRows<Row>> {
  return withUnavailableRows(rows, records, {
    rowKey: (selection) => `${selection.kind}:${selection.key}`,
    isSelected: (selection) =>
      selected.includes(`${selection.kind}:${selection.key}`),
    synthesize: (row) => ({ ...row, synthesized: true }),
  });
}

describe('shared unavailable selection rows (REG-3042)', () => {
  it('badges a listed row, locks it only when gone, and copies rather than mutates', () => {
    const listed: Row[] = [
      { key: 'mcp:dropbox/default', name: 'Dropbox' },
      { key: 'mcp:canva/default', name: 'Canva' },
    ];
    const result = project(listed, [dropbox, canva], []);
    expect(result.rows[0]).toMatchObject({
      badges: [{ label: 'No longer available', tone: 'neutral' }],
      toggleMode: 'unsupported',
      toggleReason: 'No longer available',
    });
    expect(result.rows[1].badges).toEqual([
      { label: 'Available on desktop only', tone: 'neutral' },
    ]);
    expect(result.rows[1].toggleMode).toBeUndefined();
    expect([...result.removableKeys]).toEqual([
      'mcp:dropbox/default',
      'mcp:canva/default',
    ]);
    expect(listed[0].badges).toBeUndefined();
  });

  it('adds a row only for a selected capability the catalog no longer lists', () => {
    const result = project([], [notes, canva], ['skill:custom/notes']);
    expect(result.rows).toEqual([
      {
        kind: 'skill',
        key: 'skill:custom/notes',
        name: 'Skill',
        badges: [{ label: 'No longer available', tone: 'warning' }],
        toggleMode: 'unsupported',
        toggleReason: 'No longer available',
        synthesized: true,
      },
    ]);
    expect(result.added).toEqual([
      {
        rowKey: 'skill:custom/notes',
        selection: { kind: 'skill', key: 'custom/notes' },
      },
    ]);
  });

  it('ignores degraded, unknown, and plugin-reached records', () => {
    const result = project(
      [{ key: 'mcp:dropbox/default', name: 'Dropbox' }],
      [
        { ...dropbox, disposition: 'degraded' },
        { ...dropbox, reason: 'quarantined' },
        {
          ...dropbox,
          ref: {
            ...dropbox.ref,
            via: { kind: 'plugin', marketplaceId: 'm', pluginName: 'p' },
          },
        },
      ],
      ['mcp:dropbox/default'],
    );
    expect(result.rows[0].badges).toBeUndefined();
    expect(result.removableKeys.size).toBe(0);
    expect(
      capabilityUnavailableLabel({ reason: 'deleted', disposition: 'retired' }),
    ).toBeUndefined();
  });

  it('lists only gone direct selections as never to be saved back', () => {
    expect(goneCapabilitySelections([dropbox, canva, notes])).toEqual([
      { kind: 'mcp', key: 'dropbox/default' },
      { kind: 'skill', key: 'custom/notes' },
    ]);
  });
});
