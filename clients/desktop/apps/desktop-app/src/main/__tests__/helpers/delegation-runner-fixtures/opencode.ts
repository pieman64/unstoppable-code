import type { AgentRunRequest } from '@canopy/desktop-shared/node/delegation';
import { routeFixture } from '@canopy/desktop-shared/node/delegation/__tests__/fixtures';

export function request(options: {
  cwd: string;
  signal: AbortSignal;
  resumeSessionId?: string;
}): AgentRunRequest {
  return {
    delegationId: 'child',
    runGeneration: 1,
    launchKey: 'launch',
    parent: {
      harnessId: 'claude',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'parent',
      runtimeGeneration: 1,
      depth: 0,
      turnId: 'turn',
      toolCallId: 'spawn',
    },
    task: {
      modelId: 'opencode:fixture%2Fmodel',
      description: 'read',
      prompt: 'read',
      executionMode: 'background',
      contextPolicy: 'task_only',
      isolation: 'shared_worktree',
    },
    route: routeFixture({
      harnessId: 'opencode',
      runtimeKind: 'opencode-acp',
      runtimeModelId: 'opencode:fixture%2Fmodel',
    }),
    cwd: options.cwd,
    effectivePermission: 'read-only',
    ...(options.resumeSessionId
      ? { resumeSessionId: options.resumeSessionId }
      : {}),
    signal: options.signal,
  };
}
