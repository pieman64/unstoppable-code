import type { CodeReviewFile } from '@canopy/desktop-shared/types';
import { reviewForFingerprint } from '../change-diagram-review';

it('marks ready artifacts stale when their fingerprint no longer matches', () => {
  const review: CodeReviewFile = {
    version: 1,
    armed: true,
    commentThreads: [],
    diagrams: {
      logicDiff: {
        data: null,
        derivedFromFingerprint: 'old',
        status: 'ready',
      },
    },
  };

  expect(
    reviewForFingerprint(review, 'current')?.diagrams.logicDiff?.status,
  ).toBe('stale');
  expect(review.diagrams.logicDiff?.status).toBe('ready');
});

it('preserves an active generation across a fingerprint change', () => {
  const review: CodeReviewFile = {
    version: 1,
    armed: true,
    commentThreads: [],
    diagrams: {
      logicDiff: {
        data: null,
        derivedFromFingerprint: 'old',
        status: 'generating',
      },
    },
  };

  expect(
    reviewForFingerprint(review, 'current')?.diagrams.logicDiff?.status,
  ).toBe('generating');
});
