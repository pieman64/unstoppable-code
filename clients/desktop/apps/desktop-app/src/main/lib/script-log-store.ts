import type {
  PersistedScriptRunFile,
  ScriptRunCompletion,
  ScriptRunInvocation,
  ScriptRunLogRef,
  ScriptRunLogSnapshotResult,
} from '@canopy/core-runtime/node/script/execution';
import type { ScriptDescriptor } from '@canopy/desktop-shared/types';
import { desktopScriptWorker } from './script-runner';

/*
 * The worker's durable script run log (CAN-4143), owned by
 * `@canopy/core-runtime/node/script/execution`. Runs started through
 * `lib/script-execution`, interactive ones included, write it on the worker;
 * these entry points remain for the pipeline's setup-log snapshot, the
 * worktree's data cleanup and the caller suites' test double.
 */

export type {
  PersistedScriptRunFile,
  ScriptRunLogRef,
  ScriptRunLogSnapshotResult,
};

export function startScriptRunLog(args: {
  projectId: string;
  worktreeId: string;
  script: ScriptDescriptor;
  invocation: ScriptRunInvocation;
  runId?: string;
}): Promise<ScriptRunLogRef> {
  return desktopScriptWorker.logs.start(args);
}

export function appendScriptRunLogLines(args: {
  ref: ScriptRunLogRef;
  lines: string[];
}): Promise<void> {
  return desktopScriptWorker.logs.append(args);
}

export function completeScriptRunLog(args: {
  ref: ScriptRunLogRef;
  response: ScriptRunCompletion;
}): Promise<void> {
  return desktopScriptWorker.logs.complete(args);
}

export function readScriptRunLogTail(args: {
  projectId: string;
  worktreeId: string;
  scriptKey: string;
  maxLines: number;
}): Promise<{ meta: PersistedScriptRunFile | null; lines: string[] }> {
  return desktopScriptWorker.logs.readTail(args);
}

export function listScriptRunLogTails(args: {
  projectId: string;
  worktreeId: string;
  maxLines: number;
}): Promise<Array<{ meta: PersistedScriptRunFile; lines: string[] }>> {
  return desktopScriptWorker.logs.listTails(args);
}

export function deleteScriptRunLogsForWorktree(
  projectId: string,
  worktreeId: string,
): Promise<void> {
  return desktopScriptWorker.logs.deleteWorktree(projectId, worktreeId);
}

export function snapshotScriptRunLog(args: {
  ref: ScriptRunLogRef;
  targetPath: string;
}): Promise<ScriptRunLogSnapshotResult> {
  return desktopScriptWorker.logs.snapshot(args);
}

export function readScriptRunMeta(
  ref: Pick<ScriptRunLogRef, 'projectId' | 'worktreeId'> & {
    scriptKey: string;
  },
): Promise<PersistedScriptRunFile | null> {
  return desktopScriptWorker.logs.readMetaFor(ref);
}
