import os from 'node:os';

const mockResolveHelperInvocation = jest.fn<Promise<unknown>, unknown[]>();
jest.mock('../ollama/helper-invocation', () => ({
  resolveHelperInvocation: (...args: unknown[]): Promise<unknown> =>
    mockResolveHelperInvocation(...args),
  resolveHelperWorkOwner: (): Promise<undefined> => Promise.resolve(undefined),
}));

jest.mock('../lib/model-policy-state', () => ({
  isModelBlockedByStoredPolicy: (): Promise<boolean> => Promise.resolve(false),
}));

jest.mock('../lib/preferences-store', () => ({
  readPreferencesFile: jest.fn(() => Promise.resolve({})),
  readLocalMemoryEnabledPreference: jest.fn(() => Promise.resolve(false)),
}));

jest.mock('../integration/claude-worker-session-service', () => ({
  getClaudeWorkerSessionService: jest.fn(() => ({
    runWorker: jest.fn(),
    cancel: jest.fn(),
  })),
}));

jest.mock('../lib/helper-observed-task', () => ({
  markObservedHelperTaskAiCreditsRouted: jest.fn(),
}));

const mockWorkspaceEnvironment = jest.fn<Record<string, string>, []>(
  () => ({}),
);
jest.mock('../lib/user-environment-runtime', () => ({
  resolveCodexRuntimeEnvironmentProfile: (): {
    environment: Record<string, string>;
    logicalWorkspaceEnvironmentId: string;
  } => ({
    environment: mockWorkspaceEnvironment(),
    logicalWorkspaceEnvironmentId: 'test-environment',
  }),
}));

const mockRunTurn = jest.fn<Promise<Record<string, unknown>>, [unknown]>();
const mockDeleteThread = jest.fn(() => Promise.resolve());
const mockStartThread = jest.fn((request: unknown) => {
  void request;
  return Promise.resolve({
    threadId: 'summary-thread',
    runTurn: mockRunTurn,
    delete: mockDeleteThread,
  });
});
jest.mock('../codex/runtime-service', () => ({
  getCodexRuntimeService: (): { startThread: typeof mockStartThread } => ({
    startThread: mockStartThread,
  }),
}));

const mockSeedTranscript = jest.fn();
jest.mock('../observability', () => ({
  getObservabilityService: (): unknown => ({
    finalizeObservedTask: jest.fn(),
    seedTranscript: mockSeedTranscript,
    appendTranscriptRecord: jest.fn(),
    updateObservedTask: jest.fn(),
  }),
}));

const mockAssertCodexSpeedAvailable = jest.fn(
  (request: { speed: string }): Promise<Record<string, unknown>> =>
    Promise.resolve({ speed: request.speed, availability: {}, generation: 5 }),
);
const mockReportCodexSpeedRejection = jest.fn(
  (report: unknown): boolean => report !== undefined,
);
jest.mock('../model-routing/codex-account-models', () => ({
  assertCodexSpeedAvailable: (request: {
    speed: string;
  }): Promise<Record<string, unknown>> =>
    mockAssertCodexSpeedAvailable(request),
  reportCodexSpeedRejection: (report: unknown): boolean =>
    mockReportCodexSpeedRejection(report),
}));
import { initCodexModels } from '@canopy/desktop-shared/types';
import { generateChatSummary } from '../agents/utils';
import { setExperimentalFeaturesEnabled } from '../lib/experimental-features';
import { SHORT_CHAT_TITLE_SYSTEM_PROMPT } from '@canopy/protocol/generated-names';

const NATIVE_INVOCATION = {
  providerType: 'codex',
  source: 'codex-managed',
  harness: 'codex',
  sdkModel: 'gpt-5.5',
  aiCreditsRouted: false,
  dispose: (): void => undefined,
};

const LONG_MODEL_TITLE =
  'Add dark mode support to the settings page and the onboarding flow';
const LONG_USER_MESSAGE =
  'Please add dark mode support to the settings page and also the onboarding flow so it matches';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function startedDeveloperInstructions(): unknown {
  const request: unknown = mockStartThread.mock.calls[0]?.[0];
  const params = isRecord(request) ? request.params : undefined;
  return isRecord(params) ? params.developerInstructions : undefined;
}

