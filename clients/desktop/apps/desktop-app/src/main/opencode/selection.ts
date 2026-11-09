import { getRawOpenCodeModelId } from '@canopy/execution-engine/lib/opencode-models';
import { resolveRuntimeModel } from '@canopy/desktop-shared/types';
import type { ThinkingLevel } from '@canopy/protocol/thinking';
import {
  resolveAiCreditsScopeOwner,
  resolveBackgroundWorkOwner,
  type WorkOwnerSession,
} from '../agents/work-owner';
import { assertOpenCodeModelAvailable } from './connection';

export type OpenCodeSelection =
  | { kind: 'native'; supportedThinkingLevels: readonly ThinkingLevel[] }
  | {
      kind: 'gateway';
      supportedThinkingLevels: readonly ThinkingLevel[];
      inferenceBindingKey: string;
      funding: 'ai-credits' | 'org-gateway';
    };

/** Validate a chat's actual funding authority before accepting durable work. */
export async function assertOpenCodeSelectionAvailable(options: {
  model: string | undefined;
  session: WorkOwnerSession;
  signal?: AbortSignal;
}): Promise<OpenCodeSelection> {
  const model = options.model
    ? (resolveRuntimeModel(options.model) ?? options.model)
    : undefined;
  const session: WorkOwnerSession = {
    projectId: options.session.projectId,
    worktreeId: options.session.worktreeId,
    chatId: options.session.chatId,
    ...(options.session.executionContext === undefined
      ? {}
      : { executionContext: options.session.executionContext }),
  };
  const signal = options.signal ?? AbortSignal.timeout(60_000);
  signal.throwIfAborted();
  if (!model) throw new Error('Choose an OpenCode model before sending.');
  if (getRawOpenCodeModelId(model)) {
    const native = await assertOpenCodeModelAvailable(model, signal);
    signal.throwIfAborted();
    return {
      kind: 'native',
      supportedThinkingLevels: native.supportedThinkingLevels ?? [],
    };
  }
  // Native selection stays on its existing light path. Managed admission uses
  // the exact execution authority and disposes its unused local lease.
  const workOwner =
    session.executionContext === undefined
      ? resolveAiCreditsScopeOwner({ kind: 'work', ...session })
      : resolveBackgroundWorkOwner(session, session.executionContext);
  const { openOpenCodeExecutionRuntime } = await import('./execution-runtime');
  const { resolveAiCreditsAttribution } =
    await import('../agents/ai-credits-routing');
  const runtime = await openOpenCodeExecutionRuntime({
    model,
    sessionId: `opencode-preflight:${JSON.stringify([session.projectId, session.worktreeId, session.chatId])}`,
    workspaceId: session.projectId,
    signal,
    attribution: async () => {
      const [names, owner] = await Promise.all([
        resolveAiCreditsAttribution(session.projectId, session.worktreeId),
        workOwner,
      ]);
      return { ...names, ...(owner ? { workOwner: owner } : {}) };
    },
  });
  try {
    runtime.signal.throwIfAborted();
    if (!runtime.inferenceRoute || !runtime.inferenceFunding)
      throw new Error('The selected inference route is unavailable.');
    return {
      kind: 'gateway',
      supportedThinkingLevels: runtime.supportedThinkingLevels,
      inferenceBindingKey: runtime.inferenceRoute.bindingKey,
      funding: runtime.inferenceFunding,
    };
  } finally {
    await runtime.close();
  }
}
