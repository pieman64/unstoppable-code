import {
  getArchivedContainerDiskUsageBytes,
  getArchivedContainerGuaranteedReclaimableBytes,
  getArchivedContainerState,
  getArchivedContainerStateDescription,
  getArchivedContainerStateLabel,
  isArchivedContainerDiskUsageComplete,
} from '@/lib/archivedContainerDisplay';
import { formatByteSize } from '@/lib/format';

describe('archived container state helpers', () => {
  it('maps a lock timestamp to Archived and its absence to Deleted', () => {
    expect(getArchivedContainerState({})).toBe('deleted');
    expect(
      getArchivedContainerState({ lockedAt: '2026-09-01T00:00:00.000Z' }),
    ).toBe('archived');
    expect(getArchivedContainerStateLabel('archived')).toBe('Archived');
    expect(getArchivedContainerStateLabel('deleted')).toBe('Deleted');
  });

  it('describes what each state means for the retained data', () => {
    expect(getArchivedContainerStateDescription('deleted', 'Sep 14')).toBe(
      'Removed on Sep 14 unless you restore or archive it first.',
    );
    expect(getArchivedContainerStateDescription('archived', 'Sep 14')).toBe(
      'Kept until you delete it. Delete it to start the retention countdown again.',
    );
  });

  it('exposes the measured total or null while measuring', () => {
    expect(getArchivedContainerDiskUsageBytes({})).toBeNull();
    expect(
      getArchivedContainerDiskUsageBytes({
        diskUsage: {
          filesBytes: 1,
          gitBytes: 2,
          totalBytes: 3,
          computedAt: '2026-09-01T00:00:00.000Z',
        },
      }),
    ).toBe(3);
  });

  it('uses only archive files as guaranteed reclaimable bytes', () => {
    const summary = {
      version: 2,
      diskUsage: {
        filesBytes: 1024,
        gitBytes: 4096,
        totalBytes: 5120,
        computedAt: '2026-07-21T00:00:00.000Z',
      },
    } as const;
    expect(getArchivedContainerGuaranteedReclaimableBytes(summary)).toBe(1024);
    expect(isArchivedContainerDiskUsageComplete(summary)).toBe(false);
    expect(
      isArchivedContainerDiskUsageComplete({
        ...summary,
        diskUsage: { ...summary.diskUsage, gitBytesComplete: true },
      }),
    ).toBe(true);
  });
});

describe('formatByteSize', () => {
  it('formats bytes with a unit that keeps small sizes legible', () => {
    expect(formatByteSize(0)).toBe('0 B');
    expect(formatByteSize(512)).toBe('512 B');
    expect(formatByteSize(1024)).toBe('1 KB');
    expect(formatByteSize(1536)).toBe('1.5 KB');
    expect(formatByteSize(10 * 1024 + 700)).toBe('11 KB');
    expect(formatByteSize(3 * 1024 * 1024)).toBe('3 MB');
    expect(formatByteSize(2.25 * 1024 ** 3)).toBe('2.3 GB');
  });

  it('treats invalid input as empty', () => {
    expect(formatByteSize(-5)).toBe('0 B');
    expect(formatByteSize(Number.NaN)).toBe('0 B');
  });
});
