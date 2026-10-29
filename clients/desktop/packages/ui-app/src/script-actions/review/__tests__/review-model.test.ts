import { isScriptActionsReviewRequest } from '@canopy/protocol/script-actions';
import { splitScriptReviewBatches } from '../review-model';
import { action } from './fake-script-actions-client';

it('submits a global selection in bounded batches without dropping rows', () => {
  const pending = Array.from({ length: 2001 }, (_, index) =>
    action({ id: `action-${index}` }),
  );
  const selection = new Map(pending.map((entry) => [entry.id, entry.revision]));
  const batches = splitScriptReviewBatches(selection, pending);
  expect(batches.map((batch) => batch.entries.length)).toEqual([2000, 1]);
  expect(
    batches.every((batch) =>
      isScriptActionsReviewRequest({
        projectId: 'p',
        worktreeId: 'w',
        decision: 'approve',
        entries: batch.entries,
      }),
    ),
  ).toBe(true);
  expect(
    new Set(batches.flatMap((batch) => batch.entries.map((entry) => entry.id)))
      .size,
  ).toBe(2001);
});
