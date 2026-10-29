import type {
  CommitPushProgress,
  PrCreationProgress,
} from '@/stores/githubStore';
import {
  derivePhaseStatus,
  buildCommitPushTooltipModel,
  isCommitPushTooltipEnabled,
  buildCreatePrTooltipModel,
  isCreatePrTooltipEnabled,
  buildMergeTooltipModel,
} from '../git-progress';

describe('derivePhaseStatus', () => {
  const ordered: readonly string[] = ['a', 'b', 'c'];

  it('marks earlier phases completed and the current phase active', () => {
    expect(
      derivePhaseStatus({
        phase: 'a',
        orderedPhases: ordered,
        steps: [{ phase: 'a' }, { phase: 'b' }],
        currentPhase: 'b',
        isActive: true,
      }),
    ).toBe('completed');
    expect(
      derivePhaseStatus({
        phase: 'b',
        orderedPhases: ordered,
        steps: [{ phase: 'a' }, { phase: 'b' }],
        currentPhase: 'b',
        isActive: true,
      }),
    ).toBe('active');
    expect(
      derivePhaseStatus({
        phase: 'c',
        orderedPhases: ordered,
        steps: [{ phase: 'a' }, { phase: 'b' }],
        currentPhase: 'b',
        isActive: true,
      }),
    ).toBe('pending');
  });

  it('marks the current phase completed when no longer active', () => {
    expect(
      derivePhaseStatus({
        phase: 'b',
        orderedPhases: ordered,
        steps: [{ phase: 'a' }, { phase: 'b' }],
        currentPhase: 'b',
        isActive: false,
      }),
    ).toBe('completed');
  });

  it('marks all phases completed when done', () => {
    expect(
      derivePhaseStatus({
        phase: 'c',
        orderedPhases: ordered,
        steps: [{ phase: 'a' }, { phase: 'b' }, { phase: 'c' }],
        currentPhase: 'done',
        isActive: false,
      }),
    ).toBe('completed');
    expect(
      derivePhaseStatus({
        phase: 'a',
        orderedPhases: ordered,
        steps: [{ phase: 'a' }, { phase: 'b' }, { phase: 'c' }],
        currentPhase: 'done',
        isActive: false,
      }),
    ).toBe('completed');
  });

  it('leaves reached phases completed when error phase carries no text', () => {
    const steps = [{ phase: 'a' }, { phase: 'b' }, { phase: 'error' }];
    expect(
      derivePhaseStatus({
        phase: 'b',
        orderedPhases: ordered,
        steps,
        currentPhase: 'error',
        isActive: false,
      }),
    ).toBe('completed');
  });

  it('marks the last reached phase as error and unreached as pending', () => {
    const steps = [
      { phase: 'a' },
      { phase: 'b' },
      { phase: 'error', error: 'x' },
    ];
    expect(
      derivePhaseStatus({
        phase: 'a',
        orderedPhases: ordered,
        steps,
        currentPhase: 'error',
        isActive: false,
      }),
    ).toBe('completed');
    expect(
      derivePhaseStatus({
        phase: 'b',
        orderedPhases: ordered,
        steps,
        currentPhase: 'error',
        isActive: false,
      }),
    ).toBe('error');
    expect(
      derivePhaseStatus({
        phase: 'c',
        orderedPhases: ordered,
        steps,
        currentPhase: 'error',
        isActive: false,
      }),
    ).toBe('pending');
  });
});

describe('buildCommitPushTooltipModel', () => {
  it('uses only the push phase for the push action', () => {
    const progress: CommitPushProgress = {
      steps: [{ phase: 'pushing', timestamp: 1 }],
      currentPhase: 'pushing',
    };
    const model = buildCommitPushTooltipModel('push', progress, true);
    expect(model.steps.map((s) => s.label)).toEqual([
      'Pushing',
      'Refreshing Git stats',
    ]);
    expect(model.steps[0].status).toBe('active');
    expect(model.steps[1].status).toBe('pending');
    expect(model.badge).toEqual({ label: 'In progress', tone: 'progress' });
  });

  it('lists the full pull-commit-and-push sequence', () => {
    const progress: CommitPushProgress = {
      steps: [
        { phase: 'pulling', timestamp: 1 },
        { phase: 'staging', timestamp: 2 },
      ],
      currentPhase: 'staging',
    };
    const model = buildCommitPushTooltipModel(
      'pull-commit-and-push',
      progress,
      true,
    );
    expect(model.steps.map((s) => s.label)).toEqual([
      'Pulling',
      'Generating message',
      'Staging',
      'Committing',
      'Pushing',
      'Refreshing Git stats',
    ]);
  });

  it('surfaces the error text and a Failed badge on error', () => {
    const progress: CommitPushProgress = {
      steps: [
        { phase: 'staging', timestamp: 1 },
        { phase: 'error', error: 'nope', timestamp: 2 },
      ],
      currentPhase: 'error',
    };
    const model = buildCommitPushTooltipModel(
      'commit-and-push',
      progress,
      false,
    );
    expect(model.error).toBe('nope');
    expect(model.badge).toEqual({ label: 'Failed', tone: 'error' });
  });

  it('falls back to an active action step when progress is missing', () => {
    const model = buildCommitPushTooltipModel('push', undefined, true);
    expect(model.steps).toHaveLength(2);
    expect(model.steps[0].status).toBe('active');
    expect(model.steps[1].status).toBe('pending');
  });
});

