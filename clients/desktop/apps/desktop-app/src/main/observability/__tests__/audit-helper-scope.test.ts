import {
  AGENT_AUDIT_EVENT_TYPES,
  type AgentAuditEventType,
} from '@canopy/desktop-shared/types';
import type { ObservedHelperTaskOptions } from '../../lib/helper-observed-task';

const AUDIT_EVENT_SCOPE: Record<
  AgentAuditEventType,
  'chat' | 'entry' | 'global'
> = {
  worktree_chat: 'chat',
  standalone_chat: 'chat',
  app_advisor: 'chat',
  pipeline_editor: 'chat',
  pipeline_agent_turn: 'entry',
  pipeline_advisor: 'entry',
  pr_generation: 'entry',
  pr_split_planning: 'entry',
  commit_message_generation: 'entry',
  branch_naming: 'chat',
  cron_generation: 'global',
  automation_if_command_generation: 'entry',
  worktree_summary: 'entry',
  chat_summary: 'chat',
  chat_handoff_summary: 'chat',
  archive_summary: 'chat',
  worktree_plan_chat: 'chat',
  worktree_plan_diagram: 'entry',
  code_review_annotations: 'entry',
  code_review_diagram: 'entry',
  local_memory_consolidation: 'global',
  // This profile is synthesized from many chat titles and has no single-chat origin.
  local_memory_chat_profile: 'global',
  // A scan reads one owner partition across many chats.
  skill_suggestion_scan: 'global',
  managed_delegation: 'entry',
};

const mockStartObservedHelperTask = jest.fn<
  void,
  [ObservedHelperTaskOptions]
>();
const mockFinalizeObservedHelperTask = jest.fn<
  void,
  [string, 'success' | 'failure', string?]
>();
const mockResolveHelperWorkOwner = jest.fn<
  Promise<undefined>,
  [Record<string, unknown>]
>(() => Promise.resolve(undefined));
const mockIsModelBlockedByStoredPolicy = jest.fn<
  Promise<boolean>,
  [string, unknown]
>(() => Promise.resolve(true));

jest.mock('../../lib/helper-observed-task', () => ({
  startObservedHelperTask: (options: ObservedHelperTaskOptions): void =>
    mockStartObservedHelperTask(options),
  finalizeObservedHelperTask: (
    taskKey: string,
    status: 'success' | 'failure',
    error?: string,
  ): void => mockFinalizeObservedHelperTask(taskKey, status, error),
  markObservedHelperTaskAiCreditsRouted: jest.fn(),
}));

jest.mock('../../ollama/helper-invocation', () => ({
  resolveHelperWorkOwner: (
    options: Record<string, unknown>,
  ): Promise<undefined> => mockResolveHelperWorkOwner(options),
}));

jest.mock('../../lib/model-policy-state', () => ({
  isModelBlockedByStoredPolicy: (
    model: string,
    workOwner: unknown,
  ): Promise<boolean> => mockIsModelBlockedByStoredPolicy(model, workOwner),
}));

import { generateCommitMessage } from '../../lib/commit-message-generator';

describe('audit helper scope', () => {
  it('classifies every audit event type explicitly', () => {
    expect(Object.keys(AUDIT_EVENT_SCOPE).sort()).toEqual(
      [...AGENT_AUDIT_EVENT_TYPES].sort(),
    );
    expect(AUDIT_EVENT_SCOPE.local_memory_chat_profile).toBe('global');
  });

  it('retains chat context when a commit-message helper starts in a chat', async () => {
    mockStartObservedHelperTask.mockClear();
    mockFinalizeObservedHelperTask.mockClear();
    mockResolveHelperWorkOwner.mockClear();
    mockIsModelBlockedByStoredPolicy.mockClear();
    mockResolveHelperWorkOwner.mockResolvedValue(undefined);
    mockIsModelBlockedByStoredPolicy.mockResolvedValue(true);

    const auditContext = {
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
    };
    await generateCommitMessage({
      repoPath: '/repo',
      branchName: 'feature/audit-scope',
      diff: 'diff',
      model: 'claude-test',
      thinkingLevel: 'off',
      instructions: 'instructions',
      instructionMode: 'append',
      auditContext,
    });

    expect(mockStartObservedHelperTask).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'commit_message_generation',
        chatId: 'chat',
      }),
    );
  });
});
