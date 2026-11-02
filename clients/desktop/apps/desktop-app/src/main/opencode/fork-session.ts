import { lstat, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveRuntimeModel } from '@canopy/desktop-shared/types';
import { getRawOpenCodeModelId } from '@canopy/desktop-shared/lib/opencode-models';
import { prepareOpenCodeInferenceRoute } from '@canopy/desktop-shared/node/opencode/inference-route';
import { serializeWorkspaceContext } from '@canopy/protocol/workspace-context';
import type { OpenCodeExecutionRuntime } from './execution-runtime';
import { hostPlatformOperatingSystem } from '@canopy/core-platform';
import {
  forkOpenCodeSession,
  discardOpenCodeSessionFork,
} from '@canopy/desktop-shared/node/opencode/session-fork';
import { buildChatSessionKey } from '../agents/session-key';
import {
  assertOpenCodeConnectionGeneration,
  openManagedOpenCodeRuntime,
  type ManagedOpenCodeRuntime,
} from './connection';
import { getOpenCodeSessionProfile } from './session-profile';

interface OpenCodeForkOptions {
  projectId: string;
  worktreeId: string;
  chatId: string;
  cwd: string;
  sourceProjectId: string;
  sourceWorktreeId: string;
  sourceChatId: string;
  sourceCwd: string;
  sourceSessionId: string;
  model?: string;
  signal?: AbortSignal;
}
interface OpenCodeForkResult {
  sessionId: string;
  executionContext?: string;
}
const pending = new Map<
  string,
  { source: string; result: Promise<OpenCodeForkResult> }
>();

export async function forkOpenCodeSessionByIdViaOneShot(
  options: OpenCodeForkOptions,
): Promise<OpenCodeForkResult> {
  options.signal?.throwIfAborted();
  const key = buildChatSessionKey(
    options.projectId,
    options.worktreeId,
    options.chatId,
  );
  const source = JSON.stringify([
    options.sourceProjectId,
    options.sourceWorktreeId,
    options.sourceChatId,
    options.sourceCwd,
    options.sourceSessionId,
    options.model,
    options.cwd,
  ]);
  const existing = pending.get(key);
  if (existing) {
    if (existing.source !== source)
      throw new Error(
        'A different OpenCode source is already being forked into this chat.',
      );
    return existing.result;
  }
  const result = transfer({ ...options });
  pending.set(key, { source, result });
  try {
    return await result;
  } finally {
    if (pending.get(key)?.result === result) pending.delete(key);
  }
}

