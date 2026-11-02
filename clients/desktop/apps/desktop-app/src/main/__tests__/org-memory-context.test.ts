import {
  MEMORY_QUERY_MAX_CHARS,
  MEMORY_RACE_FLOOR_MS,
  buildMemoryQuery,
  composeSubmittedText,
  getMemoryQueryBranchName,
  isMachineGeneratedMemoryText,
  isTrivialMemoryInput,
  raceWithTimeout,
  remainingMemoryBudgetMs,
  shouldFetchMemory,
  type MemoryQueryContext,
} from '../memory/memory-context';
import { CLIENT_FETCH_TIMEOUT_MS } from '../memory/memory-client';

describe('organization memory context helpers', () => {
  it('joins query context in repo, branch, user order and truncates to 2000 chars', () => {
    expect(buildMemoryQuery('question', 'feature/memory', 'repo')).toBe(
      'repo — feature/memory — question',
    );
    expect(buildMemoryQuery('x'.repeat(2_100), '', '')).toHaveLength(2_000);
  });

  it('omits generated worktree branches and keeps meaningful branches', () => {
    expect(getMemoryQueryBranchName('alpaca', 'alpaca')).toBeUndefined();
    expect(getMemoryQueryBranchName('alpaca', 'alpaca-2')).toBeUndefined();
    expect(
      getMemoryQueryBranchName('alpaca', 'alpaca-1713571200123'),
    ).toBeUndefined();
    expect(getMemoryQueryBranchName('alpaca', ' feature/canopy-credits ')).toBe(
      'feature/canopy-credits',
    );
  });

  it('appends conversation context after the base query, newest message first', () => {
    const context: MemoryQueryContext = {
      recentUserMessages: [
        'How do we configure the reranker for staging deploys?',
        'Please also check the calibration thresholds we use',
      ],
      summaryDescription: 'Improving memory retrieval quality',
    };
    const query = buildMemoryQuery(
      'Now apply the same fix to the web app',
      'feature/memory',
      'repo',
      context,
    );
    expect(query).toBe(
      [
        'repo — feature/memory — Now apply the same fix to the web app',
        'Earlier requests: Please also check the calibration thresholds we use | How do we configure the reranker for staging deploys?',
        'Task: Improving memory retrieval quality',
      ].join('\n'),
    );
  });

  it('keeps only the three most recent context messages and collapses whitespace', () => {
    const context: MemoryQueryContext = {
      recentUserMessages: [
        'oldest message that should be dropped entirely',
        'first kept message',
        'second kept  message',
        'third\nkept\tmessage',
      ],
      summaryDescription: null,
    };
    const query = buildMemoryQuery(
      'Current question text here',
      '',
      '',
      context,
    );
    expect(query).toBe(
      [
        'Current question text here',
        'Earlier requests: third kept message | second kept message | first kept message',
      ].join('\n'),
    );
  });

  it('gives the current message the full budget and drops overflowing context lines', () => {
    const context: MemoryQueryContext = {
      recentUserMessages: ['a prior message that will not fit in the budget'],
      summaryDescription: 'short',
    };
    const fullLength = buildMemoryQuery(
      'x'.repeat(MEMORY_QUERY_MAX_CHARS + 100),
      '',
      '',
      context,
    );
    expect(fullLength).toHaveLength(MEMORY_QUERY_MAX_CHARS);
    expect(fullLength).not.toContain('Earlier requests:');
    // A shorter context line can still fit when a longer one overflows.
    const nearFull = buildMemoryQuery(
      'x'.repeat(MEMORY_QUERY_MAX_CHARS - 20),
      '',
      '',
      context,
    );
    expect(nearFull).not.toContain('Earlier requests:');
    expect(nearFull).toContain('Task: short');
  });

  it('returns the base query when context is empty', () => {
    const context: MemoryQueryContext = {
      recentUserMessages: ['   '],
      summaryDescription: null,
    };
    expect(
      buildMemoryQuery('question', 'feature/memory', 'repo', context),
    ).toBe('repo — feature/memory — question');
  });

  it.each([
    ['', true],
    ['short', true],
    ['   /status with enough characters', true],
    ['This input has at least twenty chars', false],
  ])('classifies trivial input %p', (input, expected) => {
    expect(isTrivialMemoryInput(input)).toBe(expected);
  });

  it.each([
    [
      '$builtin-gh:handle-pr-comments --follow-up-pipeline="Code Review" --auto-archive',
      true,
    ],
    ['  $builtin-gh:handle-pr-checks', true],
    [
      'Unstoppable Code watcher fired.\nWorktree pipeline completion: Code Review (Claude)',
      true,
    ],
    ['Acme Cloud watcher fired.\nSome watcher label', true],
    ['Unstoppable Code watcher deleted.\nStale watcher label', true],
    [
      'GitHub workflow watcher update: a workflow run completed with success.',
      true,
    ],
    ['What does the watcher fired event payload contain exactly?', false],
    ['This ordinary human prompt says my watcher fired.', false],
    ['GitHub workflow watcher update without generated punctuation', false],
    ['$100 is the budget for this ordinary human request', false],
    ['$PATH should include the bundled binary directory here', false],
    ['How much did the deploy cost in $ terms overall?', false],
    ['This input has at least twenty chars', false],
  ])('classifies machine-generated text %p', (input, expected) => {
    expect(isMachineGeneratedMemoryText(input)).toBe(expected);
  });

  it('requires opt-in, capability, and non-trivial user text', () => {
    expect(
      shouldFetchMemory({
        userText: 'This input has at least twenty chars',
        memoryInjectionEnabled: true,
        capabilityPresent: true,
      }),
    ).toBe(true);
    expect(
      shouldFetchMemory({
        userText: 'This input has at least twenty chars',
        memoryInjectionEnabled: false,
        capabilityPresent: true,
      }),
    ).toBe(false);
    expect(
      shouldFetchMemory({
        userText: 'This input has at least twenty chars',
        memoryInjectionEnabled: true,
        capabilityPresent: false,
      }),
    ).toBe(false);
  });

  it('does not fetch memory for agent-originated inputs that look human', () => {
    expect(
      shouldFetchMemory({
        userText: 'Please investigate this subtle production regression',
        memoryInjectionEnabled: true,
        capabilityPresent: true,
        hiddenContextKind: 'agent-sender-context',
      }),
    ).toBe(false);
  });

  it('skips machine-generated dispatches by text shape and structural signals', () => {
    const base = { memoryInjectionEnabled: true, capabilityPresent: true };
    expect(
      shouldFetchMemory({
        ...base,
        userText:
          '$builtin-gh:handle-pr-comments --follow-up-pipeline="Code Review"',
      }),
    ).toBe(false);
    expect(
      shouldFetchMemory({
        ...base,
        userText:
          'Unstoppable Code watcher fired.\nWorktree pipeline completion: Code Review',
      }),
    ).toBe(false);
    expect(
      shouldFetchMemory({
        ...base,
        userText: 'This ordinary human prompt says my watcher fired.',
      }),
    ).toBe(true);
    expect(
      shouldFetchMemory({
        ...base,
        userText: '$100 is the budget for this ordinary human request',
        initiationSource: 'user',
      }),
    ).toBe(true);
    // Structural signals gate even when the text itself looks human.
    expect(
      shouldFetchMemory({
        ...base,
        userText: 'This input has at least twenty chars',
        hiddenContextKind: 'canopy-watcher-event',
      }),
    ).toBe(false);
    expect(
      shouldFetchMemory({
        ...base,
        userText: 'This input has at least twenty chars',
        initiationSource: 'automation',
      }),
    ).toBe(false);
    expect(
      shouldFetchMemory({
        ...base,
        userText: 'This input has at least twenty chars',
        initiationSource: 'hook',
      }),
    ).toBe(false);
    // Human-driven surfaces keep fetching.
    const humanInitiationSources = ['user', 'portal', 'app_advisor'] as const;
    for (const initiationSource of humanInitiationSources) {
      expect(
        shouldFetchMemory({
          ...base,
          userText: 'This input has at least twenty chars',
          initiationSource,
        }),
      ).toBe(true);
    }
    expect(
      shouldFetchMemory({
        ...base,
        userText: 'This input has at least twenty chars',
        hiddenContextKind: 'file-comment-instructions',
      }),
    ).toBe(true);
  });

  it('never rejects and times out to null', async () => {
    await expect(
      raceWithTimeout(Promise.reject(new Error('failure')), 100),
    ).resolves.toBeNull();
    jest.useFakeTimers();
    const pending = raceWithTimeout(new Promise<string>(() => {}), 25);
    jest.advanceTimersByTime(25);
    await expect(pending).resolves.toBeNull();
    jest.useRealTimers();
  });

  it('returns an early result without waiting and computes remaining budget', async () => {
    await expect(raceWithTimeout(Promise.resolve('done'), 1_500)).resolves.toBe(
      'done',
    );
    // Elapsed dispatch time is subtracted from the budget, so overlapping the
    // fetch with session setup shortens the wait instead of extending the turn.
    expect(remainingMemoryBudgetMs(1_000, 1_900)).toBe(
      CLIENT_FETCH_TIMEOUT_MS - 900,
    );
    // The floor guarantees a minimum wait even when setup consumed the whole
    // anchored budget, so a slow-setup turn never races an in-flight fetch
    // against a 0 ms deadline.
    expect(
      remainingMemoryBudgetMs(1_000, 1_000 + CLIENT_FETCH_TIMEOUT_MS),
    ).toBe(MEMORY_RACE_FLOOR_MS);
    expect(
      remainingMemoryBudgetMs(1_000, 1_000 + CLIENT_FETCH_TIMEOUT_MS + 500),
    ).toBe(MEMORY_RACE_FLOOR_MS);
    expect(
      remainingMemoryBudgetMs(
        1_000,
        1_000 + CLIENT_FETCH_TIMEOUT_MS - MEMORY_RACE_FLOOR_MS + 100,
      ),
    ).toBe(MEMORY_RACE_FLOOR_MS);
    // The floor never inflates a budget that is already above it.
    expect(MEMORY_RACE_FLOOR_MS).toBeLessThan(CLIENT_FETCH_TIMEOUT_MS);
    await expect(raceWithTimeout(Promise.resolve('ready'), 0)).resolves.toBe(
      'ready',
    );
    await expect(
      raceWithTimeout(new Promise<string>(() => {}), 0),
    ).resolves.toBeNull();
  });

  it('preserves legacy composition byte-for-byte when memory is absent', () => {
    const legacy = ['hidden', '', 'visible'].join('\n');
    expect(composeSubmittedText('visible', 'hidden')).toBe(legacy);
    expect(composeSubmittedText('visible')).toBe('visible');
  });

  it('composes existing hidden context first and memory last', () => {
    expect(composeSubmittedText('visible', 'hidden', 'memory')).toBe(
      'hidden\n\nmemory\n\nvisible',
    );
  });
});
