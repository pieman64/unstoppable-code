import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  WorkerGitMergeParams,
  WorkerGitMergeResult,
} from '@canopy/protocol/canopy-core';
import type { CanopyInstructionOptions } from '@canopy/core-runtime';
import {
  createWorkerGitMergeHandlers,
  type WorkerGitMergeHost,
  type WorkerGitMergeHandlers,
} from '@canopy/core-runtime/node/git';
import { gitMergeWritePort } from '../lib/git';
import { desktopWorkerGitBranchWriteHost } from './worker-git-adapter';
import { LOCAL_DESKTOP_AUTHORITY_ID } from './desktop-runtime-identity';

export interface WorkerGitMergeDispatcher {
  instruction(
    name: 'worker.git.merge',
    params: WorkerGitMergeParams,
    options: CanopyInstructionOptions,
  ): Promise<WorkerGitMergeResult>;
}
interface MergeCapture {
  failure?: { readonly error: unknown };
}
const capture = new AsyncLocalStorage<MergeCapture>();
export const desktopWorkerGitMergeHost: WorkerGitMergeHost<string> = {
  authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
  resolveCheckout: (scope, context) =>
    desktopWorkerGitBranchWriteHost.resolveCheckout(scope, context),
  port: (path) =>
    gitMergeWritePort(path, (error) => {
      const store = capture.getStore();
      if (store) store.failure = { error };
    }),
};
export function createWorkerGitMergeAdapter(
  host: WorkerGitMergeHost<string> = desktopWorkerGitMergeHost,
): WorkerGitMergeHandlers {
  return createWorkerGitMergeHandlers(host);
}
export async function mergeForLegacyIpc(
  dispatcher: WorkerGitMergeDispatcher,
  params: WorkerGitMergeParams,
  options: CanopyInstructionOptions,
): Promise<string> {
  const store: MergeCapture = {};
  const result = await capture.run(store, () =>
    dispatcher.instruction('worker.git.merge', params, options),
  );
  if (result.outcome === 'merged') return result.mergeCommitHash;
  if (!store.failure)
    throw new Error('The merge conflict was not captured in this context.');
  throw store.failure.error;
}
