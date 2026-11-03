import {
  STORAGE_OWNERSHIP,
  type StorageOwnershipRow,
  type StorageTransitionOwner,
} from '@canopy/core-runtime/storage';
import { selectW5WritePath, W5_RECORD_NAMESPACES } from '../selector';

function rows(
  owners: Partial<Record<string, StorageTransitionOwner>>,
): StorageOwnershipRow[] {
  return STORAGE_OWNERSHIP.map((row) => {
    const owner = owners[row.id];
    return owner === undefined
      ? row
      : {
          ...row,
          transitionOwner: owner,
          currentWriters: owner === 'daemon' ? [] : row.currentWriters,
        };
  });
}

const allDaemon = Object.fromEntries(
  W5_RECORD_NAMESPACES.map((id) => [id, 'daemon' as const]),
);

describe('selectW5WritePath (W6h0 C1)', () => {
  it('keeps the compiled table on the legacy writers', () => {
    expect(selectW5WritePath()).toBe('legacy');
  });

  it('routes once every W5 record row is daemon-owned', () => {
    expect(selectW5WritePath(rows(allDaemon))).toBe('routed');
  });

  it.each(W5_RECORD_NAMESPACES)(
    'stays legacy while %s alone is not daemon-owned',
    (namespace) => {
      expect(
        selectW5WritePath(rows({ ...allDaemon, [namespace]: 'legacy' })),
      ).toBe('legacy');
      expect(
        selectW5WritePath(rows({ ...allDaemon, [namespace]: 'offline' })),
      ).toBe('legacy');
    },
  );

  it('stays legacy when a W5 row is missing or duplicated', () => {
    const daemon = rows(allDaemon);
    expect(
      selectW5WritePath(daemon.filter((row) => row.id !== 'worktree_list')),
    ).toBe('legacy');
    const index = daemon.find((row) => row.id === 'workspace_index');
    expect(index).toBeDefined();
    expect(
      selectW5WritePath(index === undefined ? daemon : [...daemon, index]),
    ).toBe('legacy');
  });
});
