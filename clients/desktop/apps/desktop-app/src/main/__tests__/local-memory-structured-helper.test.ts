import type { WorkOwner } from '@canopy/protocol/llm-gateway';
import {
  resolveHelperInvocation,
  type HelperInvocation,
} from '../ollama/helper-invocation';
import { runStructuredHelper } from '../integration/structured-helper-dispatch';
import { isLocalMemoryModelBlockedByPolicy } from '../memory/local/model-policy';
import { runLocalMemoryStructuredHelper } from '../memory/local/structured-helper';

const mockCodexRun = jest.fn<Promise<unknown>, unknown[]>();

jest.mock('../ollama/helper-invocation', () => ({
  resolveHelperInvocation: jest.fn(),
}));
jest.mock('../lib/helper-observed-task', () => ({
  markObservedHelperTaskAiCreditsRouted: jest.fn(),
}));
jest.mock('../integration/structured-helper-dispatch', () => ({
  runStructuredHelper: jest.fn(),
  codexStructuredHelperRunner: {
    run: (...args: unknown[]): unknown => mockCodexRun(...args),
  },
  structuredHelperReportOnlyPermission: jest.fn(),
}));
jest.mock('../memory/local/model-policy', () => ({
  isLocalMemoryModelBlockedByPolicy: jest.fn(() => Promise.resolve(false)),
}));
jest.mock('../memory/local/store', () => ({
  ensureOwnerOnlyDir: jest.fn(() => Promise.resolve()),
}));

describe('local memory helper preparation deadline', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('aborts a proxy capacity wait when the memory operation times out', async () => {
    let passedSignal: AbortSignal | undefined;
    let rejectPreparation: (error: Error) => void = () => undefined;
    const preparation = new Promise<never>((_resolve, reject) => {
      rejectPreparation = reject;
    });
    jest
      .mocked(resolveHelperInvocation)
      .mockImplementation((_model, _provider, options) => {
        passedSignal = options?.signal;
        passedSignal?.addEventListener('abort', () => {
          rejectPreparation(new Error('Capacity wait aborted'));
        });
        return preparation;
      });
    const operation = runLocalMemoryStructuredHelper({
      taskKey: 'memory:test',
      kind: 'memory',
      label: 'Memory',
      scopeDir: '/isolated/memory',
      helperModel: { model: 'opus', thinkingLevel: 'medium' },
      systemPrompt: 'Summarize memory.',
      userMessage: 'Remember the project conventions.',
      schema: {},
      isResult: (value: unknown): value is string => typeof value === 'string',
      timeoutMs: 60_000,
    });
    // Attach rejection handling before advancing the timer.
    const result = operation.catch((error: unknown): unknown => error);
    try {
      await jest.advanceTimersByTimeAsync(60_000);
      expect(passedSignal?.aborted).toBe(true);
      await expect(result).resolves.toEqual(
        new Error('Local memory helper timed out after 1 minutes.'),
      );
      expect(runStructuredHelper).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      rejectPreparation(new Error('Test cleanup'));
      await result;
    }
  });
});

describe('local memory helper owner and memory options', () => {
  const baseOptions = {
    taskKey: 'memory:test',
    kind: 'memory',
    label: 'Memory',
    scopeDir: '/isolated/memory',
    workspaceId: 'workspace-1',
    helperModel: { model: 'opus', thinkingLevel: 'medium' },
    systemPrompt: 'Summarize memory.',
    userMessage: 'Remember the project conventions.',
    schema: {},
    isResult: (value: unknown): value is string => typeof value === 'string',
  } as const;
  const invocation = (harness: 'claude' | 'codex'): HelperInvocation => ({
    harness,
    providerType: harness,
    source: harness === 'codex' ? 'codex-managed' : 'claude-managed',
    aiCreditsRouted: false,
    dispose: jest.fn(),
  });

  beforeEach(() => {
    jest.clearAllMocks();
    jest
      .mocked(runStructuredHelper)
      .mockResolvedValue({ value: 'ok', usage: {} });
    mockCodexRun.mockResolvedValue({ value: 'ok', usage: {} });
  });

  it('keeps existing callers on the workspace owner with memory enabled', async () => {
    jest
      .mocked(resolveHelperInvocation)
      .mockResolvedValue(invocation('claude'));
    await runLocalMemoryStructuredHelper(baseOptions);
    expect(isLocalMemoryModelBlockedByPolicy).toHaveBeenCalledWith(
      'opus',
      'workspace-1',
    );
    const options = jest.mocked(resolveHelperInvocation).mock.calls[0]?.[2];
    expect(options).not.toHaveProperty('workOwner');
    expect(jest.mocked(runStructuredHelper).mock.calls[0]?.[0]).toMatchObject({
      localMemoryEnabled: true,
    });
  });

  it('forwards an explicit work owner to policy and invocation', async () => {
    const workOwner: WorkOwner = {
      kind: 'organization',
      organizationId: 'org-1',
    };
    jest
      .mocked(resolveHelperInvocation)
      .mockResolvedValue(invocation('claude'));
    await runLocalMemoryStructuredHelper({
      ...baseOptions,
      workOwner,
    });
    expect(isLocalMemoryModelBlockedByPolicy).toHaveBeenCalledWith(
      'opus',
      'workspace-1',
      { workOwner },
    );
    expect(
      jest.mocked(resolveHelperInvocation).mock.calls[0]?.[2],
    ).toMatchObject({ workOwner });
  });

  it('treats an explicit undefined work owner as no override', async () => {
    jest
      .mocked(resolveHelperInvocation)
      .mockResolvedValue(invocation('claude'));
    await runLocalMemoryStructuredHelper({
      ...baseOptions,
      workOwner: undefined,
    });
    expect(isLocalMemoryModelBlockedByPolicy).toHaveBeenCalledWith(
      'opus',
      'workspace-1',
    );
  });

  it('forwards localMemoryEnabled false to both runners', async () => {
    jest
      .mocked(resolveHelperInvocation)
      .mockResolvedValueOnce(invocation('claude'))
      .mockResolvedValueOnce(invocation('codex'));
    await runLocalMemoryStructuredHelper({
      ...baseOptions,
      localMemoryEnabled: false,
    });
    await runLocalMemoryStructuredHelper({
      ...baseOptions,
      localMemoryEnabled: false,
    });
    expect(jest.mocked(runStructuredHelper).mock.calls[0]?.[0]).toMatchObject({
      localMemoryEnabled: false,
    });
    expect(mockCodexRun.mock.calls[0]?.[0]).toMatchObject({
      localMemoryEnabled: false,
    });
  });
});
