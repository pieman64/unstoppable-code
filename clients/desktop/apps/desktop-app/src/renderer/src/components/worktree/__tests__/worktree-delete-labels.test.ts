import { resolveArchiveRetentionDays } from '@canopy/desktop-shared/lib/archive-retention';
import { getWorktreeDeleteLabels } from '@canopy/ui-app';

const BRANCH = 'feature-x';

describe('getWorktreeDeleteLabels', () => {
  describe('composed with resolveArchiveRetentionDays (code projects)', () => {
    it.each(['single-repo', 'multi-repo'] as const)(
      '%s: undefined persisted value defaults to a 7-day Delete window',
      (surface) => {
        const effective = resolveArchiveRetentionDays(surface, undefined);
        expect(effective).toBe(7);
        const labels = getWorktreeDeleteLabels('delete', effective, BRANCH);
        expect(labels.standaloneActionLabel).toBe('Delete feature-x');
        expect(labels.retentionSummary).toContain('for 7 days');
      },
    );

    it.each(['single-repo', 'multi-repo'] as const)(
      '%s: legacy 0 / null no longer turn removal into a hard delete',
      (surface) => {
        for (const persisted of [0, null]) {
          const effective = resolveArchiveRetentionDays(surface, persisted);
          const labels = getWorktreeDeleteLabels('delete', effective, BRANCH);
          expect(labels.retentionSummary).toContain('for 7 days');
          expect(labels.localWorkRetentionDetail).toContain(
            'Otherwise, deletion is permanent.',
          );
        }
      },
    );
  });
});
