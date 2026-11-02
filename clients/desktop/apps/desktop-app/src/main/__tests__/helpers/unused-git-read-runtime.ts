import type {
  WorkerGitDispatcher,
  WorkerGitWriteDispatcher,
} from '../../canopy-runtime/worker-git-adapter';
import type { DesktopIpcCallerResolver } from '../../ipc/file-tree';

/**
 * The runtime the worktree and Home IPC registrations take, for suites that
 * never call their `worker.git.*` channels.
 */
export function unusedGitReadRuntime(): {
  dispatcher: WorkerGitDispatcher & WorkerGitWriteDispatcher;
  resolveCaller: DesktopIpcCallerResolver;
} {
  return {
    dispatcher: {
      query: async () =>
        Promise.reject(new Error('worker.git is not wired in this suite')),
      instruction: async () =>
        Promise.reject(new Error('worker.git is not wired in this suite')),
    },
    resolveCaller: (): never => {
      throw new Error('worker.git is not wired in this suite');
    },
  };
}
