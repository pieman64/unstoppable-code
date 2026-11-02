/* eslint-disable @typescript-eslint/require-await */
import type * as CodeReviewGeneratorModule from '../lib/code-review-generator';

jest.mock('../lib/code-review-diff', () => ({
  listReviewRepos: jest.fn(async () => [
    { repoId: 'default', repoPath: '/tmp/repo' },
  ]),
  computeReviewFingerprint: jest.fn(async () => 'fp-1'),
  buildReviewDiffBundle: jest.fn(async () => ({
    text: 'diff',
    truncated: false,
  })),
}));

const setArtifact = jest.fn(async () => null);
jest.mock('../lib/code-review-persistence', () => ({
  readCodeReviewState: jest.fn(async () => ({
    version: 1,
    armed: true,
    commentThreads: [],
    diagrams: {},
  })),
  setCodeReviewArmed: jest.fn(async () => ({
    version: 1,
    armed: true,
    commentThreads: [],
    diagrams: {},
  })),
  get setCodeReviewArtifact(): typeof setArtifact {
    return setArtifact;
  },
  removeCodeReviewDiagramArtifact: jest.fn(async () => null),
  reevaluateReviewAnchors: jest.fn(async () => ({
    version: 1,
    armed: true,
    commentThreads: [],
    annotations: {
      data: { schemaVersion: 1, annotations: [] },
      derivedFromFingerprint: 'fp-1',
      status: 'ready',
    },
    diagrams: {
      logicDiff: {
        data: null,
        derivedFromFingerprint: 'fp-1',
        status: 'ready',
      },
    },
  })),
}));

jest.mock('../lib/code-review-registry', () => ({
  // The turn hooks receive the composite scope key and resolve the real ids
  // through the registry; `p1--w1` maps back to `(p1, w1)`.
  getCodeReviewTargetSync: jest.fn((scopeKey: string) =>
    scopeKey === 'p1--w1' ? { projectId: 'p1', worktreeId: 'w1' } : null,
  ),
}));

const generateAnnotations = jest.fn<
  ReturnType<typeof CodeReviewGeneratorModule.generateReviewAnnotations>,
  Parameters<typeof CodeReviewGeneratorModule.generateReviewAnnotations>
>(() =>
  Promise.resolve({
    value: { schemaVersion: 1, annotations: [] },
    usage: {},
  }),
);
const generateDataModelDiff = jest.fn<
  ReturnType<typeof CodeReviewGeneratorModule.generateReviewDataModelDiff>,
  Parameters<typeof CodeReviewGeneratorModule.generateReviewDataModelDiff>
>(() => Promise.resolve({ value: null, usage: {} }));
type GenerateAnnotationsResult = Awaited<
  ReturnType<typeof CodeReviewGeneratorModule.generateReviewAnnotations>
>;
jest.mock('../lib/code-review-generator', () => ({
  generateReviewAnnotations: (
    options: Parameters<
      typeof CodeReviewGeneratorModule.generateReviewAnnotations
    >[0],
  ): ReturnType<typeof CodeReviewGeneratorModule.generateReviewAnnotations> =>
    generateAnnotations(options),
  generateReviewLogicDiff: jest.fn(async () => ({ value: null, usage: {} })),
  generateReviewDataModelDiff: (
    options: Parameters<
      typeof CodeReviewGeneratorModule.generateReviewDataModelDiff
    >[0],
  ): ReturnType<typeof CodeReviewGeneratorModule.generateReviewDataModelDiff> =>
    generateDataModelDiff(options),
  sanitizeReviewAnnotations: jest.fn(async (set: unknown) => set),
}));

jest.mock('../lib/preferences-store', () => ({
  readPreferencesFile: jest.fn(async () => ({
    codeReviewModel: 'claude-haiku-4-5-20251001',
    codeReviewThinkingLevel: 'off',
    providerModelConfigDefaults: undefined,
  })),
}));

