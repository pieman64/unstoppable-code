import type { W5RecordPortTransport } from '@canopy/core-runtime/node/w5/record-port';
import type { W5CommitLogHost } from '../../../w5-commit-log/commit-log-host';
import {
  __setDesktopW5FileStoreForTests,
  createW5CommitLogFileStore,
} from '../../w5-commit-log-file-store';
import {
  createW5DaemonRecordStore,
  installW5DaemonRecordStoreForTests,
  w5RecordPortTransport,
} from '../../w5-daemon-record-store';
import { startW5DaemonRecordHarness } from './w5-daemon-record-harness';

/*
 * W6g (CAN-5498, CAN-5506) keyed-boundary parity: one suite runs over desktop
 * main's in-process commit-log store and over the daemon-backed store, both
 * deciding through the same real commit-log host.
 */

export type W5StoreSide = 'in-process' | 'daemon';
export const W5_STORE_SIDES: readonly W5StoreSide[] = ['in-process', 'daemon'];

const W5_NAMESPACES = [
  'workspace_index',
  'workspace_manifest',
  'worktree_list',
];

/**
 * Installs desktop main's W5 store over `host` on `side`. The daemon side
 * serves the record port over `host`, with every W5 namespace daemon-owned
 * through the suite's ownership mock. Returns the teardown, which leaves the
 * store for the suite to reset.
 */
export async function installW5StoreSide(
  side: W5StoreSide,
  options: {
    readonly host: W5CommitLogHost;
    readonly root: string;
    readonly setDaemonOwned: (namespaceIds: readonly string[]) => void;
    /** Daemon side: wraps Electron's transport, as a lossy connection would. */
    readonly wrapTransport?: (
      transport: W5RecordPortTransport,
    ) => W5RecordPortTransport;
  },
): Promise<() => Promise<void>> {
  const { host, root, setDaemonOwned } = options;
  const wrap =
    options.wrapTransport ??
    ((transport: W5RecordPortTransport): W5RecordPortTransport => transport);
  if (side === 'in-process') {
    __setDesktopW5FileStoreForTests(createW5CommitLogFileStore(() => host));
    return () => Promise.resolve();
  }
  const harness = await startW5DaemonRecordHarness({ host });
  setDaemonOwned(W5_NAMESPACES);
  const restore = installW5DaemonRecordStoreForTests(
    createW5DaemonRecordStore({
      root,
      transport: wrap(w5RecordPortTransport(await harness.connect())),
    }),
  );
  return async (): Promise<void> => {
    restore();
    setDaemonOwned([]);
    await harness.close();
  };
}
