import { AsyncLocalStorage } from 'node:async_hooks';
import type { GitRequestSource } from '../types';

export interface GitRequestContext {
  source: GitRequestSource;
  requestId: string;
}

const gitRequestStorage = new AsyncLocalStorage<GitRequestContext>();

export function runWithGitRequestContext<T>(
  context: GitRequestContext,
  callback: () => T,
): T {
  return gitRequestStorage.run(context, callback);
}

export function getGitRequestContext(): GitRequestContext | undefined {
  return gitRequestStorage.getStore();
}

/**
 * Adds non-secret logical attribution to Git's child environment. Keeping this
 * at the process-launch boundary means app-main and desktop-shared helpers emit
 * the same source/request pair throughout one async stats computation.
 */
export function withGitRequestContextEnv(
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const context = getGitRequestContext();
  if (!context) return env;
  return {
    ...env,
    CANOPY_GIT_REQUEST_SOURCE: context.source,
    CANOPY_GIT_REQUEST_ID: context.requestId,
  };
}
