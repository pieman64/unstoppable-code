import {
  initClaudeModels,
  initCodexModels,
  type AgentAuditEntry,
} from '@canopy/desktop-shared/types';
import type { HelperUsage } from '@canopy/desktop-shared/lib/helper-usage';
import type { WorkOwner } from '@canopy/protocol/llm-gateway';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CHAT_HISTORY_PROFILE_SCHEMA,
  prepareChatHistoryProfileInput,
  type PreparedChatHistoryProfile,
} from '../memory/local/chat-history-profile';
import { generateChatHistoryProfile } from '../memory/local/chat-history-profile-generator';

const mockStartObservedTask = jest.fn<void, [string, AgentAuditEntry]>();
const mockFinalizeObservedTask = jest.fn<
  void,
  [string, string, string | undefined, HelperUsage | undefined]
>();
const mockRunStructuredHelper = jest.fn<
  Promise<{ value: unknown; usage: HelperUsage }>,
  [Record<string, unknown>]
>();
const mockRunCodexStructuredHelper = jest.fn<
  Promise<{ value: unknown; usage: HelperUsage }>,
  [Record<string, unknown>]
>();
const mockIsModelBlockedByStoredPolicy = jest.fn<
  Promise<boolean>,
  [string | undefined, WorkOwner | undefined]
>(() => Promise.resolve(false));
const mockResolveHelperWorkOwner = jest.fn<Promise<WorkOwner>, []>(() =>
  Promise.resolve({ kind: 'personal' }),
);
const mockDispose = jest.fn();
let mockUserMemoryDir = '';

jest.mock('../lib/paths', () => ({
  getUserMemoryDir: (): string => mockUserMemoryDir,
}));

jest.mock('../lib/model-policy-state', () => ({
  isModelBlockedByStoredPolicy: (
    modelId: string | undefined,
    owner: WorkOwner | undefined,
  ): Promise<boolean> => mockIsModelBlockedByStoredPolicy(modelId, owner),
}));

jest.mock('../observability', () => ({
  getObservabilityService: (): {
    startObservedTask: typeof mockStartObservedTask;
    finalizeObservedTask: typeof mockFinalizeObservedTask;
    updateObservedTask: jest.Mock;
  } => ({
    startObservedTask: mockStartObservedTask,
    finalizeObservedTask: mockFinalizeObservedTask,
    updateObservedTask: jest.fn(),
  }),
}));

jest.mock('../integration/structured-helper-dispatch', () => ({
  codexStructuredHelperRunner: {
    run: (
      options: Record<string, unknown>,
    ): Promise<{ value: unknown; usage: HelperUsage }> =>
      mockRunCodexStructuredHelper(options),
  },
  runStructuredHelper: (
    options: Record<string, unknown>,
  ): Promise<{ value: unknown; usage: HelperUsage }> =>
    mockRunStructuredHelper(options),
  structuredHelperReportOnlyPermission: (): Record<string, unknown> => ({
    reportOnly: true,
  }),
}));

jest.mock('../ollama/helper-invocation', () => ({
  resolveHelperWorkOwner: (): Promise<WorkOwner> =>
    mockResolveHelperWorkOwner(),
  resolveHelperInvocation: (
    model: string,
  ): Promise<{
    providerType: 'claude' | 'codex';
    harness: 'claude' | 'codex';
    sdkModel: string;
    aiCreditsRouted: boolean;
    dispose: () => void;
  }> =>
    Promise.resolve({
      providerType: model === 'gpt-5.5' ? 'codex' : 'claude',
      harness: model === 'gpt-5.5' ? 'codex' : 'claude',
      sdkModel: model,
      aiCreditsRouted: false,
      dispose: mockDispose,
    }),
}));

jest.mock('../agents/ai-credits-routing', () => ({
  resolveAiCreditsRoutingOverride: (): Promise<null> => Promise.resolve(null),
}));

