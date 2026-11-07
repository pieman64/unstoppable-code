import { runCopilotTurn } from '@canopy/desktop-shared/node/copilot/turn-driver';
import type { AgentRunRequest } from '@canopy/desktop-shared/node/delegation';
import { routeFixture } from '@canopy/desktop-shared/node/delegation/__tests__/fixtures';
import { createHash } from 'node:crypto';
import {
  account,
  nativeRuntime as recipientFixture,
  type CopilotNativeFixture,
  type CopilotFixtureAccount,
} from '../../../../../../../packages/copilot-recipient/src/__tests__/helpers/copilot';
export { account } from '../../../../../../../packages/copilot-recipient/src/__tests__/helpers/copilot';
export type {
  CopilotFixtureAccount,
  FixtureSession,
  FixtureRuntime,
  CopilotNativeFixture,
} from '../../../../../../../packages/copilot-recipient/src/__tests__/helpers/copilot';

// Preserve this suite's legacy turn-driver mock seam while sharing the SDK fixture.
export function nativeRuntime(
  options: Parameters<typeof recipientFixture>[0] = {},
): CopilotNativeFixture {
  return recipientFixture({ ...options, driveTurn: runCopilotTurn });
}

export function request(options: {
  cwd: string;
  signal: AbortSignal;
  account?: CopilotFixtureAccount;
  resumeSessionId?: string;
}): AgentRunRequest {
  const selectedAccount = options.account ?? account;
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
      modelId: 'copilot:fixture',
      description: 'Read evidence',
      prompt: 'Read evidence',
      executionMode: 'background',
      contextPolicy: 'task_only',
      isolation: 'shared_worktree',
    },
    route: routeFixture({
      harnessId: 'copilot',
      runtimeKind: 'copilot-sdk',
      runtimeModelId: 'fixture',
      authAccountKey: createHash('sha256')
        .update(JSON.stringify(selectedAccount))
        .digest('hex'),
    }),
    cwd: options.cwd,
    effectivePermission: 'read-only',
    signal: options.signal,
  };
}
