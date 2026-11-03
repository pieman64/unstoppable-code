import {
  createCoreSourceCompositionHandlers,
  type CoreSourceCompositionHandlers,
  type CoreSourceCompositionHost,
} from '@canopy/core-runtime/node/workspace/source-composition-commands';
import type { WorkerGitWriteDispatcher } from './worker-git-adapter';

/** The dispatcher a wire call's own worker effects run on, once it exists. */
export type LifecycleEffectDispatcher = () => WorkerGitWriteDispatcher;

// Loaded on the first lifecycle command, because the host modules import back
// into the runtime.
let loadingHost:
  | Promise<
      (dispatcher: LifecycleEffectDispatcher) => CoreSourceCompositionHost
    >
  | undefined;
function loadHost(): Promise<
  (dispatcher: LifecycleEffectDispatcher) => CoreSourceCompositionHost
> {
  loadingHost ??= import('../lib/source-composition-host').then(
    (module) => module.createDesktopSourceCompositionHost,
  );
  return loadingHost;
}

function lazyHost(
  dispatcher: LifecycleEffectDispatcher,
): CoreSourceCompositionHost {
  const host = async (): Promise<CoreSourceCompositionHost> =>
    (await loadHost())(dispatcher);
  return {
    initializeSourceRepo: async (input, call) =>
      (await host()).initializeSourceRepo(input, call),
    convertType: async (input, call) => (await host()).convertType(input, call),
    applySourceChanges: async (input, call) =>
      (await host()).applySourceChanges(input, call),
    promote: async (input, call) => (await host()).promote(input, call),
    renameBranch: async (input, call) =>
      (await host()).renameBranch(input, call),
    fork: async (input, call) => (await host()).fork(input, call),
  };
}

/**
 * The keyed source, composition, rename and fork lifecycles (W7b-4) over the
 * desktop's Electron boundaries, reached only through the dispatcher's grant
 * check. `dispatcher` runs a wire call's Git effect (`worker.git.*`).
 */
export function createCoreSourceCompositionAdapter(
  host: CoreSourceCompositionHost | undefined,
  dispatcher: LifecycleEffectDispatcher,
): { instructions: CoreSourceCompositionHandlers } {
  return {
    instructions: createCoreSourceCompositionHandlers(
      host ?? lazyHost(dispatcher),
    ),
  };
}