jest.mock('../lib/helper-observed-task', () => ({
  startObservedHelperTask: jest.fn(),
  finalizeObservedHelperTask: jest.fn(),
}));

jest.mock('../lib/helper-transcript-observer', () => ({
  createHelperTranscriptObserver: jest.fn(() => undefined),
}));

jest.mock('../lib/window-send', () => ({ sendToAllWindows: jest.fn() }));

import {
  CODE_REVIEW_IDLE_DEBOUNCE_MS,
  __testing,
  armCodeReview,
  drainCodeReviewForDeletion,
  setCodeReviewModalOpen,
  noteCodeReviewTurnEnd,
  noteCodeReviewTurnStart,
  noteWorktreeActivityForCodeReview,
  requestManualCodeReviewRefresh,
} from '../lib/code-review-scheduler';
import { releaseCodeReviewTasks } from '../lib/code-review-deletion-fence';
import {
  buildReviewDiffBundle,
  computeReviewFingerprint,
} from '../lib/code-review-diff';
import {
  readCodeReviewState,
  reevaluateReviewAnchors,
  setCodeReviewArmed,
} from '../lib/code-review-persistence';
import { initClaudeModels } from '@canopy/desktop-shared/types';

initClaudeModels([
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
]);

const getWindow = (): null => null;

async function flushAsync(): Promise<void> {
  // Artifact 'generating' writes are now awaited before the generators start.
  await flushDeep();
}

/**
 * Deeper flush for tests that hold a run's promise instead of awaiting it (the
 * interleaving cases below): reaching the generator crosses more awaits than
 * `flushAsync`'s three ticks cover.
 */
async function flushDeep(): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    await Promise.resolve();
  }
}

