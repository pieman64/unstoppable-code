import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { W5CommitRefusedError } from '@canopy/desktop-shared/node/w5-commit-log/errors';
import { syncDirectory } from '@canopy/desktop-shared/node/lib/atomic-file';
import { writeFileAtomically } from './atomic-file';
import {
  getW5DestructiveLifecycleDir,
  getWorkspaceDir,
  getWorkspaceWorktreeDir,
  getWorktreeDataDir,
} from './paths';
import { logMainProcessWarn } from './main-process-logging';
import { createSerialQueue } from './w5-file-store';

export const destructiveArchiveOutcomeSchema = z.object({
  success: z.boolean(),
  warnings: z.array(z.string()),
  removedTemporaryWorkspaceId: z.string().optional(),
  removedTemporaryWorkspaceName: z.string().optional(),
});

const journalSchema = z.object({
  version: z.literal(1),
  operationId: z.string().uuid(),
  operation: z.enum([
    'workspace-delete',
    'worktree-archive',
    'worktree-delete',
  ]),
  workspaceId: z.string(),
  worktreeId: z.string().optional(),
  createdAt: z.string().optional(),
  directoryIdentity: z.string().nullable(),
  state: z.enum(['active', 'recovery-required', 'completed']),
  steps: z.array(
    z.object({
      phase: z.string(),
      state: z.enum(['pending', 'done', 'failed']),
    }),
  ),
  outcome: z.unknown().optional(),
  cleanupRequired: z.boolean().optional(),
  ownedPaths: z
    .array(z.object({ path: z.string(), identity: z.string().nullable() }))
    .default([]),
});
export type DestructiveRecoveryRecord = z.infer<typeof journalSchema>;
interface Lifecycle {
  record: DestructiveRecoveryRecord;
  checkIdentity: () => Promise<void>;
  queue: ReturnType<typeof createSerialQueue>;
  failed: boolean;
  canonicalRemoved: boolean;
  resumingArchiveCleanup: boolean;
  beforeEffects?: () => void;
  active: boolean;
  previous?: DestructiveRecoveryRecord;
  parent?: Lifecycle;
  parentStep?: DestructiveRecoveryRecord['steps'][number];
}
const context = new AsyncLocalStorage<Lifecycle>();
function current(): Lifecycle | undefined {
  const lifecycle = context.getStore();
  return lifecycle?.active ? lifecycle : undefined;
}

