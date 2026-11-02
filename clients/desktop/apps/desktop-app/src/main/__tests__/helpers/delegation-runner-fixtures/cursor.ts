import type { AgentRunRequest } from '@canopy/desktop-shared/node/delegation';
import { routeFixture } from '@canopy/desktop-shared/node/delegation/__tests__/fixtures';
import type { CursorTurnResult } from '@canopy/desktop-shared/node/cursor/turn-driver';

export function request(options: {
  cwd: string;
  signal: AbortSignal;
  resumeSessionId?: string;
}): AgentRunRequest {
  return {
    delegationId: 'child',
    runGeneration: 1,
    launchKey: 'launch',
    resumeSessionId: options.resumeSessionId,
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
      modelId: 'cursor-default',
      description: 'Read evidence',
      prompt: 'Read evidence',
      executionMode: 'background',
      contextPolicy: 'task_only',
      isolation: 'shared_worktree',
    },
    route: routeFixture({
      harnessId: 'cursor',
      runtimeKind: 'cursor-acp',
      runtimeModelId: 'cursor-default',
      effectiveThinkingLevel: 'high',
    }),
    cwd: options.cwd,
    effectivePermission: 'read-only',
    signal: options.signal,
  };
}

export const success: CursorTurnResult = {
  sessionId: 'native-child',
  isError: false,
  cancelled: false,
  message: '',
  contextLost: false,
  inheritedContextDelivered: false,
  responseText: 'Verified evidence',
};
