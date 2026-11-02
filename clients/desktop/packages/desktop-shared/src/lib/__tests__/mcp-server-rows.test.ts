import type { McpServerIndexEntry } from '../../types/mcp-servers';
import { flattenMcpServerRows } from '../mcp-server-rows';

function row(
  id: string,
  overrides: Partial<McpServerIndexEntry> = {},
): McpServerIndexEntry {
  return {
    id,
    name: id,
    description: '',
    type: 'http',
    configs: [],
    updatedAt: '2026-09-21T00:00:00.000Z',
    ...overrides,
  };
}

describe('flattenMcpServerRows', () => {
  it('surfaces shadowed device copies after their account row, in order', () => {
    const device = row('device-1', { curatedKey: 'github' });
    const account = row('account:1', {
      scope: 'account',
      curatedKey: 'github',
      deviceCopies: [device],
    });
    const plain = row('device-2');
    expect(flattenMcpServerRows([account, plain])).toEqual([
      account,
      device,
      plain,
    ]);
  });

  it('is the identity for a flat index', () => {
    const rows = [row('a'), row('b')];
    expect(flattenMcpServerRows(rows)).toEqual(rows);
  });
});