describe('code-review scheduler', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    __testing.reset();
    jest.clearAllMocks();
    (readCodeReviewState as jest.Mock).mockResolvedValue({
      version: 1,
      armed: true,
      commentThreads: [],
      diagrams: {},
    });
    (setCodeReviewArmed as jest.Mock).mockResolvedValue({
      version: 1,
      armed: true,
      commentThreads: [],
      diagrams: {},
    });
    (computeReviewFingerprint as jest.Mock).mockResolvedValue('fp-1');
    (buildReviewDiffBundle as jest.Mock).mockResolvedValue({
      text: 'diff',
      truncated: false,
    });
    generateAnnotations.mockResolvedValue({
      value: { schemaVersion: 1, annotations: [] },
      usage: {},
    });
    generateDataModelDiff.mockResolvedValue({ value: null, usage: {} });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('drains in-flight generation before deletion and rejects late refresh or visibility work', async () => {
    let finish: (value: GenerateAnnotationsResult) => void = () => undefined;
    generateAnnotations.mockImplementationOnce(
      () =>
        new Promise<GenerateAnnotationsResult>((resolve) => {
          finish = resolve;
        }),
    );
    const run = requestManualCodeReviewRefresh(
      { projectId: 'p1', worktreeId: 'w1' },
      getWindow,
    );
    await flushDeep();
    expect(generateAnnotations).toHaveBeenCalledTimes(1);
    let drained = false;
    const drain = drainCodeReviewForDeletion('p1', 'w1').then(() => {
      drained = true;
    });
    await flushDeep();
    expect(drained).toBe(false);
    finish({ value: { schemaVersion: 1, annotations: [] }, usage: {} });
    await Promise.all([run, drain]);
    setCodeReviewModalOpen(
      { projectId: 'p1', worktreeId: 'w1' },
      true,
      getWindow,
      'late-panel',
    );
    await requestManualCodeReviewRefresh(
      { projectId: 'p1', worktreeId: 'w1' },
      getWindow,
    );
    noteWorktreeActivityForCodeReview('p1', 'w1', getWindow);
    jest.runOnlyPendingTimers();
    await flushDeep();
    expect(generateAnnotations).toHaveBeenCalledTimes(1);
  });

  it('drains an activity check whose state read began before deletion', async () => {
    let signalReadStarted: (() => void) | undefined;
    const readStarted = new Promise<void>((resolve) => {
      signalReadStarted = resolve;
    });
    let releaseRead: (() => void) | undefined;
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    jest.mocked(readCodeReviewState).mockImplementationOnce(async () => {
      signalReadStarted?.();
      await readGate;
      return {
        version: 1,
        armed: true,
        commentThreads: [],
        diagrams: {},
      };
    });

    noteWorktreeActivityForCodeReview('p1', 'w1', getWindow);
    await readStarted;

    let drained = false;
    const drain = drainCodeReviewForDeletion('p1', 'w1').then(() => {
      drained = true;
    });
    await flushDeep();
    expect(drained).toBe(false);

    releaseRead?.();
    await drain;
    jest.runOnlyPendingTimers();
    await flushDeep();

    expect(generateAnnotations).not.toHaveBeenCalled();
  });

  it('does not start a queued rerun after deletion begins draining the in-flight run', async () => {
    let finish: (value: GenerateAnnotationsResult) => void = () => undefined;
    generateAnnotations.mockImplementationOnce(
      () =>
        new Promise<GenerateAnnotationsResult>((resolve) => {
          finish = resolve;
        }),
    );

    const first = requestManualCodeReviewRefresh(
      { projectId: 'p1', worktreeId: 'w1' },
      getWindow,
    );
    await flushDeep();
    expect(generateAnnotations).toHaveBeenCalledTimes(1);

    await expect(
      requestManualCodeReviewRefresh(
        { projectId: 'p1', worktreeId: 'w1' },
        getWindow,
      ),
    ).resolves.toEqual({ status: 'queued' });

    const drain = drainCodeReviewForDeletion('p1', 'w1');
    finish({ value: { schemaVersion: 1, annotations: [] }, usage: {} });
    await Promise.all([first, drain]);
    await flushDeep();

    expect(generateAnnotations).toHaveBeenCalledTimes(1);
  });

  it('releases a drained scope so a recreated worktree can generate again', async () => {
    await drainCodeReviewForDeletion('p1', 'w1');
    await requestManualCodeReviewRefresh(
      { projectId: 'p1', worktreeId: 'w1' },
      getWindow,
    );
    expect(generateAnnotations).not.toHaveBeenCalled();

    releaseCodeReviewTasks('p1', 'w1');
    await requestManualCodeReviewRefresh(
      { projectId: 'p1', worktreeId: 'w1' },
      getWindow,
    );
    expect(generateAnnotations).toHaveBeenCalledTimes(1);
  });

  it('returns persisted artifact failures to an attended refresh', async () => {
    jest.mocked(reevaluateReviewAnchors).mockResolvedValueOnce({
      version: 1,
      armed: true,
      commentThreads: [],
      annotations: {
        data: null,
        derivedFromFingerprint: 'fp-1',
        status: 'error',
        error: 'Provider request failed.',
      },
      diagrams: {},
    });

    await expect(
      requestManualCodeReviewRefresh(
        { projectId: 'p1', worktreeId: 'w1' },
        getWindow,
      ),
    ).resolves.toEqual({
      status: 'error',
      error: 'Provider request failed.',
    });
  });

  it('debounces activity until idle, then runs once', async () => {
    noteWorktreeActivityForCodeReview('p1', 'w1', getWindow);
    await flushAsync();
    expect(generateAnnotations).not.toHaveBeenCalled();

    // Repeated activity keeps pushing the idle timer out.
    jest.advanceTimersByTime(CODE_REVIEW_IDLE_DEBOUNCE_MS - 1000);
    noteWorktreeActivityForCodeReview('p1', 'w1', getWindow);
    await flushAsync();
    jest.advanceTimersByTime(CODE_REVIEW_IDLE_DEBOUNCE_MS - 1000);
    await flushAsync();
    expect(generateAnnotations).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1000);
    await flushAsync();
    expect(generateAnnotations).toHaveBeenCalledTimes(1);
  });

  it('defers a due run while a turn is active, runs on turn end', async () => {
    // Turn hooks receive the composite scope key (`p1--w1`); activity signals
    // use the real ids. Both resolve to the same scheduler state.
    noteCodeReviewTurnStart('p1--w1');
    noteWorktreeActivityForCodeReview('p1', 'w1', getWindow);
    await flushAsync();
    jest.advanceTimersByTime(CODE_REVIEW_IDLE_DEBOUNCE_MS);
    await flushAsync();
    expect(generateAnnotations).not.toHaveBeenCalled();

    noteCodeReviewTurnEnd('p1--w1', getWindow);
    jest.advanceTimersByTime(CODE_REVIEW_IDLE_DEBOUNCE_MS);
    await flushAsync();
    expect(generateAnnotations).toHaveBeenCalledTimes(1);
  });

  it('manual refresh cancels the queued run and runs immediately', async () => {
    noteWorktreeActivityForCodeReview('p1', 'w1', getWindow);
    await flushAsync();
    await requestManualCodeReviewRefresh(
      { projectId: 'p1', worktreeId: 'w1' },
      getWindow,
    );
    await flushAsync();
    expect(generateAnnotations).toHaveBeenCalledTimes(1);
    // The previously queued idle run must have been cancelled.
    jest.advanceTimersByTime(CODE_REVIEW_IDLE_DEBOUNCE_MS * 2);
    await flushAsync();
    expect(generateAnnotations).toHaveBeenCalledTimes(1);
  });

  it('skips regeneration when the fingerprint has not moved', async () => {
    await requestManualCodeReviewRefresh(
      { projectId: 'p1', worktreeId: 'w1' },
      getWindow,
    );
    await flushAsync();
    expect(generateAnnotations).toHaveBeenCalledTimes(1);
    // Same fingerprint 'fp-1' → activity should not schedule another run.
    (computeReviewFingerprint as jest.Mock).mockResolvedValue('fp-1');
    noteWorktreeActivityForCodeReview('p1', 'w1', getWindow);
    jest.advanceTimersByTime(CODE_REVIEW_IDLE_DEBOUNCE_MS);
    await flushAsync();
    expect(generateAnnotations).toHaveBeenCalledTimes(1);
  });

  it('arming with fresh artifacts and an empty diff neither stales nor regenerates', async () => {
    const readyFile = {
      version: 1,
      armed: true,
      commentThreads: [],
      annotations: {
        data: { schemaVersion: 1, annotations: [] },
        derivedFromFingerprint: 'fp-1',
        status: 'ready',
        generatedAt: '2026-07-07T00:00:00.000Z',
      },
      diagrams: {
        logicDiff: {
          data: null,
          derivedFromFingerprint: 'fp-1',
          status: 'ready',
          generatedAt: '2026-07-07T00:00:00.000Z',
        },
      },
    };
    (readCodeReviewState as jest.Mock).mockResolvedValue(readyFile);
    (setCodeReviewArmed as jest.Mock).mockResolvedValue(readyFile);
    (buildReviewDiffBundle as jest.Mock).mockResolvedValue({
      text: '',
      truncated: false,
    });

    await armCodeReview({ projectId: 'p1', worktreeId: 'w1' }, getWindow);
    await flushAsync();
    // Arming must not start an LLM run or overwrite artifacts when everything
    // is already ready at the current fingerprint.
    expect(generateAnnotations).not.toHaveBeenCalled();
    expect(setArtifact).not.toHaveBeenCalled();

    // The arm run recorded the fingerprint, so a later activity signal with
    // an unchanged fingerprint must settle without scheduling a regen.
    noteWorktreeActivityForCodeReview('p1', 'w1', getWindow);
    jest.advanceTimersByTime(CODE_REVIEW_IDLE_DEBOUNCE_MS);
    await flushAsync();
    expect(generateAnnotations).not.toHaveBeenCalled();
    expect(setArtifact).not.toHaveBeenCalled();
  });

  it('persists a first-time data-model error artifact when generation returns no result', async () => {
    (buildReviewDiffBundle as jest.Mock).mockResolvedValue({
      text: 'diff --git a/schema.prisma b/schema.prisma\n',
      truncated: false,
    });

    await requestManualCodeReviewRefresh(
      { projectId: 'p1', worktreeId: 'w1' },
      getWindow,
    );
    await flushAsync();

    expect(generateDataModelDiff).toHaveBeenCalledTimes(1);
    expect(setArtifact).toHaveBeenCalledWith(
      'p1',
      'w1',
      'dataModelDiff',
      expect.objectContaining({
        data: null,
        derivedFromFingerprint: 'fp-1',
        error: 'Data model diagram generation returned no result',
        status: 'error',
      }),
    );
  });

  // ECW-9091 review round 9. A user click and a background trigger interleave
  // routinely (turn-end / idle debounce firing while a multi-artifact
  // regeneration is still running). The queued rerun must carry the QUEUING
  // call's intent, not the in-flight one's — otherwise a background
  // regeneration inherits permission to spend AI Credits, and in the reverse
  // order an explicit user request is downgraded into a silent no-op.
  it('replays the queuing background call intent, not the in-flight user run', async () => {
    let releaseFirst: (() => void) | undefined;
    generateAnnotations.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      return { value: { schemaVersion: 1, annotations: [] }, usage: {} };
    });

    const armed = armCodeReview(
      { projectId: 'p1', worktreeId: 'w1' },
      getWindow,
    );
    await flushDeep();
    expect(generateAnnotations).toHaveBeenCalledTimes(1);
    expect(generateAnnotations.mock.calls[0]?.[0]).toMatchObject({
      userInitiated: true,
    });

    // The fingerprint moves, so the queued rerun has real work to do.
    (computeReviewFingerprint as jest.Mock).mockResolvedValue('fp-2');
    noteWorktreeActivityForCodeReview('p1', 'w1', getWindow);
    // `noteWorktreeActivityForCodeReview` awaits its state/fingerprint reads
    // before arming the idle timer, so let that settle before advancing.
    await flushDeep();
    jest.advanceTimersByTime(CODE_REVIEW_IDLE_DEBOUNCE_MS);
    await flushDeep();

    releaseFirst?.();
    await armed;
    await flushDeep();

    expect(generateAnnotations).toHaveBeenCalledTimes(2);
    expect(generateAnnotations.mock.calls[1]?.[0]).toMatchObject({
      userInitiated: false,
    });
  });

  it('does not downgrade a user request queued behind a background run', async () => {
    let releaseFirst: (() => void) | undefined;
    generateAnnotations.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      return { value: { schemaVersion: 1, annotations: [] }, usage: {} };
    });

    noteWorktreeActivityForCodeReview('p1', 'w1', getWindow);
    // `noteWorktreeActivityForCodeReview` awaits its state/fingerprint reads
    // before arming the idle timer, so let that settle before advancing.
    await flushDeep();
    jest.advanceTimersByTime(CODE_REVIEW_IDLE_DEBOUNCE_MS);
    await flushDeep();
    expect(generateAnnotations).toHaveBeenCalledTimes(1);
    expect(generateAnnotations.mock.calls[0]?.[0]).toMatchObject({
      userInitiated: false,
    });

    (computeReviewFingerprint as jest.Mock).mockResolvedValue('fp-2');
    const refresh = requestManualCodeReviewRefresh(
      { projectId: 'p1', worktreeId: 'w1' },
      getWindow,
    );
    await flushDeep();

    releaseFirst?.();
    await refresh;
    await flushDeep();

    expect(generateAnnotations).toHaveBeenCalledTimes(2);
    expect(generateAnnotations.mock.calls[1]?.[0]).toMatchObject({
      userInitiated: true,
    });
  });
});
