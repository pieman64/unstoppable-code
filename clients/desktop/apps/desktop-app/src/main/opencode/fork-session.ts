import { lstat, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hostPlatformOperatingSystem } from '@canopy/core-platform';
import {
  forkOpenCodeSession,
  discardOpenCodeSessionFork,
} from '@canopy/desktop-shared/node/opencode/session-fork';
import { buildChatSessionKey } from '../agents/session-key';
import {
  assertOpenCodeConnectionGeneration,
  openManagedOpenCodeRuntime,
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
  signal?: AbortSignal;
}
const pending = new Map<string, { source: string; result: Promise<string> }>();

export async function forkOpenCodeSessionByIdViaOneShot(
  options: OpenCodeForkOptions,
): Promise<string> {
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
  const result = transfer(options);
  pending.set(key, { source, result });
  try {
    return await result;
  } finally {
    if (pending.get(key)?.result === result) pending.delete(key);
  }
}

async function transfer(options: OpenCodeForkOptions): Promise<string> {
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
  const runtime = await openManagedOpenCodeRuntime({
    signal,
    workspaceId: options.sourceProjectId,
  });
  let result: { sessionId: string } | { error: unknown };
  try {
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
    result = { sessionId: forked.sessionId };
  } catch (error) {
    result = { error };
  }
  try {
    await runtime.close();
  } catch (closeError) {
    if ('error' in result)
      throw Object.assign(
        new Error('OpenCode fork failed and runtime cleanup was incomplete.'),
        { cause: result.error, errors: [result.error, closeError] },
      );
    throw closeError;
  }
  if ('error' in result) throw result.error;
  return result.sessionId;
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
