import { AsyncLocalStorage } from 'node:async_hooks';
import {
  CanopyOperationError,
  type CanopyInstructionOptions,
} from '@canopy/core-runtime';
import type {
  WorkerGitCommitParams,
  WorkerGitPushParams,
  WorkerGitOperationHandle,
} from '@canopy/protocol/canopy-core';
import {
  createWorkerGitCommitPushHandlers,
  type GitCommitPushPort,
  type WorkerGitCommitPushHandlers,
  type WorkerGitCommitPushHost,
} from '@canopy/core-runtime/node/git';
import {
  commitWithMessage,
  stageAllChanges,
  getCurrentBranch,
  getHeadCommitSha,
  resolveRefSha,
} from '../lib/git';
import { pushBranchWithAuthFailure } from '../lib/github-push';
import { desktopWorkerGitBranchWriteHost } from './worker-git-adapter';
import { LOCAL_DESKTOP_AUTHORITY_ID } from './desktop-runtime-identity';

export interface WorkerGitCommitPushDispatcher {
  instruction(
    name: 'worker.git.commit',
    params: WorkerGitCommitParams,
    options: CanopyInstructionOptions,
  ): Promise<WorkerGitOperationHandle>;
  instruction(
    name: 'worker.git.push',
    params: WorkerGitPushParams,
    options: CanopyInstructionOptions,
  ): Promise<WorkerGitOperationHandle>;
}

/** Host-local phase wrappers preserve IPC progress, cancellation and telemetry. */
export interface GitCommitPhases {
  stage(run: () => Promise<void>): Promise<void>;
  commit(run: () => Promise<string>): Promise<string>;
}
interface CommitCapture {
  readonly phases?: GitCommitPhases;
  hash?: string;
}
const capture = new AsyncLocalStorage<CommitCapture>();

export async function desktopTrackingHead(
  repoPath: string,
  branch: string,
): Promise<string | null> {
  return resolveRefSha(repoPath, `refs/remotes/origin/${branch}`).catch(
    () => null,
  );
}

export function desktopGitCommitPushPort(repoPath: string): GitCommitPushPort {
  return {
    currentBranch: () => getCurrentBranch(repoPath),
    head: () => getHeadCommitSha(repoPath),
    trackingHead: (branch) => desktopTrackingHead(repoPath, branch),
    stageAll: async () => {
      const run = (): Promise<void> => stageAllChanges(repoPath);
      const phases = capture.getStore()?.phases;
      await (phases ? phases.stage(run) : run());
    },
    commit: async (message) => {
      const run = (): Promise<string> => commitWithMessage(repoPath, message);
      const current = capture.getStore();
      try {
        const hash = await (current?.phases
          ? current.phases.commit(run)
          : run());
        if (current) current.hash = hash;
        return hash;
      } catch (error) {
        if (error instanceof Error && /nothing to commit/i.test(error.message))
          throw new CanopyOperationError(
            {
              kind: 'failed_precondition',
              code: 'worker.git.commit.nothingToCommit',
              message: 'There are no changes to commit.',
              retry: { kind: 'never' },
            },
            error,
          );
        throw error;
      }
    },
    push: async () => {
      try {
        await pushBranchWithAuthFailure(repoPath);
      } catch (error) {
        throw new CanopyOperationError(
          {
            kind: 'failed_precondition',
            code: 'worker.git.push.rejected',
            message: 'The remote rejected the push; the commits are kept.',
            retry: { kind: 'never' },
          },
          error,
        );
      }
    },
  };
}

export const desktopWorkerGitCommitPushHost: WorkerGitCommitPushHost<string> = {
  authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
  resolveCheckout: (scope, context) =>
    desktopWorkerGitBranchWriteHost.resolveCheckout(scope, context),
  port: (repoPath) => desktopGitCommitPushPort(repoPath),
};

export function createWorkerGitCommitPushAdapter(
  host: WorkerGitCommitPushHost<string> = desktopWorkerGitCommitPushHost,
): WorkerGitCommitPushHandlers {
  return createWorkerGitCommitPushHandlers(host);
}

/** The wire handle deliberately contains no legacy commit hash. */
export async function commitForLegacyIpc(
  dispatcher: WorkerGitCommitPushDispatcher,
  params: WorkerGitCommitParams,
  options: CanopyInstructionOptions,
  phases?: GitCommitPhases,
): Promise<string> {
  const current: CommitCapture = { phases };
  await capture.run(current, () =>
    dispatcher.instruction('worker.git.commit', params, options),
  );
  if (current.hash === undefined)
    throw new Error('The commit was not captured in this context.');
  return current.hash;
}
