import { initClaudeModels } from '@canopy/desktop-shared/types';
/**
 * Org model policy enforcement for the chat/archive/handoff summary helpers in
 * `agents/utils.ts`. These are one-shot background helpers that ship raw
 * conversation text to an explicitly configured model, and were previously
 * ungated: only interactive chat, pipelines, and the Portal catalog enforced the
 * policy, so on personal provider auth a blocked model was still reachable here.
 */
import os from 'node:os';
import type { WorkOwner } from '@canopy/protocol/llm-gateway';

const mockIsModelBlockedByStoredPolicy = jest.fn<
  Promise<boolean>,
  [string | undefined, WorkOwner | undefined]
>(() => Promise.resolve(false));

jest.mock('../lib/model-policy-state', () => ({
  isModelBlockedByStoredPolicy: (
    modelId: string | undefined,
    owner: WorkOwner | undefined,
  ): Promise<boolean> => mockIsModelBlockedByStoredPolicy(modelId, owner),
}));

/**
 * The first provider-facing call each summary helper makes. Rejecting with a
 * sentinel proves the gate let the run through instead of refusing it.
 */
const HELPER_INVOCATION_SENTINEL = 'helper-invocation-reached';
const mockResolveHelperInvocation = jest.fn<Promise<never>, unknown[]>(() =>
  Promise.reject(new Error(HELPER_INVOCATION_SENTINEL)),
);
const mockResolveHelperWorkOwner = jest.fn(
  (options: { workOwner?: WorkOwner | null }): Promise<WorkOwner | undefined> =>
    Promise.resolve(
      Object.prototype.hasOwnProperty.call(options, 'workOwner')
        ? (options.workOwner ?? undefined)
        : { kind: 'personal' },
    ),
);

