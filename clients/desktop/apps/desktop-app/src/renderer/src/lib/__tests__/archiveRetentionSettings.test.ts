import {
  DEFAULT_ARCHIVE_RETENTION_DAYS,
  getDraftArchiveRetentionDays,
  isArchiveRetentionDraftDirty,
  shouldPersistArchiveRetention,
  toArchiveRetentionDraft,
  toPersistedArchiveRetentionDays,
} from '@/lib/archiveRetentionSettings';

const SURFACES = [
  'single-repo',
  'multi-repo',
  'cowork',
  'app-advisor',
] as const;

describe('archiveRetentionSettings', () => {
  describe('toArchiveRetentionDraft', () => {
    it('renders never-set (undefined) as the 7-day default on every surface', () => {
      for (const surface of SURFACES) {
        expect(toArchiveRetentionDraft(surface, undefined)).toEqual({
          days: DEFAULT_ARCHIVE_RETENTION_DAYS,
        });
      }
    });

    it('renders legacy null and legacy 0 as the 7-day default on every surface', () => {
      for (const surface of SURFACES) {
        expect(toArchiveRetentionDraft(surface, null).days).toBe(
          DEFAULT_ARCHIVE_RETENTION_DAYS,
        );
        expect(toArchiveRetentionDraft(surface, 0).days).toBe(
          DEFAULT_ARCHIVE_RETENTION_DAYS,
        );
      }
    });

    it('renders a positive integer as that day count', () => {
      for (const surface of SURFACES) {
        expect(toArchiveRetentionDraft(surface, 12)).toEqual({ days: 12 });
      }
    });
  });

  describe('toPersistedArchiveRetentionDays', () => {
    it('persists the draft day count on every surface', () => {
      for (const surface of SURFACES) {
        expect(toPersistedArchiveRetentionDays(surface, { days: 21 })).toBe(21);
      }
    });

    it('round-trips: the persisted value renders back as the same draft', () => {
      for (const surface of SURFACES) {
        const persisted = toPersistedArchiveRetentionDays(surface, { days: 9 });
        expect(toArchiveRetentionDraft(surface, persisted)).toEqual({
          days: 9,
        });
      }
    });
  });

  describe('getDraftArchiveRetentionDays', () => {
    it('returns the draft day count', () => {
      expect(getDraftArchiveRetentionDays({ days: 4 })).toBe(4);
    });
  });

  describe('isArchiveRetentionDraftDirty', () => {
    it('treats a never-set project left at the 7-day default as clean', () => {
      for (const surface of SURFACES) {
        expect(
          isArchiveRetentionDraftDirty(surface, undefined, {
            days: DEFAULT_ARCHIVE_RETENTION_DAYS,
          }),
        ).toBe(false);
      }
    });

    it('treats legacy null and 0 left at the default as clean', () => {
      for (const surface of SURFACES) {
        expect(
          isArchiveRetentionDraftDirty(surface, null, {
            days: DEFAULT_ARCHIVE_RETENTION_DAYS,
          }),
        ).toBe(false);
        expect(
          isArchiveRetentionDraftDirty(surface, 0, {
            days: DEFAULT_ARCHIVE_RETENTION_DAYS,
          }),
        ).toBe(false);
      }
    });

    it('flags a day-count change as dirty and an identical day count as clean', () => {
      expect(isArchiveRetentionDraftDirty('single-repo', 7, { days: 8 })).toBe(
        true,
      );
      expect(isArchiveRetentionDraftDirty('single-repo', 7, { days: 7 })).toBe(
        false,
      );
    });
  });

  describe('shouldPersistArchiveRetention', () => {
    it('forces a write for legacy null/absent/0 values on cowork and app-advisor', () => {
      for (const surface of ['cowork', 'app-advisor'] as const) {
        for (const persisted of [null, undefined, 0]) {
          expect(
            shouldPersistArchiveRetention(surface, persisted, {
              days: DEFAULT_ARCHIVE_RETENTION_DAYS,
            }),
          ).toBe(true);
        }
      }
    });

    it('stays clean once an explicit value is persisted and the draft matches', () => {
      for (const surface of ['cowork', 'app-advisor'] as const) {
        expect(shouldPersistArchiveRetention(surface, 7, { days: 7 })).toBe(
          false,
        );
        expect(shouldPersistArchiveRetention(surface, 7, { days: 9 })).toBe(
          true,
        );
      }
    });

    it('matches plain dirtiness on code-workspace surfaces (no per-chat sweep to arm)', () => {
      for (const surface of ['single-repo', 'multi-repo'] as const) {
        expect(
          shouldPersistArchiveRetention(surface, undefined, {
            days: DEFAULT_ARCHIVE_RETENTION_DAYS,
          }),
        ).toBe(false);
        expect(
          shouldPersistArchiveRetention(surface, 0, {
            days: DEFAULT_ARCHIVE_RETENTION_DAYS,
          }),
        ).toBe(false);
        expect(shouldPersistArchiveRetention(surface, 7, { days: 30 })).toBe(
          true,
        );
      }
    });
  });
});