async function transfer(
  options: OpenCodeForkOptions,
): Promise<OpenCodeForkResult> {
  const sourceProfile = getOpenCodeSessionProfile({
    projectId: options.sourceProjectId,
    worktreeId: options.sourceWorktreeId,
    chatId: options.sourceChatId,
    cwd: options.sourceCwd,
  });
  const destinationProfile = getOpenCodeSessionProfile(options);
  const file = join(sourceProfile, 'host-session.json');
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4096)
    throw new Error('OpenCode source session binding is invalid.');
  const binding: unknown = JSON.parse(await readFile(file, 'utf8'));
  if (
    !binding ||
    typeof binding !== 'object' ||
    !('version' in binding) ||
    binding.version !== 1 ||
    !('sessionId' in binding) ||
    binding.sessionId !== options.sourceSessionId ||
    !('cwd' in binding) ||
    binding.cwd !== options.sourceCwd
  )
    throw new Error('OpenCode source session binding does not match.');
  const signal = AbortSignal.any([
    ...(options.signal ? [options.signal] : []),
    AbortSignal.timeout(180_000),
  ]);
  const model = options.model
    ? (resolveRuntimeModel(options.model) ?? options.model)
    : undefined;
  const runtimes: ManagedOpenCodeRuntime[] = [];
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> =>
    (closing ??= (async (): Promise<void> => {
      const results = await Promise.allSettled(
        runtimes.map((runtime) => runtime.close()),
      );
      for (const result of results)
        if (result.status === 'rejected') throw result.reason;
    })());
  let result: OpenCodeForkResult | { error: unknown };
  let completedFork: OpenCodeForkResult | undefined;
  let forkRuntime:
    | ManagedOpenCodeRuntime
    | OpenCodeExecutionRuntime
    | undefined;
  let executionContext: string | undefined;
  try {
    let runtime: ManagedOpenCodeRuntime | OpenCodeExecutionRuntime;
    if (model && !getRawOpenCodeModelId(model)) {
      const [
        { resolveSessionAiCreditsAttribution, resolveAiCreditsAttribution },
        { resolveBackgroundWorkOwner },
        { openOpenCodeExecutionRuntime },
      ] = await Promise.all([
        import('../agents/ai-credits-routing'),
        import('../agents/work-owner'),
        import('./execution-runtime'),
      ]);
      const attribution = await resolveSessionAiCreditsAttribution({
        projectId: options.sourceProjectId,
        worktreeId: options.sourceWorktreeId,
        chatId: options.sourceChatId,
      });
      if (!attribution.workOwner)
        throw new Error(
          'The source work owner is unavailable. Reopen the chat and try again.',
        );
      executionContext = serializeWorkspaceContext(attribution.workOwner);
      const destinationOwner = await resolveBackgroundWorkOwner(
        { projectId: options.projectId, worktreeId: options.worktreeId },
        executionContext,
      );
      if (!destinationOwner)
        throw new Error(
          'The destination work owner is unavailable. Reopen the chat and try again.',
        );
      const destinationAttribution = {
        ...(await resolveAiCreditsAttribution(
          options.projectId,
          options.worktreeId,
        )),
        workOwner: destinationOwner,
      };
      const sourceRuntime = await openOpenCodeExecutionRuntime({
        model,
        sessionId: `opencode-fork-source:${buildChatSessionKey(options.sourceProjectId, options.sourceWorktreeId, options.sourceChatId)}`,
        cwd: options.sourceCwd,
        workspaceId: options.sourceProjectId,
        signal,
        attribution: () => Promise.resolve(attribution),
      });
      runtimes.push(sourceRuntime);
      if (!sourceRuntime.inferenceRoute)
        throw new Error('The source inference route is unavailable.');
      const destinationRuntime = await openOpenCodeExecutionRuntime({
        model,
        sessionId: `opencode-fork:${buildChatSessionKey(options.projectId, options.worktreeId, options.chatId)}`,
        cwd: options.cwd,
        workspaceId: options.projectId,
        signal: AbortSignal.any([signal, sourceRuntime.signal]),
        expectedInferenceBindingKey: sourceRuntime.inferenceRoute.bindingKey,
        attribution: () => Promise.resolve(destinationAttribution),
      });
      runtimes.push(destinationRuntime);
      if (
        !destinationRuntime.inferenceRoute ||
        prepareOpenCodeInferenceRoute(sourceRuntime.inferenceRoute)
          .identityDigest !==
          prepareOpenCodeInferenceRoute(destinationRuntime.inferenceRoute)
            .identityDigest
      )
        throw new Error(
          'The funding owner changed. Start a new chat instead of forking this session.',
        );
      runtime = destinationRuntime;
    } else {
      runtime = await openManagedOpenCodeRuntime({
        signal,
        workspaceId: options.sourceProjectId,
      });
      runtimes.push(runtime);
    }
    forkRuntime = runtime;
    assertOpenCodeConnectionGeneration(runtime.generation);
    const forked = await forkOpenCodeSession({
      ...runtime,
      platform: hostPlatformOperatingSystem(),
      source: {
        profileDir: sourceProfile,
        cwd: options.sourceCwd,
        sessionId: options.sourceSessionId,
      },
      destination: { profileDir: destinationProfile, cwd: options.cwd },
      publish: async (fork) => {
        runtime.signal.throwIfAborted();
        assertOpenCodeConnectionGeneration(runtime.generation);
        await writeFile(
          join(destinationProfile, 'host-session.json'),
          JSON.stringify({
            version: 1,
            sessionId: fork.sessionId,
            cwd: options.cwd,
            capabilityDigest: fork.binding.digest,
            resourceGeneration: fork.binding.generation,
          }),
          { mode: 0o600, flag: 'wx' },
        );
        runtime.signal.throwIfAborted();
      },
    });
    completedFork = {
      sessionId: forked.sessionId,
      ...(executionContext ? { executionContext } : {}),
    };
    // Check the lease before deliberate disposal aborts its signal.
    runtime.signal.throwIfAborted();
    assertOpenCodeConnectionGeneration(runtime.generation);
    result = completedFork;
  } catch (error) {
    result = { error };
  }
  try {
    await close();
  } catch (closeError) {
    result = {
      error:
        'error' in result
          ? Object.assign(
              new Error(
                'OpenCode fork failed and runtime cleanup was incomplete.',
              ),
              { cause: result.error, errors: [result.error, closeError] },
            )
          : closeError,
    };
  }
  if (!('error' in result)) {
    try {
      signal.throwIfAborted();
      if (forkRuntime)
        assertOpenCodeConnectionGeneration(forkRuntime.generation);
    } catch (error) {
      result = { error };
    }
  }
  if ('error' in result) {
    // Canonical chat publication has not begun. Retire only the verified
    // native fork, using a fresh bounded cleanup signal after leases close.
    if (completedFork && forkRuntime) {
      try {
        await discardOpenCodeSessionFork({
          ...forkRuntime,
          signal: AbortSignal.timeout(30000),
          profileDir: destinationProfile,
          cwd: options.cwd,
          sessionId: completedFork.sessionId,
        });
        await rm(destinationProfile, { recursive: true, force: true });
      } catch (cleanupError) {
        throw Object.assign(
          new Error('OpenCode fork failed and native cleanup was incomplete.'),
          { cause: result.error, errors: [result.error, cleanupError] },
        );
      }
    }
    throw result.error;
  }
  return result;
}

/** Only for the caller's newly reserved chat, before canonical publication begins. */
export async function discardUnpublishedOpenCodeFork(options: {
  projectId: string;
  worktreeId: string;
  chatId: string;
  cwd: string;
  sessionId: string;
}): Promise<void> {
  const profileDir = getOpenCodeSessionProfile(options);
  const file = join(profileDir, 'host-session.json');
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4096)
    throw new Error('OpenCode fork cleanup binding is invalid.');
  const binding: unknown = JSON.parse(await readFile(file, 'utf8'));
  if (
    !binding ||
    typeof binding !== 'object' ||
    !('sessionId' in binding) ||
    binding.sessionId !== options.sessionId ||
    !('cwd' in binding) ||
    binding.cwd !== options.cwd
  )
    throw new Error('OpenCode fork cleanup binding does not match.');
  const runtime = await openManagedOpenCodeRuntime({
    signal: AbortSignal.timeout(30000),
    workspaceId: options.projectId,
  });
  try {
    await discardOpenCodeSessionFork({
      ...runtime,
      profileDir,
      cwd: options.cwd,
      sessionId: options.sessionId,
    });
    await rm(profileDir, { recursive: true, force: true });
  } finally {
    await runtime.close();
  }
}
