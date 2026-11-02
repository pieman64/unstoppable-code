import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  PlatformOperatingSystem,
  PlatformPermissionRequest,
  PlatformPermissionResult,
  PlatformSecureFileServices,
} from '../../../../platform/platform-services';
import {
  openVaultStore,
  type VaultStore,
  type VaultStoreFaults,
  type VaultStoreOpenResult,
} from '../store';
import type { VaultIntentDraft } from '../store-records';

export const STORE_VAULT_ID = 'v0store1';

export interface RecordingSecureFiles extends PlatformSecureFileServices {
  readonly requests: PlatformPermissionRequest[];
  readonly synced: string[];
}

/** Reports every path private unless `refuse` names it; never changes modes. */
export function recordingSecureFiles(
  refuse: (request: PlatformPermissionRequest) => boolean = () => false,
): RecordingSecureFiles {
  const requests: PlatformPermissionRequest[] = [];
  const synced: string[] = [];
  return {
    permissionModel: 'posix-mode',
    requests,
    synced,
    permissions: (request): Promise<PlatformPermissionResult> => {
      requests.push(request);
      return Promise.resolve(
        refuse(request)
          ? { state: 'insecure', reason: 'test refusal' }
          : { state: 'private' },
      );
    },
    rename: () => Promise.reject(new Error('unused')),
    syncDirectory: (path): Promise<'flushed'> => {
      synced.push(path);
      return Promise.resolve('flushed');
    },
  };
}

export interface StoreFolder {
  readonly root: string;
  readonly folder: string;
  readonly secureFiles: RecordingSecureFiles;
  open(options?: {
    readonly os?: PlatformOperatingSystem;
    readonly faults?: VaultStoreFaults;
    readonly openBusyTimeoutMs?: number;
    readonly folder?: string;
  }): Promise<VaultStoreOpenResult>;
  /** Opens and fails the test unless the store opened. */
  opened(faults?: VaultStoreFaults): Promise<VaultStore>;
  remove(): void;
}

export function storeFolder(secureFiles = recordingSecureFiles()): StoreFolder {
  const root = mkdtempSync(join(tmpdir(), 'vault-store-'));
  const folder = join(root, 'vault');
  const open: StoreFolder['open'] = (options = {}) =>
    openVaultStore({
      folder: options.folder ?? folder,
      platform: { os: options.os ?? 'darwin', secureFiles },
      openBusyTimeoutMs: options.openBusyTimeoutMs ?? 0,
      clock: () => new Date('2026-10-29T12:00:00.000Z'),
      faults: options.faults,
    });
  return {
    root,
    folder,
    secureFiles,
    open,
    async opened(faults): Promise<VaultStore> {
      const result = await open({ faults });
      if (result.kind !== 'opened')
        throw new Error(`Store did not open: ${result.step}`);
      return result.store;
    },
    remove: () => rmSync(root, { recursive: true, force: true }),
  };
}

export function sealedBox(fill: number): {
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  tag: Uint8Array;
} {
  return {
    nonce: new Uint8Array(12).fill(fill),
    ciphertext: new Uint8Array(48).fill(fill),
    tag: new Uint8Array(16).fill(fill),
  };
}

export function writeTestHeader(store: VaultStore): void {
  const written = store.writeHeader({
    vaultId: STORE_VAULT_ID,
    wrappedDataKey: sealedBox(1),
  });
  if (written.kind !== 'written') throw new Error('Header was not written.');
}

export function putIntent(
  idempotencyKey: string,
  entryId = `entry-${idempotencyKey}`,
): VaultIntentDraft {
  return {
    kind: 'put',
    family: 'test.family',
    idempotencyKey,
    entryId,
    expectedRevision: null,
    receipt: new Uint8Array(32).fill(7),
  };
}

export function intentKeys(store: VaultStore): string[] {
  return store.listIntents().map((intent) => intent.idempotencyKey);
}

const STORE_CHILD_SPAWN_TIMEOUT_MS = 60_000;

/**
 * The jest timeout for a test that runs `spawns` store children. A `tsx`
 * child takes over a second to start under load, past jest's 5 s default.
 */
export function storeChildTestTimeout(spawns: number): number {
  return spawns * STORE_CHILD_SPAWN_TIMEOUT_MS + 10_000;
}

/**
 * Opens the store in `store-child.fixture.ts` and returns what it printed.
 * `fileSizeBlocks` caps the child's files with `ulimit -f` (POSIX only).
 */
export function runStoreChild(
  folder: string,
  options: {
    readonly mode?: 'commit-large';
    readonly fileSizeBlocks?: number;
  } = {},
): unknown {
  const [node, ...args] = [
    process.execPath,
    '--disable-warning=ExperimentalWarning',
    '--import',
    'tsx',
    // Resolved here: the child loads this module as ESM, without __dirname.
    join(__dirname, 'store-child.fixture.ts'),
    folder,
    ...(options.mode ? [options.mode] : []),
  ];
  const spawnOptions = {
    encoding: 'utf8',
    timeout: STORE_CHILD_SPAWN_TIMEOUT_MS,
  } as const;
  const result =
    options.fileSizeBlocks === undefined
      ? spawnSync(node, args, spawnOptions)
      : spawnSync(
          '/bin/sh',
          [
            '-c',
            `ulimit -f ${String(options.fileSizeBlocks)} && exec "$0" "$@"`,
            node,
            ...args,
          ],
          spawnOptions,
        );
  if (result.status !== 0 || result.stderr !== '')
    throw new Error(
      `The store child failed (${String(result.status)}): ${result.stderr}`,
    );
  return JSON.parse(result.stdout);
}
