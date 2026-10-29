import {
  DEFAULT_ARCHIVE_RETENTION_DAYS,
  MAX_ARCHIVE_RETENTION_DAYS,
  isArchivedContainerExpired,
  resolveArchiveRetentionDays,
  resolveAutoArchiveDays,
} from '../archive-retention';

const SURFACES = [
  'single-repo',
  'multi-repo',
  'cowork',
  'app-advisor',
] as const;

describe('resolveArchiveRetentionDays', () => {
  it.each(SURFACES)(
    'uses the default window for absent and legacy null %s values',
    (surface) => {
      expect(resolveArchiveRetentionDays(surface, undefined)).toBe(
        DEFAULT_ARCHIVE_RETENTION_DAYS,
      );
      expect(resolveArchiveRetentionDays(surface, null)).toBe(
        DEFAULT_ARCHIVE_RETENTION_DAYS,
      );
    },
  );

  it.each(SURFACES)(
    'treats legacy zero as the default window on %s (retention is always on)',
    (surface) => {
      expect(resolveArchiveRetentionDays(surface, 0)).toBe(
        DEFAULT_ARCHIVE_RETENTION_DAYS,
      );
    },
  );

  it.each(SURFACES)('retains positive integer %s values', (surface) => {
    expect(resolveArchiveRetentionDays(surface, 1)).toBe(1);
    expect(resolveArchiveRetentionDays(surface, 30)).toBe(30);
    expect(
      resolveArchiveRetentionDays(surface, MAX_ARCHIVE_RETENTION_DAYS),
    ).toBe(MAX_ARCHIVE_RETENTION_DAYS);
  });

  it.each(SURFACES)(
    'falls back to the default for oversized, negative, or fractional %s values',
    (surface) => {
      expect(
        resolveArchiveRetentionDays(surface, MAX_ARCHIVE_RETENTION_DAYS + 1),
      ).toBe(DEFAULT_ARCHIVE_RETENTION_DAYS);
      expect(resolveArchiveRetentionDays(surface, -3)).toBe(
        DEFAULT_ARCHIVE_RETENTION_DAYS,
      );
      expect(resolveArchiveRetentionDays(surface, 2.5)).toBe(
        DEFAULT_ARCHIVE_RETENTION_DAYS,
      );
    },
  );
});

describe('resolveAutoArchiveDays', () => {
  it.each(['single-repo', 'multi-repo', 'cowork', 'app-advisor'] as const)(
    'enables %s Auto Delete independently of the always-on retention value',
    (surface) => {
      expect(resolveAutoArchiveDays(surface, 0, 7)).toBe(7);
      expect(resolveAutoArchiveDays(surface, 30, 7)).toBe(7);
    },
  );

  it('stays disabled when the user has not explicitly chosen an inactivity window', () => {
    expect(resolveAutoArchiveDays('cowork', 30, undefined)).toBeNull();
    expect(resolveAutoArchiveDays('app-advisor', 30, null)).toBeNull();
  });
});

describe('isArchivedContainerExpired', () => {
  const now = Date.parse('2026-09-07T00:00:00.000Z');

  it('expires an unlocked (Deleted) container once expiresAt has passed', () => {
    expect(
      isArchivedContainerExpired(
        { expiresAt: '2026-09-06T00:00:00.000Z' },
        now,
      ),
    ).toBe(true);
    expect(
      isArchivedContainerExpired(
        { expiresAt: '2026-09-08T00:00:00.000Z' },
        now,
      ),
    ).toBe(false);
  });

  it('never expires a locked (Archived) container', () => {
    expect(
      isArchivedContainerExpired(
        {
          expiresAt: '2026-09-06T00:00:00.000Z',
          lockedAt: '2026-09-01T00:00:00.000Z',
        },
        now,
      ),
    ).toBe(false);
  });
});
