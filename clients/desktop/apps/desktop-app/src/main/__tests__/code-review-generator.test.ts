import type * as HelperRuns from '../helper-runs/helper-runs';
import type * as InlineHelperRuns from './helpers/inline-helper-runs';
import { initClaudeModels } from '@canopy/desktop-shared/types';
const mockRuntime = jest.fn<unknown, []>();
const mockDispose = jest.fn();
jest.mock('../canopy-runtime/desktop-runtime', () => ({
  getActiveDesktopRuntimeIfAccepting: (): unknown => mockRuntime(),
}));
jest.mock('../helper-runs/helper-runs', () => {
  const { inlineHelperRunsModule } = jest.requireActual<
    typeof InlineHelperRuns
  >('./helpers/inline-helper-runs');
  return inlineHelperRunsModule();
});
jest.mock('electron', () => ({
  app: { getPath: (): string => process.cwd() },
}));
jest.mock('../lib/preferences-store', () => ({
  readLocalMemoryEnabledPreference: jest.fn(() => Promise.resolve(false)),
}));
jest.mock('../ollama/helper-invocation', () => ({
  resolveHelperInvocation: jest.fn(() =>
    Promise.resolve({
      harness: 'claude',
      providerType: 'claude',
      sdkModel: 'haiku',
      aiCreditsRouted: false,
      dispose: mockDispose,
    }),
  ),
}));
jest.mock('../lib/helper-observed-task', () => ({
  startObservedHelperTask: jest.fn(),
  finalizeObservedHelperTask: jest.fn(),
  markObservedHelperTaskAiCreditsRouted: jest.fn(),
}));
jest.mock('../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    seedTranscript: jest.fn(),
    appendTranscriptRecord: jest.fn(),
    updateObservedTask: jest.fn(),
  })),
}));
const mockStructured = jest.fn();
jest.mock('@canopy/desktop-shared/lib/structured-helper-query', () => ({
  runClaudeStructuredHelperQuery: (...args: unknown[]): unknown =>
    mockStructured(...args),
}));
jest.mock('../integration/structured-helper-dispatch', () => ({
  runDesktopClaudeStructuredHelperQuery: (...args: unknown[]): unknown =>
    mockStructured(...args),
  codexStructuredHelperRunner: {},
}));
const helpers = jest.requireMock<
  ReturnType<typeof InlineHelperRuns.inlineHelperRunsModule>
>('../helper-runs/helper-runs');
beforeEach(() => {
  initClaudeModels([{ id: 'haiku', label: 'Haiku' }]);
  helpers.runs.length = 0;
  mockDispose.mockClear();
  mockStructured.mockClear();
  mockRuntime.mockReturnValue(null);
  mockStructured.mockResolvedValue({ value: null, usage: { inputTokens: 3 } });
});
import {
  generateReviewAnnotations,
  generateReviewLogicDiff,
  generateReviewDataModelDiff,
} from '../lib/code-review-generator';
it('runs each review generator as one helper run of its kind', async () => {
  const options: Parameters<typeof generateReviewAnnotations>[0] = {
    diffBundleText: 'diff',
    repoPath: '/repo',
    projectId: 'workspace',
    model: 'haiku',
    thinkingLevel: 'off',
    userInitiated: true,
  };
  for (const generate of [
    generateReviewAnnotations,
    generateReviewLogicDiff,
    generateReviewDataModelDiff,
  ]) {
    const result = await generate(options);
    expect(result.usage.inputTokens).toBe(3);
  }
  expect(helpers.runs.map(({ kind }) => kind)).toEqual([
    'code_review_annotations',
    'code_review_diagram',
    'code_review_diagram',
  ]);
  for (const run of helpers.runs)
    expect(run).toMatchObject({
      model: 'haiku',
      origin: 'client',
      scope: { workspaceId: 'workspace' },
    });
});

it('disposes generateReviewAnnotations when worker admission skips launch', async () => {
  const actual = jest.requireActual<typeof HelperRuns>(
    '../helper-runs/helper-runs',
  );
  const run = jest
    .spyOn(helpers, 'runHelperThroughWorker')
    .mockImplementation(actual.runHelperThroughWorker);
  try {
    for (const runtime of [
      null,
      {
        helperRuns: {
          run: jest.fn(() => Promise.reject(new Error('Dispatch refused'))),
        },
      },
    ]) {
      mockRuntime.mockReturnValue(runtime);
      mockDispose.mockClear();
      mockStructured.mockClear();
      await expect(
        generateReviewAnnotations({
          diffBundleText: 'diff',
          repoPath: '/repo',
          projectId: 'workspace',
          model: 'haiku',
          thinkingLevel: 'off',
        }),
      ).rejects.toBeInstanceOf(actual.HelperWorkerUnavailableError);
      expect(mockStructured).not.toHaveBeenCalled();
      expect(mockDispose).toHaveBeenCalledTimes(1);
    }
  } finally {
    run.mockRestore();
  }
});

it('disposes generateReviewLogicDiff when worker admission skips launch', async () => {
  const actual = jest.requireActual<typeof HelperRuns>(
    '../helper-runs/helper-runs',
  );
  const run = jest
    .spyOn(helpers, 'runHelperThroughWorker')
    .mockImplementation(actual.runHelperThroughWorker);
  try {
    for (const runtime of [
      null,
      {
        helperRuns: {
          run: jest.fn(() => Promise.reject(new Error('Dispatch refused'))),
        },
      },
    ]) {
      mockRuntime.mockReturnValue(runtime);
      mockDispose.mockClear();
      mockStructured.mockClear();
      await expect(
        generateReviewLogicDiff({
          diffBundleText: 'diff',
          repoPath: '/repo',
          projectId: 'workspace',
          model: 'haiku',
          thinkingLevel: 'off',
        }),
      ).rejects.toBeInstanceOf(actual.HelperWorkerUnavailableError);
      expect(mockStructured).not.toHaveBeenCalled();
      expect(mockDispose).toHaveBeenCalledTimes(1);
    }
  } finally {
    run.mockRestore();
  }
});

it('disposes generateReviewDataModelDiff when worker admission skips launch', async () => {
  const actual = jest.requireActual<typeof HelperRuns>(
    '../helper-runs/helper-runs',
  );
  const run = jest
    .spyOn(helpers, 'runHelperThroughWorker')
    .mockImplementation(actual.runHelperThroughWorker);
  try {
    for (const runtime of [
      null,
      {
        helperRuns: {
          run: jest.fn(() => Promise.reject(new Error('Dispatch refused'))),
        },
      },
    ]) {
      mockRuntime.mockReturnValue(runtime);
      mockDispose.mockClear();
      mockStructured.mockClear();
      await expect(
        generateReviewDataModelDiff({
          diffBundleText: 'diff',
          repoPath: '/repo',
          projectId: 'workspace',
          model: 'haiku',
          thinkingLevel: 'off',
        }),
      ).rejects.toBeInstanceOf(actual.HelperWorkerUnavailableError);
      expect(mockStructured).not.toHaveBeenCalled();
      expect(mockDispose).toHaveBeenCalledTimes(1);
    }
  } finally {
    run.mockRestore();
  }
});
