import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { PlatformOperatingSystem } from '@canopy/core-runtime';
import {
  canonicalOpenCodeCapability,
  forkOpenCodeCapabilityBinding,
  readOpenCodeCapabilityBinding,
  type OpenCodeCapabilityBinding,
} from './capability-snapshot';
import {
  startOpenCodeRuntime,
  type OpenCodeRuntimeOptions,
  type OwnedOpenCodeRuntime,
} from './runtime';
import type { OpenCodeForkScope } from './approval-plugin';

type RuntimeOptions = Pick<
  OpenCodeRuntimeOptions,
  | 'executable'
  | 'prefix'
  | 'env'
  | 'providerConfig'
  | 'runtimeIdentity'
  | 'signal'
>;
export interface OpenCodeSessionForkOptions extends RuntimeOptions {
  platform: PlatformOperatingSystem;
  source: { profileDir: string; cwd: string; sessionId: string };
  destination: { profileDir: string; cwd: string };
  /** Trusted host publication remains inside the creator's rollback lifetime. */
  publish?: (fork: {
    sessionId: string;
    binding: OpenCodeCapabilityBinding;
  }) => Promise<void>;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function same(left: unknown, right: unknown): boolean {
  return (
    canonicalOpenCodeCapability(left) === canonicalOpenCodeCapability(right)
  );
}
function session(
  value: unknown,
  id: string,
  cwd: string,
): Record<string, unknown> {
  if (
    !record(value) ||
    value.id !== id ||
    !record(value.location) ||
    value.location.directory !== cwd
  )
    throw new Error('OpenCode native session identity does not match.');
  return value;
}
/** A returned ID alone never establishes ownership or permits native deletion. */
function verifyNativeFork(
  value: unknown,
  id: string,
  scope: OpenCodeForkScope,
): Record<string, unknown> {
  if (
    !id ||
    id.length > 256 ||
    id === scope.sourceSessionId ||
    !record(value) ||
    value.id !== id ||
    value.parentID != null ||
    !record(value.fork) ||
    value.fork.sessionID !== scope.sourceSessionId ||
    !record(value.time) ||
    typeof value.time.created !== 'number' ||
    !Number.isSafeInteger(value.time.created) ||
    value.time.created < scope.createdAfter ||
    !record(value.location) ||
    typeof value.location.directory !== 'string' ||
    ![scope.sourceCwd, scope.destinationCwd].includes(value.location.directory)
  )
    throw new Error('OpenCode did not create an independent native fork.');
  return value;
}

/** Refuse an attach that would normalize or replace the source's native grants. */
function sourceDirectories(info: Record<string, unknown>): string[] {
  const stored = record(info.metadata)
    ? info.metadata['opencode.acp.additionalDirectories']
    : undefined;
  if (
    stored !== undefined &&
    (!Array.isArray(stored) ||
      !stored.every((entry: unknown) => typeof entry === 'string'))
  )
    throw new Error('OpenCode source directory grants are invalid.');
  const directories: string[] = stored ?? [];
  if (
    directories.some(
      (directory) =>
        !isAbsolute(directory) ||
        /[*?]/.test(directory) ||
        resolve(directory) !== directory ||
        (record(info.location) && directory === info.location.directory),
    )
  )
    throw new Error('OpenCode source directory grants cannot be preserved.');
  const storedPermissions = info.permissions ?? [];
  if (!Array.isArray(storedPermissions))
    throw new Error('OpenCode source permissions are invalid.');
  const permissions: readonly unknown[] = storedPermissions;
  const rules = Array.from(new Set(directories)).map((directory) => ({
    action: 'external_directory',
    resource: join(directory, '*'),
    effect: 'allow',
  }));
  const activated = [
    ...rules,
    ...permissions.filter(
      (rule: unknown) => !rules.some((owned) => same(rule, owned)),
    ),
  ];
  if (
    !same(activated, permissions) ||
    new Set(directories).size !== directories.length
  )
    throw new Error('OpenCode source directory grants cannot be preserved.');
  return directories;
}
async function context(
  runtime: OwnedOpenCodeRuntime,
  id: string,
): Promise<Record<string, unknown>[]> {
  const value = await runtime.readMetadata(
    `/sessions/${encodeURIComponent(id)}/context`,
  );
  if (!record(value) || !Array.isArray(value.data) || value.data.length > 10000)
    throw new Error(
      'OpenCode native context is unavailable or exceeds the limit.',
    );
  if (Buffer.byteLength(JSON.stringify(value)) > 32 * 1024 * 1024)
    throw new Error('OpenCode native context exceeds the size limit.');
  const result: Record<string, unknown>[] = [];
  const ids = new Set<string>();
  for (const item of value.data) {
    if (
      !record(item) ||
      typeof item.id !== 'string' ||
      !item.id ||
      ids.has(item.id)
    )
      throw new Error('OpenCode native message identity is invalid.');
    ids.add(item.id);
    result.push(item);
  }
  return result;
}
function settled(message: Record<string, unknown>): boolean {
  return (
    !(
      message.type === 'assistant' &&
      (!record(message.time) || message.time.completed == null)
    ) &&
    !(
      ['shell', 'compaction'].includes(String(message.type)) &&
      message.status === 'running'
    )
  );
}
function verifyContext(
  source: Record<string, unknown>[],
  fork: Record<string, unknown>[],
): void {
  const expected = source.filter(settled);
  const oldIds = new Set(source.map((message) => message.id));
  const data = (message: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(Object.entries(message).filter(([key]) => key !== 'id'));
  if (
    fork.length !== expected.length ||
    fork.some(
      (message, index) =>
        oldIds.has(message.id) || !same(data(message), data(expected[index])),
    )
  )
    throw new Error('OpenCode did not preserve the native fork context.');
}
function sourceIdentity(info: Record<string, unknown>): unknown {
  return {
    id: info.id,
    location: info.location,
    metadata: info.metadata,
    permissions: info.permissions,
  };
}
const deny = (): Promise<{ decision: 'deny' }> =>
  Promise.resolve({ decision: 'deny' });
const ignore = (): void => undefined;

/** Cleanup is bound to the verified fork, never the source or an arbitrary session. */
export async function discardOpenCodeSessionFork(
  options: RuntimeOptions & {
    profileDir: string;
    cwd: string;
    sessionId: string;
  },
): Promise<void> {
  const file = join(options.profileDir, 'native-fork.json');
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096)
    throw new Error('OpenCode fork cleanup binding is invalid.');
  const value: unknown = JSON.parse(await readFile(file, 'utf8'));
  if (
    !record(value) ||
    value.version !== 1 ||
    value.forkSessionId !== options.sessionId ||
    typeof value.sourceSessionId !== 'string' ||
    value.sourceSessionId === options.sessionId ||
    typeof value.sourceCwd !== 'string' ||
    !isAbsolute(value.sourceCwd) ||
    value.destinationCwd !== (await realpath(options.cwd)) ||
    typeof value.createdAfter !== 'number' ||
    !Number.isSafeInteger(value.createdAfter)
  )
    throw new Error('OpenCode fork cleanup binding does not match.');
  await removeOpenCodeSessionForkWithVerification(options, {
    sourceSessionId: value.sourceSessionId,
    sourceCwd: value.sourceCwd,
    destinationCwd: value.destinationCwd,
    createdAfter: value.createdAfter,
    forkSessionId: options.sessionId,
  });
}

/** Recheck provenance in the fresh owner before invoking its scoped mutation. */
async function removeOpenCodeSessionForkWithVerification(
  options: RuntimeOptions & { profileDir: string; cwd: string },
  forkScope: OpenCodeForkScope & { forkSessionId: string },
): Promise<void> {
  const runtime = await startOpenCodeRuntime({
    ...options,
    cwd: options.cwd,
    forkScope,
    authorize: deny,
    onUpdate: ignore,
  });
  try {
    verifyNativeFork(
      await runtime.readMetadata(
        `/sessions/${encodeURIComponent(forkScope.forkSessionId)}`,
      ),
      forkScope.forkSessionId,
      forkScope,
    );
    await runtime.manageFork(forkScope.forkSessionId, 'remove');
  } finally {
    await runtime.close();
  }
}

/** V2 owns the database and copies settled history and instruction snapshots. */
export async function forkOpenCodeSession(
  options: OpenCodeSessionForkOptions,
): Promise<{ sessionId: string; binding: OpenCodeCapabilityBinding }> {
  options.signal.throwIfAborted();
  if (
    resolve(options.source.profileDir) ===
    resolve(options.destination.profileDir)
  )
    throw new Error('OpenCode forks require a distinct destination profile.');
  const sourceProfile = await lstat(options.source.profileDir);
  if (!sourceProfile.isDirectory() || sourceProfile.isSymbolicLink())
    throw new Error('OpenCode source profile is unavailable.');
  const originalBinding = await readOpenCodeCapabilityBinding(
    options.source.profileDir,
    options.source.sessionId,
  );
  if (!originalBinding)
    throw new Error('OpenCode source capability history is unavailable.');
  const sourceCwd = await realpath(options.source.cwd);
  const destinationCwd = await realpath(options.destination.cwd);
  await mkdir(dirname(options.destination.profileDir), {
    recursive: true,
    mode: 0o700,
  });
  await mkdir(options.destination.profileDir, { mode: 0o700 }).catch(
    (error: unknown) => {
      if (record(error) && error.code === 'EEXIST')
        throw new Error('OpenCode destination profile already exists.');
      throw error;
    },
  );
  const forkScope: OpenCodeForkScope = {
    sourceSessionId: options.source.sessionId,
    sourceCwd,
    destinationCwd,
    createdAfter: Date.now(),
  };
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(180000)]);
  const creator = new AbortController();
  let creatingNativeFork = false;
  let creationOutcomeUnknown = false;
  let cancellationTimer: ReturnType<typeof setTimeout> | undefined;
  const abortCreator = (): void => {
    if (creatingNativeFork) {
      // Creation can commit before its response arrives. Keep its owner alive
      // briefly so rollback receives the ID, without extending work forever.
      cancellationTimer ??= setTimeout(
        () => creator.abort(signal.reason),
        30000,
      );
    } else {
      creator.abort(signal.reason);
    }
  };
  signal.addEventListener('abort', abortCreator, { once: true });
  if (signal.aborted) abortCreator();
  let runtime: OwnedOpenCodeRuntime | undefined;
  let forkId: string | undefined;
  let candidateId: string | undefined;
  try {
    // Use the destination's private host configuration; source profile bytes stay untouched.
    runtime = await startOpenCodeRuntime({
      ...options,
      signal: creator.signal,
      cwd: sourceCwd,
      profileDir: options.destination.profileDir,
      forkScope,
      authorize: deny,
      onUpdate: ignore,
    });
    const source = session(
      await runtime.readMetadata(
        `/sessions/${encodeURIComponent(options.source.sessionId)}`,
      ),
      options.source.sessionId,
      sourceCwd,
    );
    const additionalDirectories = sourceDirectories(source);
    if (source.revert !== undefined)
      throw new Error(
        'OpenCode cannot preserve a reverted session in a native fork.',
      );
    const before = await context(runtime, options.source.sessionId);
    await runtime.client.loadSession({
      sessionId: options.source.sessionId,
      cwd: sourceCwd,
      mcpServers: [],
      additionalDirectories,
    });
    signal.throwIfAborted();
    creatingNativeFork = true;
    creationOutcomeUnknown = true;
    try {
      // Do not cancel the ACP response independently of the bounded creator.
      const result = await runtime.client.forkSession({
        sessionId: options.source.sessionId,
        cwd: sourceCwd,
        mcpServers: [],
        additionalDirectories,
      });
      candidateId = result.sessionId;
      creationOutcomeUnknown = false;
    } finally {
      creatingNativeFork = false;
      clearTimeout(cancellationTimer);
      if (signal.aborted) abortCreator();
    }
    signal.throwIfAborted();
    const info = verifyNativeFork(
      session(
        await runtime.readMetadata(
          `/sessions/${encodeURIComponent(candidateId)}`,
        ),
        candidateId,
        sourceCwd,
      ),
      candidateId,
      forkScope,
    );
    forkId = candidateId;
    await writeFile(
      join(options.destination.profileDir, 'native-fork.json'),
      JSON.stringify({ version: 1, ...forkScope, forkSessionId: forkId }),
      { mode: 0o600, flag: 'wx' },
    );
    if (
      !same(info.metadata, source.metadata) ||
      !same(info.permissions, source.permissions)
    )
      throw new Error('OpenCode did not preserve the native fork permissions.');
    verifyContext(before, await context(runtime, forkId));
    if (
      !same(
        sourceIdentity(source),
        sourceIdentity(
          session(
            await runtime.readMetadata(
              `/sessions/${encodeURIComponent(options.source.sessionId)}`,
            ),
            options.source.sessionId,
            sourceCwd,
          ),
        ),
      )
    )
      throw new Error('OpenCode source session changed while forking.');
    if (destinationCwd !== sourceCwd) await runtime.manageFork(forkId, 'move');
    session(
      await runtime.readMetadata(`/sessions/${encodeURIComponent(forkId)}`),
      forkId,
      destinationCwd,
    );
    const binding = await forkOpenCodeCapabilityBinding(
      options.source.profileDir,
      options.source.sessionId,
      options.destination.profileDir,
      forkId,
      signal,
      originalBinding,
    );
    signal.throwIfAborted();
    await options.publish?.({ sessionId: forkId, binding });
    signal.throwIfAborted();
    const completedRuntime = runtime;
    runtime = undefined;
    await completedRuntime.close();
    return { sessionId: forkId, binding };
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    const liveRemovalErrors: unknown[] = [];
    // A reused source is known not to be ours; it must never enter cleanup.
    if (candidateId === options.source.sessionId) candidateId = undefined;
    if (forkId && runtime && !signal.aborted) {
      try {
        // Reuse the live owner: a failed receipt write may also prevent a new
        // runtime from writing its private configuration.
        await runtime.manageFork(forkId, 'remove');
        forkId = undefined;
        candidateId = undefined;
      } catch (removeError) {
        liveRemovalErrors.push(removeError);
        // Close this owner before retrying with the bounded cleanup owner below.
      }
    }
    try {
      await runtime?.close();
    } catch (closeError) {
      cleanupErrors.push(closeError);
    }
    try {
      // The native response can precede cancellable metadata verification.
      // Restrict the new owner to that candidate, then verify before deletion.
      if (candidateId) {
        await removeOpenCodeSessionForkWithVerification(
          {
            ...options,
            signal: AbortSignal.timeout(30000),
            profileDir: options.destination.profileDir,
            cwd: destinationCwd,
          },
          { ...forkScope, forkSessionId: candidateId },
        );
        candidateId = undefined;
      }
    } catch (removeError) {
      cleanupErrors.push(...liveRemovalErrors, removeError);
    }
    const recovery =
      candidateId || creationOutcomeUnknown
        ? {
            version: 1,
            ...forkScope,
            candidateSessionId: candidateId,
            ownershipVerified: forkId !== undefined,
            ...(creationOutcomeUnknown ? { creationOutcome: 'unknown' } : {}),
            profileDir: options.destination.profileDir,
          }
        : undefined;
    try {
      if (recovery) {
        // This diagnostic is not a native-fork receipt and grants no authority.
        // Keep the private profile until ownership and deletion are established.
        await writeFile(
          join(options.destination.profileDir, 'native-fork-recovery.json'),
          JSON.stringify(recovery),
          { mode: 0o600, flag: 'wx' },
        );
      } else {
        await rm(options.destination.profileDir, {
          recursive: true,
          force: true,
        });
      }
    } catch (profileError) {
      cleanupErrors.push(profileError);
    }
    if (cleanupErrors.length || creationOutcomeUnknown)
      throw Object.assign(
        new Error('OpenCode fork failed and cleanup was incomplete.'),
        { cause: error, errors: [error, ...cleanupErrors], recovery },
      );
    throw error;
  } finally {
    signal.removeEventListener('abort', abortCreator);
    clearTimeout(cancellationTimer);
  }
}