function journalDirectory(): string {
  return getW5DestructiveLifecycleDir();
}
function journalPath(workspaceId: string, worktreeId?: string): string {
  const key = createHash('sha256')
    .update(JSON.stringify([workspaceId, worktreeId ?? null]))
    .digest('hex');
  return join(journalDirectory(), `${key}.json`);
}
function missing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}
async function directoryIdentity(path: string): Promise<string | null> {
  try {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw recoveryRequired();
    return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}
function recoveryRequired(
  record?: DestructiveRecoveryRecord,
): W5CommitRefusedError {
  return new W5CommitRefusedError(
    'recovery-required',
    'An interrupted destructive operation needs manual recovery. Preserve remaining files and inspect the lifecycle journal.',
    record ? { operationId: record.operationId } : undefined,
  );
}

/** Outside the deleted workspace: namespace backups cannot recover erased payloads. */
async function save(record: DestructiveRecoveryRecord): Promise<void> {
  const created = await mkdir(journalDirectory(), {
    recursive: true,
    mode: 0o700,
  });
  if (created) {
    for (let directory = journalDirectory(); ; directory = dirname(directory)) {
      await syncDirectory(directory);
      if (directory === dirname(created)) break;
    }
  }
  await writeFileAtomically(
    journalPath(record.workspaceId, record.worktreeId),
    JSON.stringify(record),
    { durable: true, mode: 0o600 },
  );
}

export async function readDestructiveRecovery(
  workspaceId: string,
  worktreeId?: string,
): Promise<DestructiveRecoveryRecord | null> {
  try {
    const record = journalSchema.parse(
      JSON.parse(await readFile(journalPath(workspaceId, worktreeId), 'utf8')),
    );
    if (record.workspaceId !== workspaceId || record.worktreeId !== worktreeId)
      throw recoveryRequired();
    return record;
  } catch (error) {
    if (missing(error)) return null;
    // Unreadable evidence is never overwritten or treated as permission to retry.
    throw recoveryRequired();
  }
}

export async function findCompletedDestructiveArchive(
  workspaceId: string,
  worktreeId: string,
  createdAt?: string,
): Promise<DestructiveRecoveryRecord | null> {
  const latest = await readDestructiveRecovery(workspaceId, worktreeId);
  const matches = (record: DestructiveRecoveryRecord): boolean =>
    record.state === 'completed' &&
    record.workspaceId === workspaceId &&
    record.worktreeId === worktreeId &&
    (createdAt === undefined || record.createdAt === createdAt);
  if (latest && matches(latest)) return latest;
  let names: string[];
  try {
    names = await readdir(journalDirectory());
  } catch (error) {
    if (missing(error)) return null;
    throw recoveryRequired();
  }
  for (const name of names) {
    if (!/^([a-f0-9]{64}|[a-f0-9-]{36})\.json$/.test(name)) continue;
    let record: DestructiveRecoveryRecord;
    try {
      record = journalSchema.parse(
        JSON.parse(await readFile(join(journalDirectory(), name), 'utf8')),
      );
    } catch {
      throw recoveryRequired();
    }
    if (matches(record)) return record;
  }
  return null;
}

/** Explicit repair of an idempotent derived index only; pending attempts require inspection. */
export async function retryDeletedWorkspaceSearchCleanup(
  workspaceId: string,
  operationId: string,
  cleanup: () => Promise<void>,
): Promise<void> {
  const record = await readDestructiveRecovery(workspaceId);
  if (
    !record ||
    record.operation !== 'workspace-delete' ||
    record.operationId !== operationId ||
    record.state !== 'completed' ||
    record.steps.some((step) => step.state === 'pending') ||
    (await directoryIdentity(getWorkspaceDir(workspaceId))) !== null
  )
    throw recoveryRequired(record ?? undefined);
  const step: DestructiveRecoveryRecord['steps'][number] = {
    phase: 'chat-search-repair',
    state: 'pending',
  };
  record.steps.push(step);
  await save(record);
  // Leave pending on failure: a second repair must not bypass uncertain work.
  await cleanup();
  step.state = 'done';
  record.cleanupRequired = record.steps.some(
    (step) => step.state === 'failed' && step.phase !== 'chat-search-rows',
  );
  await save(record);
}

export async function assertNoDestructiveRecovery(
  workspaceId: string,
  worktreeId?: string,
  includeCleanup = false,
): Promise<void> {
  const records = await readWorkspaceDestructiveRecoveries(workspaceId);
  for (const record of records) {
    if (
      (worktreeId === undefined ||
        record.worktreeId === undefined ||
        record.worktreeId === worktreeId) &&
      (record.state !== 'completed' ||
        (includeCleanup && record.cleanupRequired)) &&
      record.operationId !== current()?.record.operationId
    )
      throw recoveryRequired(record);
  }
}

async function readWorkspaceDestructiveRecoveries(
  workspaceId: string,
): Promise<DestructiveRecoveryRecord[]> {
  let names: string[];
  try {
    names = await readdir(journalDirectory());
  } catch (error) {
    if (missing(error)) return [];
    throw recoveryRequired();
  }
  const records: DestructiveRecoveryRecord[] = [];
  for (const name of names) {
    if (!/^([a-f0-9]{64}|[a-f0-9-]{36})\.json$/.test(name)) continue;
    try {
      const record = journalSchema.parse(
        JSON.parse(await readFile(join(journalDirectory(), name), 'utf8')),
      );
      if (record.workspaceId === workspaceId) records.push(record);
    } catch {
      throw recoveryRequired();
    }
  }
  return records;
}

/** Conservative, non-throwing guard for retention and purge janitors. */
export async function hasUnresolvedDestructiveRecovery(
  workspaceId: string,
  worktreeId?: string,
): Promise<boolean> {
  try {
    const records = await readWorkspaceDestructiveRecoveries(workspaceId);
    return records.some(
      (record) =>
        (worktreeId === undefined ||
          record.worktreeId === undefined ||
          record.worktreeId === worktreeId) &&
        (record.state !== 'completed' || record.cleanupRequired === true),
    );
  } catch {
    return true;
  }
}

/**
 * Older domain journals are evidence for inspection, never a new operation's
 * authority.
 *
 * `admitMissingCheckoutCapture` is for archive/delete admission only
 * (CAN-3039): a capture staged before its checkout was deleted outside the app
 * never reached teardown. Archive degrades it to a Git-less container that
 * keeps it pinned, and delete releases it; neither resumes or adopts it. The
 * lifecycle records the checkout as absent, so a reappearing one is refused.
 * Janitors keep refusing, so they still protect that container's refs.
 */
export async function assertNoLegacyArchiveRecovery(
  workspaceId: string,
  worktreeId: string,
  options?: { admitMissingCheckoutCapture?: boolean },
): Promise<void> {
  if (await readDestructiveRecovery(workspaceId, worktreeId)) return;
  const { readArchivedGitStagedDescriptor } =
    await import('./archived-container-git');
  const { readArchivedContainerRecoveryEvidence } =
    await import('./archived-container-recovery');
  let legacyJournal = false;
  try {
    legacyJournal = await readArchivedContainerRecoveryEvidence(
      workspaceId,
      worktreeId,
    );
  } catch {
    await refuseInterruptedArchiveJournal(
      workspaceId,
      worktreeId,
      'legacy-journal-unreadable',
    );
  }
  const staged = await readArchivedGitStagedDescriptor(workspaceId, worktreeId);
  if (!staged && !legacyJournal) return;
  if (
    !legacyJournal &&
    staged &&
    options?.admitMissingCheckoutCapture === true &&
    staged.status === 'capturing' &&
    !staged.teardown &&
    (await directoryIdentity(
      getWorkspaceWorktreeDir(workspaceId, worktreeId),
    )) === null
  )
    return;
  await refuseInterruptedArchiveJournal(
    workspaceId,
    worktreeId,
    legacyJournal ? 'legacy-journal' : 'staged-git-capture',
  );
}

/** `check` names the failed condition, since every site shares one phase. */
export function refuseInterruptedArchiveJournal(
  workspaceId: string,
  worktreeId: string,
  check: string,
): Promise<void> {
  return Promise.reject(
    new W5CommitRefusedError(
      'recovery-required',
      'An interrupted archive needs manual recovery. Preserve its remaining checkout, retained payload and journals.',
      { workspaceId, worktreeId, phase: 'archive-journal', check },
    ),
  );
}

function isArchiveCleanupPhase(phase: string): boolean {
  return (
    phase.startsWith('sidecar:') ||
    [
      'live-state-teardown',
      'browser-retirement',
      'sidecar-cleanup',
      'compatibility-symlinks',
      'canonical-row-removal',
      'deferred-browser-retirement',
      'watcher-commit',
      'temporary-workspace-cleanup',
    ].includes(phase)
  );
}

/** Only a verified committed archive can re-enter its idempotent cleanup tail. */
async function assertArchiveCleanupRecovery(
  record: DestructiveRecoveryRecord,
  createdAt: string | undefined,
): Promise<void> {
  const completed = (phase: string): boolean =>
    record.steps.some((step) => step.phase === phase && step.state === 'done');
  if (
    record.operation !== 'worktree-archive' ||
    !record.worktreeId ||
    !createdAt ||
    record.createdAt !== createdAt ||
    !record.directoryIdentity ||
    ![
      'git-worktree-removal',
      'quarantine-directory-removal',
      'pipeline-cleanup',
      'retained-manifest-commit',
      'git-capture-completion',
    ].every(completed) ||
    record.steps.some(
      (step) => step.state !== 'done' && !isArchiveCleanupPhase(step.phase),
    ) ||
    (await directoryIdentity(getWorkspaceDir(record.workspaceId))) !==
      record.directoryIdentity ||
    (await directoryIdentity(
      getWorkspaceWorktreeDir(record.workspaceId, record.worktreeId),
    )) !== null
  )
    throw recoveryRequired(record);
  const metadata = getWorktreeDataDir(record.workspaceId, record.worktreeId);
  const actual = await directoryIdentity(metadata);
  const owned = record.ownedPaths.find((entry) => entry.path === metadata);
  if (actual !== null && actual !== owned?.identity)
    throw recoveryRequired(record);
}

/** Runs under the existing workspace/archive lock. */
export async function withDestructiveLifecycle<T>(
  input: {
    operation: DestructiveRecoveryRecord['operation'];
    workspaceId: string;
    worktreeId?: string;
    createdAt?: string;
    /** Internal needs-repair rollback may have intentionally removed the row. */
    allowMissingRow?: boolean;
    /** Internal: the caller verified the retained manifest for this incarnation. */
    resumeArchiveCleanup?: boolean;
    /** Authoritative row read; null after canonical removal, never a replacement. */
    readCreatedAt?: () => Promise<string | null>;
    beforeEffects?: () => void;
    projectOutcome?: (result: T) => unknown;
    replay?: (outcome: unknown) => T;
  },
  work: () => Promise<T>,
): Promise<T> {
  const previous = await readDestructiveRecovery(
    input.workspaceId,
    input.worktreeId,
  );
  const resumingArchiveCleanup =
    previous !== null &&
    previous.state !== 'completed' &&
    input.resumeArchiveCleanup === true;
  if (previous && previous.state !== 'completed') {
    if (!resumingArchiveCleanup) throw recoveryRequired(previous);
    await assertArchiveCleanupRecovery(previous, input.createdAt);
  }
  if (
    previous?.state === 'completed' &&
    input.replay &&
    (input.createdAt === undefined || previous.createdAt === input.createdAt)
  )
    return input.replay(previous.outcome);
  if (
    input.worktreeId &&
    !input.allowMissingRow &&
    (input.createdAt === undefined ||
      (input.readCreatedAt && (await input.readCreatedAt()) === null))
  )
    throw new W5CommitRefusedError(
      'recovery-required',
      'This checkout has no recorded identity. Preserve it for manual repair.',
      {
        workspaceId: input.workspaceId,
        worktreeId: input.worktreeId,
        phase: 'unrecorded-checkout',
      },
    );
  const identity =
    resumingArchiveCleanup && previous
      ? previous.directoryIdentity
      : await directoryIdentity(getWorkspaceDir(input.workspaceId));
  const lifecycle: Lifecycle = {
    record:
      resumingArchiveCleanup && previous
        ? previous
        : {
            version: 1,
            operationId: randomUUID(),
            operation: input.operation,
            workspaceId: input.workspaceId,
            worktreeId: input.worktreeId,
            createdAt: input.createdAt,
            directoryIdentity: identity,
            state: 'active',
            steps: [],
            ownedPaths: [],
          },
    queue: createSerialQueue(),
    failed: false,
    canonicalRemoved: false,
    resumingArchiveCleanup,
    beforeEffects: input.beforeEffects,
    active: true,
    previous: resumingArchiveCleanup ? undefined : (previous ?? undefined),
    parent: current(),
    checkIdentity: async () => {
      const actual = await directoryIdentity(
        getWorkspaceDir(input.workspaceId),
      );
      if (
        actual !== identity &&
        !(actual === null && lifecycle.canonicalRemoved)
      )
        throw recoveryRequired(lifecycle.record);
      if (input.readCreatedAt) {
        const actualCreatedAt = await input.readCreatedAt();
        if (
          actualCreatedAt !== (input.createdAt ?? null) &&
          !(input.allowMissingRow && actualCreatedAt === null) &&
          !(actualCreatedAt === null && lifecycle.canonicalRemoved)
        )
          throw recoveryRequired(lifecycle.record);
      }
      if (
        resumingArchiveCleanup &&
        input.worktreeId &&
        (await directoryIdentity(
          getWorkspaceWorktreeDir(input.workspaceId, input.worktreeId),
        )) !== null
      )
        throw recoveryRequired(lifecycle.record);
      for (const owned of lifecycle.record.ownedPaths) {
        const actual = await directoryIdentity(owned.path);
        if (actual !== owned.identity && actual !== null)
          throw recoveryRequired(lifecycle.record);
      }
    },
  };
  if (resumingArchiveCleanup && previous) {
    lifecycle.record.state = 'active';
    lifecycle.record.cleanupRequired = false;
    if (input.worktreeId) {
      const metadata = getWorktreeDataDir(input.workspaceId, input.worktreeId);
      if (!lifecycle.record.ownedPaths.some((entry) => entry.path === metadata))
        lifecycle.record.ownedPaths.push({ path: metadata, identity: null });
    }
    const row = await input.readCreatedAt?.();
    lifecycle.canonicalRemoved =
      row === null &&
      previous.steps.some((step) => step.phase === 'canonical-row-removal');
    await lifecycle.checkIdentity();
  }
  return context.run(lifecycle, async () => {
    try {
      if (resumingArchiveCleanup)
        await assertNoDestructiveRecovery(input.workspaceId, input.worktreeId);
      const result = await work();
      if (
        lifecycle.failed ||
        (resumingArchiveCleanup &&
          lifecycle.record.steps.some((step) => step.state === 'pending'))
      )
        throw recoveryRequired(lifecycle.record);
      if (lifecycle.record.steps.length) {
        lifecycle.record.state = 'completed';
        lifecycle.record.outcome = input.projectOutcome
          ? input.projectOutcome(result)
          : result;
        await save(lifecycle.record);
      }
      const parent = lifecycle.parent;
      if (parent && lifecycle.parentStep) {
        lifecycle.parentStep.state = 'done';
        await parent.queue(() => save(parent.record));
      }
      return result;
    } catch (error) {
      if (
        lifecycle.record.steps.length &&
        lifecycle.record.state !== 'completed'
      ) {
        lifecycle.record.state = 'recovery-required';
        await save(lifecycle.record).catch(() => undefined);
        report(lifecycle.record);
      }
      throw error;
    } finally {
      lifecycle.active = false;
    }
  });
}

/** Write intent before resolving an effect's target, and completion only after it returns. */
export async function destructiveStep<T>(
  phase: string,
  work: () => Promise<T>,
  canonicalRemovalOrOptions: boolean | { bestEffort?: boolean } = false,
): Promise<T> {
  const canonicalRemoval =
    typeof canonicalRemovalOrOptions === 'boolean'
      ? canonicalRemovalOrOptions
      : false;
  const bestEffort =
    typeof canonicalRemovalOrOptions === 'object' &&
    canonicalRemovalOrOptions.bestEffort === true;
  const lifecycle = current();
  if (!lifecycle) return work();
  if (lifecycle.resumingArchiveCleanup && !isArchiveCleanupPhase(phase))
    throw recoveryRequired(lifecycle.record);
  const existing = lifecycle.resumingArchiveCleanup
    ? lifecycle.record.steps.find((step) => step.phase === phase)
    : undefined;
  const step: DestructiveRecoveryRecord['steps'][number] = existing ?? {
    phase,
    state: 'pending',
  };
  await lifecycle
    .queue(async () => {
      if (lifecycle.failed) throw recoveryRequired(lifecycle.record);
      await lifecycle.checkIdentity();
      lifecycle.beforeEffects?.();
      const parent = lifecycle.parent;
      if (parent && !lifecycle.parentStep) {
        await parent.queue(async () => {
          await parent.checkIdentity();
          parent.beforeEffects?.();
          const step: DestructiveRecoveryRecord['steps'][number] = {
            phase: `child:${lifecycle.record.operationId}`,
            state: 'pending',
          };
          lifecycle.parentStep = step;
          parent.record.steps.push(step);
          await save(parent.record);
        });
      }
      if (lifecycle.previous) {
        // Keep B5's original outcome when a later incarnation reuses this id.
        await mkdir(journalDirectory(), { recursive: true, mode: 0o700 });
        await writeFileAtomically(
          join(journalDirectory(), `${lifecycle.previous.operationId}.json`),
          JSON.stringify(lifecycle.previous),
          { durable: true, mode: 0o600 },
        );
        lifecycle.previous = undefined;
      }
      step.state = 'pending';
      if (!existing) lifecycle.record.steps.push(step);
      await save(lifecycle.record);
    })
    .catch((error: unknown) => {
      // Failing to record intent is never tolerable, even for best-effort work.
      lifecycle.failed = true;
      throw error;
    });
  let result: T;
  try {
    result = await work();
  } catch (error) {
    if (bestEffort) {
      // The caller tolerates this rejection; record it without failing the
      // lifecycle, but an unrecordable failure still requires recovery.
      step.state = 'failed';
      await lifecycle
        .queue(() => save(lifecycle.record))
        .catch(() => {
          lifecycle.failed = true;
        });
    } else {
      lifecycle.failed = true;
    }
    throw error;
  }
  await lifecycle
    .queue(async () => {
      if (canonicalRemoval) lifecycle.canonicalRemoved = true;
      step.state = 'done';
      await save(lifecycle.record);
    })
    .catch((error: unknown) => {
      lifecycle.failed = true;
      throw error;
    });
  return result;
}

/** Evaluate typed arguments before the callback, preserving incarnation narrowing. */
export function destructiveCall<Args extends unknown[], Result>(
  phase: string,
  work: (...args: Args) => Promise<Result>,
  ...args: Args
): Promise<Result> {
  return destructiveStep(phase, () => work(...args));
}

/** A failed destructive step cannot enter legacy automatic removal fallbacks. */
export function hasDestructiveLifecycle(): boolean {
  return current() !== undefined;
}

/** Called in the journal writer's existing list lock, without acquiring another lock. */
export function assertDestructiveRowIdentity(createdAt: string): void {
  const lifecycle = current();
  if (lifecycle?.record.worktreeId && lifecycle.record.createdAt !== createdAt)
    throw recoveryRequired(lifecycle.record);
}

/** A typed capture refusal precedes checkout teardown; keep its evidence and the existing files-only path. */
export function acknowledgeArchiveCaptureRefusal(): void {
  const lifecycle = current();
  if (!lifecycle) return;
  const step = [...lifecycle.record.steps]
    .reverse()
    .find((step) => step.phase === 'git-capture' && step.state === 'pending');
  if (!step) throw recoveryRequired(lifecycle.record);
  step.state = 'failed';
  lifecycle.failed = false;
}

/** Capture before effects; absence never authorizes removing a later occupant. */
export async function protectDestructivePath(
  path: string,
  allowCreation = false,
): Promise<void> {
  const lifecycle = current();
  const identity = lifecycle ? await directoryIdentity(path) : null;
  if (lifecycle && !(identity === null && allowCreation))
    lifecycle.record.ownedPaths.push({
      path,
      identity,
    });
}

/** Cleanup failures after the owner commit keep their warnings and never earn a false done. */
export async function destructiveCleanup<T>(
  phase: string,
  work: () => Promise<T>,
): Promise<T> {
  const lifecycle = current();
  let workRejected = false;
  try {
    return await destructiveStep(
      phase,
      async () => {
        try {
          return await work();
        } catch (error) {
          workRejected = true;
          throw error;
        }
      },
      { bestEffort: true },
    );
  } catch (error) {
    // The best-effort step already leaves `failed` untouched for the work's
    // own rejection; a journal or concurrent step failure must stay fatal.
    if (lifecycle && workRejected) {
      lifecycle.record.cleanupRequired = true;
      const step = [...lifecycle.record.steps]
        .reverse()
        .find((step) => step.phase === phase && step.state === 'pending');
      if (step) step.state = 'failed';
    }
    throw error;
  }
}

export function markDestructiveCleanupRequired(): void {
  const lifecycle = current();
  if (lifecycle) lifecycle.record.cleanupRequired = true;
}

function report(record: DestructiveRecoveryRecord): void {
  logMainProcessWarn('W5 destructive lifecycle requires manual recovery', {
    operationId: record.operationId,
    operation: record.operation,
    workspaceId: record.workspaceId,
    worktreeId: record.worktreeId,
    createdAt: record.createdAt,
    state: record.state,
    steps: record.steps,
    journalPath: journalPath(record.workspaceId, record.worktreeId),
    reason:
      record.state === 'completed'
        ? 'subordinate-cleanup'
        : 'interrupted-destructive-effect',
  });
}

/** Read-only launch report, including deleted parents. No Git, cleanup or compensation. */
export async function reportDestructiveRecovery(): Promise<
  DestructiveRecoveryRecord[]
> {
  let names: string[];
  try {
    names = await readdir(journalDirectory());
  } catch (error) {
    if (missing(error)) return [];
    throw recoveryRequired();
  }
  const records: DestructiveRecoveryRecord[] = [];
  for (const name of names) {
    if (!/^([a-f0-9]{64}|[a-f0-9-]{36})\.json$/.test(name)) continue;
    let record: DestructiveRecoveryRecord;
    try {
      record = journalSchema.parse(
        JSON.parse(await readFile(join(journalDirectory(), name), 'utf8')),
      );
    } catch {
      throw recoveryRequired();
    }
    if (record.state !== 'completed' || record.cleanupRequired) {
      if (records.some((found) => found.operationId === record.operationId))
        continue;
      if (record.state === 'active') record.state = 'recovery-required';
      records.push(record);
      report(record);
    }
  }
  return records;
}