jest.mock('../ollama/helper-invocation', () => ({
  resolveHelperInvocation: (...args: unknown[]): Promise<never> =>
    mockResolveHelperInvocation(...args),
  resolveHelperWorkOwner: (options: {
    workOwner?: WorkOwner | null;
  }): Promise<WorkOwner | undefined> => mockResolveHelperWorkOwner(options),
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

jest.mock('../codex/runtime-service', () => ({
  getCodexRuntimeService: jest.fn(() => ({
    startThread: jest.fn(),
  })),
}));

const mockFinalizeObservedTask = jest.fn();

jest.mock('../observability', () => ({
  getObservabilityService: (): unknown => ({
    finalizeObservedTask: mockFinalizeObservedTask,
    seedTranscript: jest.fn(),
    appendTranscriptRecord: jest.fn(),
    updateObservedTask: jest.fn(),
  }),
}));

import {
  generateArchiveSummary,
  generateChatSummary,
  generateHandoffSummary,
} from '../agents/utils';

const REFUSAL_MESSAGE =
  'Summary generation was skipped: this model is blocked by your organization policy.';
const BLOCKED_MODEL = 'claude-sonnet-4-6';

describe('summary helper org model policy enforcement', () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    initClaudeModels([
      { id: 'haiku', label: 'Haiku' },
      { id: BLOCKED_MODEL, label: 'Sonnet' },
    ]);
    mockIsModelBlockedByStoredPolicy.mockResolvedValue(false);
    mockResolveHelperInvocation.mockImplementation(() =>
      Promise.reject(new Error(HELPER_INVOCATION_SENTINEL)),
    );
    consoleErrorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  describe('generateChatSummary', () => {
    it('refuses and falls back to the truncated user message when the model is blocked', async () => {
      mockIsModelBlockedByStoredPolicy.mockResolvedValue(true);

      await expect(
        generateChatSummary('Rotate the production signing key', {
          model: BLOCKED_MODEL,
          cwd: os.tmpdir(),
          observabilityTaskKey: 'helper:chat-summary:1',
        }),
      ).resolves.toEqual({
        text: 'Rotate the production signing key',
        usage: {},
        fallback: { reason: REFUSAL_MESSAGE },
      });

      expect(mockIsModelBlockedByStoredPolicy).toHaveBeenCalledWith(
        BLOCKED_MODEL,
        { kind: 'personal' },
      );
      // The conversation text never reaches provider resolution.
      expect(mockResolveHelperInvocation).not.toHaveBeenCalled();
      expect(mockFinalizeObservedTask).not.toHaveBeenCalled();
    });

    it('bounds chat-title refusal fallbacks without resolving a provider', async () => {
      mockIsModelBlockedByStoredPolicy.mockResolvedValue(true);
      const result = await generateChatSummary(
        'Please investigate the production signing key rotation failure and all its consequences',
        { model: BLOCKED_MODEL, purpose: 'chat-title', cwd: os.tmpdir() },
      );
      expect(Array.from(result.text).length).toBeLessThanOrEqual(40);
      expect(result.text).not.toBe('');
      expect(result.fallback).toEqual({ reason: REFUSAL_MESSAGE });
      expect(mockResolveHelperInvocation).not.toHaveBeenCalled();
    });

    it('runs the summary normally when no policy blocks the model', async () => {
      await generateChatSummary('Rotate the production signing key', {
        model: BLOCKED_MODEL,
        cwd: os.tmpdir(),
      });

      expect(mockIsModelBlockedByStoredPolicy).toHaveBeenCalledWith(
        BLOCKED_MODEL,
        { kind: 'personal' },
      );
      expect(mockResolveHelperInvocation).toHaveBeenCalledTimes(1);
      expect(mockFinalizeObservedTask).not.toHaveBeenCalled();
    });

    it('preserves an explicitly missing owner inherited from the source chat', async () => {
      await generateChatSummary('Rotate the production signing key', {
        model: BLOCKED_MODEL,
        cwd: os.tmpdir(),
        workspaceId: 'workspace',
        workOwner: undefined,
      });

      expect(mockResolveHelperInvocation.mock.calls[0]?.[2]).toHaveProperty(
        'workOwner',
        null,
      );
      expect(mockIsModelBlockedByStoredPolicy).toHaveBeenCalledWith(
        BLOCKED_MODEL,
        undefined,
      );
    });
  });

  describe('generateArchiveSummary', () => {
    it('refuses with an explicit message when the model is blocked', async () => {
      mockIsModelBlockedByStoredPolicy.mockResolvedValue(true);

      await expect(
        generateArchiveSummary('user: rotate the signing key', {
          cwd: os.tmpdir(),
          observabilityTaskKey: 'helper:archive-summary:1',
        }),
      ).resolves.toEqual({ text: REFUSAL_MESSAGE, usage: {} });

      expect(mockResolveHelperInvocation).not.toHaveBeenCalled();
      expect(mockFinalizeObservedTask).toHaveBeenCalledWith(
        'helper:archive-summary:1',
        'failure',
        REFUSAL_MESSAGE,
      );
    });

    it('runs the archive summary normally when no policy blocks the model', async () => {
      await generateArchiveSummary('user: rotate the signing key', {
        cwd: os.tmpdir(),
      });

      expect(mockIsModelBlockedByStoredPolicy).toHaveBeenCalledWith('haiku', {
        kind: 'personal',
      });
      expect(mockResolveHelperInvocation).toHaveBeenCalledTimes(1);
    });
  });

  describe('generateHandoffSummary', () => {
    it('refuses when the model is blocked', async () => {
      mockIsModelBlockedByStoredPolicy.mockResolvedValue(true);

      await expect(
        generateHandoffSummary('user: rotate the signing key', {
          cwd: os.tmpdir(),
          observabilityTaskKey: 'helper:handoff-summary:1',
        }),
      ).rejects.toThrow(REFUSAL_MESSAGE);

      expect(mockResolveHelperInvocation).not.toHaveBeenCalled();
      expect(mockFinalizeObservedTask).toHaveBeenCalledWith(
        'helper:handoff-summary:1',
        'failure',
        REFUSAL_MESSAGE,
      );
    });

    it('runs the handoff summary normally when no policy blocks the model', async () => {
      await expect(
        generateHandoffSummary('user: rotate the signing key', {
          cwd: os.tmpdir(),
        }),
      ).rejects.toThrow(HELPER_INVOCATION_SENTINEL);

      expect(mockIsModelBlockedByStoredPolicy).toHaveBeenCalledWith('haiku', {
        kind: 'personal',
      });
      expect(mockResolveHelperInvocation).toHaveBeenCalledTimes(1);
    });

    it('forwards the owner inherited from the source chat', async () => {
      const workOwner = {
        kind: 'organization' as const,
        organizationId: '123e4567-e89b-12d3-a456-426614174000',
      };

      await expect(
        generateHandoffSummary('user: rotate the signing key', {
          cwd: os.tmpdir(),
          workspaceId: 'workspace',
          workOwner,
        }),
      ).rejects.toThrow(HELPER_INVOCATION_SENTINEL);

      expect(mockResolveHelperInvocation).toHaveBeenCalledWith(
        'haiku',
        undefined,
        { workspaceId: 'workspace', workOwner },
      );
      expect(mockIsModelBlockedByStoredPolicy).toHaveBeenCalledWith(
        'haiku',
        workOwner,
      );
    });

    it('preserves an explicitly missing owner inherited from the source chat', async () => {
      await expect(
        generateHandoffSummary('user: rotate the signing key', {
          cwd: os.tmpdir(),
          workspaceId: 'workspace',
          workOwner: undefined,
        }),
      ).rejects.toThrow(HELPER_INVOCATION_SENTINEL);

      expect(mockResolveHelperInvocation.mock.calls[0]?.[2]).toHaveProperty(
        'workOwner',
        undefined,
      );
      expect(mockIsModelBlockedByStoredPolicy).toHaveBeenCalledWith(
        'haiku',
        undefined,
      );
    });
  });
});