async function summarize(): ReturnType<typeof generateChatSummary> {
  return generateChatSummary(LONG_USER_MESSAGE, {
    model: 'gpt-5.5',
    cwd: os.tmpdir(),
    purpose: 'chat-title',
  });
}

describe('generated chat name length', () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeAll(() => {
    initCodexModels([{ id: 'gpt-5.5', label: 'GPT 5.5' }]);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockWorkspaceEnvironment.mockReturnValue({});
    mockResolveHelperInvocation.mockResolvedValue(NATIVE_INVOCATION);
    mockRunTurn.mockResolvedValue({
      status: 'completed',
      finalText: LONG_MODEL_TITLE,
      usage: {},
    });
    consoleErrorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    setExperimentalFeaturesEnabled(false);
    consoleErrorSpy.mockRestore();
  });

  it.each([false, true])(
    'uses the short prompt regardless of early access (%s)',
    async (early) => {
      setExperimentalFeaturesEnabled(early);
      const result = await summarize();
      expect(startedDeveloperInstructions()).toBe(
        SHORT_CHAT_TITLE_SYSTEM_PROMPT,
      );
      expect(result.text).toBe('Add dark mode support to the settings');
    },
  );

  it.each(['!!!', '   ', '設定のダークモード', '𐐀'.repeat(50)])(
    'normalizes output %s into a nonempty Unicode-safe title',
    async (text) => {
      mockRunTurn.mockResolvedValue({
        status: 'completed',
        finalText: text,
        usage: {},
      });
      const result = await summarize();
      expect(result.text.trim()).not.toBe('');
      expect(Array.from(result.text).length).toBeLessThanOrEqual(40);
      if (text.includes('設定')) expect(result.text).toBe(text);
      if (text.startsWith('𐐀')) expect(result.text).toBe('𐐀'.repeat(40));
    },
  );

  it.each([
    ['"Fix the C++ build."', 'Fix the C++ build'],
    ['Upgrade node-gyp to v2.0', 'Upgrade node-gyp to v2.0'],
    ["Don't break CI/CD for C# - again!", "Don't break CI/CD for C# again"],
    ['1. Inspect the app (part 2)', '1 Inspect the app part 2'],
    ['Rename my_func to key:value', 'Rename my func to key value'],
  ])('keeps word-internal punctuation in %s', async (finalText, expected) => {
    mockRunTurn.mockResolvedValue({
      status: 'completed',
      finalText,
      usage: {},
    });
    await expect(summarize()).resolves.toMatchObject({ text: expected });
  });

  it('settles failures with a bounded first-prompt fallback and failure metadata', async () => {
    mockResolveHelperInvocation.mockRejectedValue(new Error('offline'));
    const result = await summarize();
    expect(result.text).toBe('Please add dark mode support to the');
    // A thrown provider error is retryable; naming stays pending for a retry.
    expect(result.fallback).toEqual({ reason: 'offline', retryable: true });
  });

  it('does not mark deterministic fallbacks retryable', async () => {
    mockRunTurn.mockResolvedValue({
      status: 'completed',
      finalText: '!!!',
      usage: {},
    });
    const result = await summarize();
    expect(result.fallback).toBeDefined();
    expect(result.fallback?.retryable).toBeUndefined();
  });

  it('provides a deterministic title for attachment-only prompts', async () => {
    mockResolveHelperInvocation.mockRejectedValue(new Error('offline'));
    await expect(
      generateChatSummary('', { purpose: 'chat-title', cwd: os.tmpdir() }),
    ).resolves.toMatchObject({ text: 'Attachment conversation' });
  });

  it('uses short summaries for Ledger consumers too', async () => {
    setExperimentalFeaturesEnabled(false);
    await expect(
      generateChatSummary(LONG_USER_MESSAGE, {
        model: 'gpt-5.5',
        cwd: os.tmpdir(),
      }),
    ).resolves.toMatchObject({ text: LONG_MODEL_TITLE });
    expect(startedDeveloperInstructions()).toEqual(
      expect.stringContaining('2 to 6 words'),
    );
  });
});
