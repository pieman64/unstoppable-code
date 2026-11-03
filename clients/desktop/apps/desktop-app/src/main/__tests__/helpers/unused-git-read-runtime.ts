import type { DesktopCanopyDispatcher } from '../../canopy-runtime/desktop-runtime';
import type {
  WorkerGitDispatcher,
  WorkerGitWriteDispatcher,
} from '../../canopy-runtime/worker-git-adapter';
import type { DesktopIpcCallerResolver } from '../../ipc/file-tree';
import { createWorkspaceLifecycleTestDispatcher } from '../fixtures/workspace-lifecycle-dispatcher';
import { TEST_IPC_CALLER } from '../fixtures/workspace-metadata-dispatcher';

/**
 * The runtime the worktree and Home IPC registrations take, for suites that
 * never call their `worker.git.*` channels. It serves both the worktree
 * metadata projections (W7b-1b) and the archive projections (W7b-2a) over
 * their registered commands, as main does.
 */
export function unusedGitReadRuntime(): {
  dispatcher: WorkerGitDispatcher &
    WorkerGitWriteDispatcher &
    Pick<DesktopCanopyDispatcher, 'instruction'>;
  resolveCaller: DesktopIpcCallerResolver;
} {
  const lifecycle = createWorkspaceLifecycleTestDispatcher();
  const instruction: DesktopCanopyDispatcher['instruction'] = (
    name,
    params,
    options,
  ) =>
    name.startsWith('worker.git.')
      ? Promise.reject(new Error('worker.git is not wired in this suite'))
      : lifecycle.instruction(name, params, options);
  return {
    dispatcher: {
      query: async () =>
        Promise.reject(new Error('worker.git is not wired in this suite')),
      instruction,
    },
    resolveCaller: () => TEST_IPC_CALLER,
  };
}