initClaudeModels([{ id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' }]);
initCodexModels([{ id: 'gpt-5.5', label: 'GPT-5.5' }]);

const USAGE: HelperUsage = { inputTokens: 900, outputTokens: 60 };

function prepared(): PreparedChatHistoryProfile {
  const result = prepareChatHistoryProfileInput({
    projects: [{ name: 'app', chatCount: 2 }],
    chats: [
      { title: 'Fix the login redirect', project: 'app', lastActivityAt: null },
    ],
  });
  if (!result) throw new Error('Expected usable chat titles');
  return result;
}

const CLAUDE_MODEL = {
  model: 'claude-haiku-4-5-20251001',
  thinkingLevel: 'off' as const,
  modelConfig: { thinkingLevel: 'off' as const },
};

describe('generateChatHistoryProfile', () => {
  let root = '';

  beforeEach(async () => {
    jest.clearAllMocks();
    mockIsModelBlockedByStoredPolicy.mockResolvedValue(false);
    root = await mkdtemp(join(tmpdir(), 'chat-profile-generator-'));
    // A user who never saved a memory has no memory folder yet.
    mockUserMemoryDir = join(root, 'memory');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('creates the user memory folder before the helper starts in it', async () => {
    let folderExistedAtSpawn = false;
    mockRunStructuredHelper.mockImplementation((options) => {
      folderExistedAtSpawn = existsSync(String(options.repoPath));
      return Promise.resolve({ value: { facts: [] }, usage: USAGE });
    });

    await generateChatHistoryProfile(prepared(), CLAUDE_MODEL);

    expect(folderExistedAtSpawn).toBe(true);
  });

  it('runs a report-only structured helper against the user memory folder and records it in the audit trail', async () => {
    const value = { facts: [] };
    mockRunStructuredHelper.mockResolvedValue({ value, usage: USAGE });

    const generation = await generateChatHistoryProfile(
      prepared(),
      CLAUDE_MODEL,
    );

    expect(generation.output).toBe(value);
    const [options] = mockRunStructuredHelper.mock.calls[0] ?? [];
    expect(options).toMatchObject({
      kind: 'local-memory-chat-profile',
      repoPath: mockUserMemoryDir,
      model: 'claude-haiku-4-5-20251001',
      schema: CHAT_HISTORY_PROFILE_SCHEMA,
      permission: { reportOnly: true },
      localMemoryEnabled: true,
    });
    expect(String(options?.systemPrompt)).toContain(
      "You summarize what a person's own chat titles reveal about them.",
    );
    expect(String(options?.userMessage)).toContain(
      'T1. Fix the login redirect',
    );
    const [, entry] = mockStartObservedTask.mock.calls[0] ?? [];
    expect(entry).toMatchObject({
      eventType: 'local_memory_chat_profile',
      label: 'Chat History Profile',
      status: 'running',
    });
    expect(mockDispose).toHaveBeenCalled();

    generation.finalize('success');
    generation.finalize('failure', 'late');
    expect(mockFinalizeObservedTask).toHaveBeenCalledTimes(1);
    expect(mockFinalizeObservedTask).toHaveBeenCalledWith(
      expect.stringContaining('helper:local-memory-chat-profile:'),
      'success',
      undefined,
      expect.objectContaining({ inputTokens: 900, outputTokens: 60 }),
    );
  });

  it('uses the Codex runner for a Codex summary model', async () => {
    mockRunCodexStructuredHelper.mockResolvedValue({
      value: { facts: [] },
      usage: USAGE,
    });

    await generateChatHistoryProfile(prepared(), {
      model: 'gpt-5.5',
      thinkingLevel: 'low',
      modelConfig: { thinkingLevel: 'low' },
    });

    expect(mockRunCodexStructuredHelper).toHaveBeenCalledWith(
      expect.objectContaining({
        permissionMode: 'report-only',
        repoPath: mockUserMemoryDir,
        schema: CHAT_HISTORY_PROFILE_SCHEMA,
      }),
    );
    expect(mockRunStructuredHelper).not.toHaveBeenCalled();
  });

  it('fails without running a model the organization blocks', async () => {
    mockIsModelBlockedByStoredPolicy.mockResolvedValue(true);

    await expect(
      generateChatHistoryProfile(prepared(), CLAUDE_MODEL),
    ).rejects.toThrow();
    expect(mockRunStructuredHelper).not.toHaveBeenCalled();
    expect(mockIsModelBlockedByStoredPolicy).toHaveBeenCalledWith(
      CLAUDE_MODEL.model,
      { kind: 'personal' },
    );
    expect(mockFinalizeObservedTask).toHaveBeenCalledWith(
      expect.any(String),
      'failure',
      expect.any(String),
      undefined,
    );
  });
});
