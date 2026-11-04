import {
  HookInvocationStore,
  type HookInvocationRef,
  type PersistedHookInvocation,
} from '@canopy/core-runtime/node/initiated-work';
import type {
  HookDescriptor,
  HookRunResponse,
} from '@canopy/desktop-shared/types';
import { writeFileAtomically } from './atomic-file';
import { logMainProcessWarn } from './main-process-logging';
import { getHookInvocationsDir } from './paths';

/*
 * The desktop's `hook_invocations` store: the initiated-work engine's hook
 * run ledger (`@canopy/core-runtime/node/initiated-work`, CAN-4144) over the
 * worktree data directory and the desktop's atomic writer.
 */

export { MAX_RETAINED_HOOK_RUNS_PER_HOOK } from '@canopy/core-runtime/node/initiated-work';

export type PersistedHookRunFile = PersistedHookInvocation<HookDescriptor>;
export type HookRunLogRef = HookInvocationRef<HookDescriptor>;

const store = new HookInvocationStore<HookDescriptor>({
  invocationsDir: getHookInvocationsDir,
  files: {
    writeFileAtomically: (path, text): Promise<void> =>
      writeFileAtomically(path, text, { encoding: 'utf8' }),
  },
  warn: (message, details): void => logMainProcessWarn(message, details),
});

export function startHookRunLog(args: {
  projectId: string;
  worktreeId: string;
  hook: HookDescriptor;
  invocation: 'automatic' | 'manual';
  /** The `core.initiatedWork.run` operation this run belongs to. */
  operationId?: string;
}): Promise<HookRunLogRef> {
  return store.start(args);
}

export function appendHookRunLogLines(args: {
  ref: HookRunLogRef;
  lines: string[];
  activeActionIndex?: number;
}): Promise<void> {
  return store.appendLines(args);
}

export function completeHookRunLog(args: {
  ref: HookRunLogRef;
  response: HookRunResponse;
  /** Set when the run's command gate stopped it on purpose. */
  stoppedBy?: 'commandGate';
}): Promise<void> {
  return store.complete(args);
}

export function readHookRunLogTail(args: {
  projectId: string;
  worktreeId: string;
  runId: string;
  maxLines: number;
}): Promise<{ meta: PersistedHookRunFile | null; lines: string[] }> {
  return store.readTail(args);
}

export function listHookRunLogTails(args: {
  projectId: string;
  worktreeId: string;
  maxLines: number;
}): Promise<Array<{ meta: PersistedHookRunFile; lines: string[] }>> {
  return store.listTails(args);
}

export function listLatestHookRunLogTails(args: {
  projectId: string;
  worktreeId: string;
  maxLines: number;
}): Promise<Array<{ meta: PersistedHookRunFile; lines: string[] }>> {
  return store.listLatestTails(args);
}

/** The hook run started under an operation, as persisted. */
export function findHookRunForOperation(args: {
  projectId: string;
  worktreeId: string;
  operationId: string;
}): Promise<PersistedHookRunFile | null> {
  return store.findByOperation(args);
}

export function deleteHookRunLogsForWorktree(
  projectId: string,
  worktreeId: string,
): Promise<void> {
  return store.deleteForWorktree(projectId, worktreeId);
}
