import {
  DEFAULT_PR_CONTENT_INSTRUCTIONS,
  PR_CONTENT_RESPONSE_FORMAT_INSTRUCTIONS,
  PR_CONTENT_SCHEMA,
  PR_CONTENT_SYSTEM_PREAMBLE,
  aggregateCheckStatus,
  formatBranchAsTitle,
  isPrContent,
  isPrInMergeQueue,
  isPrReadyToMerge,
  resolvePrContentInstructions,
  type PullRequestMergeInput,
} from '../pull-requests';

describe('aggregateCheckStatus', () => {
  it('lets a failing check win over everything', () => {
    expect(aggregateCheckStatus(['passing', 'failing', 'pending'])).toBe(
      'failing',
    );
  });

  it('reports pending before passing', () => {
    expect(aggregateCheckStatus(['pending', 'passing'])).toBe('pending');
  });

  it('reports neutral only when nothing else ran', () => {
    expect(aggregateCheckStatus(['neutral', 'passing'])).toBe('passing');
    expect(aggregateCheckStatus(['neutral'])).toBe('neutral');
  });

  it('is none with no checks at all, never passing', () => {
    expect(aggregateCheckStatus([])).toBe('none');
  });
});

describe('isPrReadyToMerge', () => {
  const ready: PullRequestMergeInput = {
    state: 'open',
    checkStatus: 'passing',
    reviewStatus: 'approved',
    hasConflicts: false,
    mergeable: true,
    mergeableState: 'clean',
  };

  it('accepts a clean open PR', () => {
    expect(isPrReadyToMerge(ready)).toBe(true);
  });

  it('refuses a PR with no checks when GitHub gave no mergeability signal', () => {
    expect(
      isPrReadyToMerge({
        state: 'open',
        checkStatus: 'none',
        reviewStatus: 'approved',
        hasConflicts: false,
      }),
    ).toBe(false);
  });

  it('refuses an unknown mergeability (null) without a mergeable state', () => {
    expect(
      isPrReadyToMerge({ ...ready, mergeable: null, mergeableState: null }),
    ).toBe(false);
  });

  it('refuses a blocked PR unless a merge queue is required and signals are green', () => {
    const blocked = { ...ready, mergeableState: 'blocked' };
    expect(isPrReadyToMerge(blocked)).toBe(false);
    expect(
      isPrReadyToMerge({
        ...blocked,
        mergeQueue: { required: true, inQueue: false },
      }),
    ).toBe(true);
  });

  it('refuses drafts, conflicts and queued PRs', () => {
    expect(isPrReadyToMerge({ ...ready, state: 'draft' })).toBe(false);
    expect(isPrReadyToMerge({ ...ready, hasConflicts: true })).toBe(false);
    const queued = { ...ready, mergeQueue: { required: true, inQueue: true } };
    expect(isPrInMergeQueue(queued)).toBe(true);
    expect(isPrReadyToMerge(queued)).toBe(false);
  });
});

describe('PR content policy', () => {
  it('uses the default instructions unless told otherwise', () => {
    expect(
      resolvePrContentInstructions({
        instructions: 'ignored',
        instructionMode: 'default',
      }),
    ).toBe(DEFAULT_PR_CONTENT_INSTRUCTIONS);
  });

  it('appends extra instructions after the default', () => {
    expect(
      resolvePrContentInstructions({
        instructions: 'Mention the ticket.',
        instructionMode: 'append',
      }),
    ).toBe(
      `${DEFAULT_PR_CONTENT_INSTRUCTIONS}\n\nAdditional instructions:\nMention the ticket.`,
    );
  });

  it('replaces the default instructions', () => {
    expect(
      resolvePrContentInstructions({
        instructions: 'Only a title.',
        instructionMode: 'replace',
      }),
    ).toBe('Only a title.');
  });

  it('accepts only a nonblank title with a string body', () => {
    expect(isPrContent({ title: 'Add login', body: '' })).toBe(true);
    expect(isPrContent({ title: '  ', body: 'x' })).toBe(false);
    expect(isPrContent({ title: 'x' })).toBe(false);
    expect(isPrContent(null)).toBe(false);
  });

  it('exposes the system preamble, format rules and schema', () => {
    expect(PR_CONTENT_SYSTEM_PREAMBLE).toMatch(/pull request titles/);
    expect(PR_CONTENT_RESPONSE_FORMAT_INSTRUCTIONS).toMatch(/`title`/);
    expect(PR_CONTENT_SCHEMA).toMatchObject({
      required: ['title', 'body'],
    });
  });
});

describe('formatBranchAsTitle', () => {
  it('drops a conventional prefix and separators', () => {
    expect(formatBranchAsTitle('feat/add-login')).toBe('Add login');
    expect(formatBranchAsTitle('fix_user_page')).toBe('Fix user page');
  });
});