describe('isCommitPushTooltipEnabled', () => {
  it('is enabled while active', () => {
    expect(isCommitPushTooltipEnabled(undefined, true)).toBe(true);
  });
  it('is enabled on error even when not active', () => {
    const progress: CommitPushProgress = {
      steps: [{ phase: 'error', error: 'x', timestamp: 1 }],
      currentPhase: 'error',
    };
    expect(isCommitPushTooltipEnabled(progress, false)).toBe(true);
  });
  it('is disabled when idle and not errored', () => {
    expect(isCommitPushTooltipEnabled(undefined, false)).toBe(false);
  });
});

describe('create-pr + merge models', () => {
  it('builds create-pr rows from the ordered phases', () => {
    const progress: PrCreationProgress = {
      steps: [{ phase: 'pushing', timestamp: 1 }],
      currentPhase: 'pushing',
    };
    const model = buildCreatePrTooltipModel(progress, true);
    expect(model.steps.map((s) => s.label)).toEqual([
      'Gathering changes',
      'Summarizing changes',
      'Pushing to remote',
      'Creating pull request',
      'Refreshing Git stats',
    ]);
    expect(isCreatePrTooltipEnabled(progress, true)).toBe(true);
  });

  it('builds a single merging step', () => {
    const model = buildMergeTooltipModel();
    expect(model.steps).toHaveLength(1);
    expect(model.steps[0].label).toBe('Merging');
    expect(model.steps[0].status).toBe('active');
  });

  it('disables the create-pr tooltip when idle and not errored', () => {
    expect(isCreatePrTooltipEnabled(undefined, false)).toBe(false);
  });
});

describe('refreshing state (post-action git stats refresh)', () => {
  it('appends a "Refreshing Git stats" active step and completes prior steps (commit/push)', () => {
    const progress: CommitPushProgress = {
      steps: [
        { phase: 'staging', timestamp: 1 },
        { phase: 'committing', timestamp: 2 },
        { phase: 'pushing', timestamp: 3 },
      ],
      currentPhase: 'done',
    };
    const model = buildCommitPushTooltipModel(
      'commit-and-push',
      progress,
      true,
      true,
    );
    expect(model.steps.map((s) => s.label)).toEqual([
      'Generating message',
      'Staging',
      'Committing',
      'Pushing',
      'Refreshing Git stats',
    ]);
    // All action steps are completed; only the refresh step is active.
    expect(model.steps.slice(0, 4).every((s) => s.status === 'completed')).toBe(
      true,
    );
    const last = model.steps[model.steps.length - 1];
    expect(last.status).toBe('active');
    expect(model.badge).toEqual({ label: 'Refreshing', tone: 'progress' });
  });

  it('shows the refresh step as pending before refreshing starts', () => {
    const progress: CommitPushProgress = {
      steps: [{ phase: 'pushing', timestamp: 1 }],
      currentPhase: 'pushing',
    };
    const model = buildCommitPushTooltipModel('push', progress, true, false);
    expect(model.steps.map((s) => s.label)).toEqual([
      'Pushing',
      'Refreshing Git stats',
    ]);
    expect(model.steps[model.steps.length - 1].status).toBe('pending');
    expect(model.badge).toEqual({ label: 'In progress', tone: 'progress' });
  });

  it('appends the refresh step for create-pr without touching prior labels', () => {
    const progress: PrCreationProgress = {
      steps: [{ phase: 'creating_pr', timestamp: 1 }],
      currentPhase: 'done',
    };
    const model = buildCreatePrTooltipModel(progress, true, true);
    expect(model.steps.map((s) => s.label)).toEqual([
      'Gathering changes',
      'Summarizing changes',
      'Pushing to remote',
      'Creating pull request',
      'Refreshing Git stats',
    ]);
    expect(model.steps[model.steps.length - 1].status).toBe('active');
    expect(model.badge).toEqual({ label: 'Refreshing', tone: 'progress' });
  });

  it('shows merge as completed plus the refresh step while refreshing', () => {
    const model = buildMergeTooltipModel(true, true);
    expect(model.steps.map((s) => s.label)).toEqual([
      'Merging',
      'Refreshing Git stats',
    ]);
    expect(model.steps[0].status).toBe('completed');
    expect(model.steps[1].status).toBe('active');
  });
});
