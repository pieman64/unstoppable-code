import type { AgentRunRequest } from '@canopy/desktop-shared/node/delegation';

export function successfulQuery(): AsyncGenerator<
  Record<string, unknown>,
  void,
  void
> & { close: jest.Mock } {
  async function* events(): AsyncGenerator<Record<string, unknown>> {
    await Promise.resolve();
    yield {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'done',
      total_cost_usd: 0,
      usage: { input_tokens: 1, output_tokens: 1 },
    };
  }
  return Object.assign(events(), { close: jest.fn() });
}

export const request = {
  delegationId: 'delegation-1',
  runGeneration: 1,
  launchKey: 'launch-1',
  parent: {
    harnessId: 'codex',
    projectId: 'project',
    worktreeId: 'worktree',
    chatId: 'chat',
    sessionKey: 'session',
    turnId: 'turn',
    toolCallId: 'call',
    runtimeGeneration: 1,
    depth: 0,
  },
  task: {
    modelId: 'claude-test',
    description: 'Inspect code',
    prompt: 'Inspect the requested code.',
    executionMode: 'foreground',
    contextPolicy: 'task_only',
    isolation: 'shared_worktree',
  },
  route: {
    selectedModelId: 'claude-test',
    runtimeModelId: 'claude-test',
    harnessId: 'claude',
    runtimeKind: 'claude-sdk',
    runnerRegistrationId: 'claude-local',
    runtimeVersion: '1',
    adapterVersion: '1',
    modelSource: 'test',
    providerType: 'subscription',
    assignmentRevision: 'assignment-1',
    billingAuthority: 'subscription',
    aiCreditsRouted: false,
    capabilities: ['read'],
    supportedThinkingLevels: [],
    capabilitySnapshotHash: 'hash',
    capabilityGeneration: 1,
    policyRevision: 'read-only-1',
  },
  cwd: '/worktree',
  effectivePermission: 'read-only',
  signal: new AbortController().signal,
} satisfies AgentRunRequest;
