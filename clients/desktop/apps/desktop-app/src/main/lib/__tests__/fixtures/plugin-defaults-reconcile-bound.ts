// Stalls and restarts for the bounded inline plugin-defaults reconcile
// (CAN-4409 D1), shared by the suites of its inline callers.
import * as pluginDefaultsCache from '../../../plugins/project-plugin-defaults-cache';
import { getWorkspaceConfigPath } from '../../paths';
import { withW5Commit } from '../../w5-commit-log-file-store';
import { afterW5Commit } from '../../w5-commit-scope';
import { updateWorkspaceConfig } from '../../workspace-persistence';

/** Rejects if `pending` is still waiting after `ms`: an unbounded wait. */
export async function settlesWithin<T>(
  pending: Promise<T>,
  ms = 15_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`still waiting after ${String(ms)} ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A W5 commit of the workspace's manifest that leaves the plugin layer alone
 * and whose post-commit work does not finish until released.
 */
export async function stalledManifestCommit(workspaceId: string): Promise<{
  release: () => Promise<void>;
}> {
  let opened = (): void => {};
  const settling = new Promise<void>((resolve) => {
    opened = resolve;
  });
  let open = (): void => {};
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const commit = withW5Commit(
    {
      operation: 'test.manifest',
      locks: [{ kind: 'manifest', path: getWorkspaceConfigPath(workspaceId) }],
    },
    async () => {
      await updateWorkspaceConfig(workspaceId, (config): void => {
        config.recommendedPluginOptOutKeys = ['stalled'];
      });
      await afterW5Commit(async () => {
        opened();
        await gate;
      });
    },
  );
  await settling;
  return {
    release: async (): Promise<void> => {
      open();
      await commit;
    },
  };
}

/**
 * The next reconcile finds another commit of the manifest landing every time
 * it takes the write queue, so each pass starts over.
 */
export function commitsLandingOnEveryPass(): { passes: () => number } {
  let passes = 0;
  const reconcile = pluginDefaultsCache.reconcileProjectPluginDefaults;
  jest
    .spyOn(pluginDefaultsCache, 'reconcileProjectPluginDefaults')
    .mockImplementationOnce((write) => {
      let inQueue = false;
      return reconcile({
        ...write,
        serialize: (work) =>
          write.serialize(async () => {
            passes += 1;
            inQueue = true;
            try {
              await work();
            } finally {
              inQueue = false;
            }
          }),
        committing: () =>
          inQueue
            ? [new Promise<void>((resolve) => setImmediate(resolve))]
            : write.committing(),
      });
    });
  return { passes: () => passes };
}
