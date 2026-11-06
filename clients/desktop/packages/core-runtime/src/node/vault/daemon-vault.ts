import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { vaultError } from '@canopy/protocol/canopy-core';
import type {
  VaultEntryMetadata,
  VaultSecretRef,
  VaultStatusGetResult,
} from '@canopy/protocol/canopy-core';
import type { RuntimeService } from '../../kernel/service-container';
import type { PlatformServices } from '../../platform/platform-services';
import type {
  PlatformKeySlotBlocked,
  PlatformSecretProtectionServices,
} from '../../platform/secret-protection';
import {
  CanopyOperationError,
  canopyUnavailableError,
} from '../../runtime/errors';
import type { VaultRepository, VaultFamilyWriter } from '../../vault/contracts';
import { resolveDaemonVaultFolder } from './paths';
import { mapVaultKeySlotOutcome } from './repository/key-slot-outcome';
import {
  openVaultReadRepository,
  type VaultReadRepository,
} from './repository/read-repository';
import { openVaultStore, type VaultStore } from './repository/store';

/** Closed custody table; reserving Copilot does not move its legacy writer. */
const DAEMON_VAULT_FAMILIES = Object.freeze({
  'github-pat': { state: 'active', owner: 'CAN-4415', instructionWriter: null },
  'copilot-account': {
    state: 'reserved',
    owner: 'CAN-4513',
    instructionWriter: null,
  },
} as const);

export interface DaemonVault {
  /** Trusted composition lifetime; aborts synchronously at disposal. */
  readonly signal: AbortSignal;
  readonly service: RuntimeService;
  status(): VaultStatusGetResult;
  list(): Promise<readonly VaultEntryMetadata[]>;
  get(ref: VaultSecretRef): Promise<VaultEntryMetadata | null>;
  /** Trusted composition only; never exposed by core.vault. */
  writer(
    family: keyof typeof DAEMON_VAULT_FAMILIES,
  ): Promise<VaultFamilyWriter>;
  /** Trusted composition only; includes material and synchronous admission. */
  repository(): Promise<VaultRepository>;
  /** Trusted composition only; throttled, prompt-free probe when no key is held. */
  probeKeyIfDue(): Promise<void>;
  dispose(): Promise<void>;
}

export interface DaemonVaultOptions {
  readonly secureDataRoot: string;
  readonly platform: Pick<PlatformServices, 'os' | 'secureFiles'>;
  readonly slots: PlatformSecretProtectionServices | null;
}

export function createDaemonVault(options: DaemonVaultOptions): DaemonVault {
  const { slots } = options;
  const lifetime = new AbortController();
  let store: VaultStore | undefined;
  let vault: VaultReadRepository | undefined;
  let opening: Promise<VaultReadRepository> | undefined;
  let disposal: Promise<void> | undefined;
  const issuedWriters = new Set<string>();
  let last: VaultStatusGetResult = {
    protection: slots
      ? { state: 'unknown', backend: slots.backend }
      : { state: 'unavailable', backend: null, reason: 'no_backend' },
    observedAt: null,
  };

  function refused(): Error {
    return canopyUnavailableError();
  }

  async function open(): Promise<VaultReadRepository> {
    if (!slots || lifetime.signal.aborted) throw refused();
    let candidate: VaultStore | undefined;
    let reader: VaultReadRepository | undefined;
    let slotBlock: PlatformKeySlotBlocked | undefined;
    try {
      const folder = resolveDaemonVaultFolder(options.secureDataRoot);
      // Existing roots also hold Electron secrets; verify without changing their ACLs.
      let createdRoot = false;
      try {
        await mkdir(options.secureDataRoot, { mode: 0o700 });
        createdRoot = true;
      } catch (error) {
        if (
          !(
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code === 'EEXIST'
          )
        )
          throw error;
      }
      const permissions = await options.platform.secureFiles.permissions({
        path: options.secureDataRoot,
        kind: 'directory',
        mode: 'owner-only',
        action: createdRoot ? 'restrict' : 'verify',
      });
      if (permissions.state !== 'private') throw refused();
      lifetime.signal.throwIfAborted();
      await options.platform.secureFiles.syncDirectory(
        dirname(options.secureDataRoot),
      );
      lifetime.signal.throwIfAborted();
      const opened = await openVaultStore({
        folder,
        platform: options.platform,
      });
      if (opened.kind !== 'opened') throw refused();
      candidate = opened.store;
      lifetime.signal.throwIfAborted();
      const read = await openVaultReadRepository({
        store: candidate,
        slots,
        signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(5_000)]),
      });
      if (read.kind !== 'opened') {
        slotBlock = read.slotBlock;
        throw refused();
      }
      reader = read.vault;
      lifetime.signal.throwIfAborted();
      await reader.reconcile();
      lifetime.signal.throwIfAborted();
      store = candidate;
      vault = reader;
      last = reader.repository.status();
      return reader;
    } catch {
      reader?.dispose();
      candidate?.close();
      if (!lifetime.signal.aborted) {
        last = {
          protection: mapVaultKeySlotOutcome({
            backend: slots.backend,
            observation: slotBlock ?? { kind: 'rejected' },
            status: null,
          }).protection,
          observedAt: new Date().toISOString(),
        };
      }
      throw refused();
    }
  }

  function repository(): Promise<VaultReadRepository> {
    if (!slots || lifetime.signal.aborted) return Promise.reject(refused());
    if (vault) return Promise.resolve(vault);
    // Failed startup opens retry on entry access; status stays observation-only.
    if (!opening)
      opening = open().finally(() => {
        opening = undefined;
      });
    return opening;
  }

  function dispose(): Promise<void> {
    if (!disposal) {
      lifetime.abort();
      disposal = (async (): Promise<void> => {
        await opening?.catch(() => undefined);
        vault?.dispose();
        store?.close();
        vault = undefined;
        store = undefined;
      })();
    }
    return disposal;
  }

  async function list(): Promise<readonly VaultEntryMetadata[]> {
    const reader = await repository();
    lifetime.signal.throwIfAborted();
    return reader.repository.list();
  }

  return {
    signal: lifetime.signal,
    service: {
      name: 'daemon.vault',
      plane: 'core',
      start: async (): Promise<void> => {
        if (slots) await repository().catch(() => undefined);
      },
      stop: { 7: dispose },
    },
    status: () => vault?.repository.status() ?? last,
    list,
    get: async (ref): Promise<VaultEntryMetadata | null> => {
      const reader = await repository();
      lifetime.signal.throwIfAborted();
      if (ref.vaultId !== reader.vaultId)
        throw new CanopyOperationError(
          vaultError('core.vault.entry.notFound', {
            ref,
            reason: 'foreign_vault',
          }),
        );
      if (store?.readTombstone(ref.entryId))
        throw new CanopyOperationError(
          vaultError('core.vault.entry.notFound', {
            ref,
            reason: 'deleted',
          }),
        );
      return (
        (await reader.repository.list()).find(
          (entry) => entry.ref.entryId === ref.entryId,
        ) ?? null
      );
    },
    writer: async (family): Promise<VaultFamilyWriter> => {
      if (DAEMON_VAULT_FAMILIES[family]?.state !== 'active')
        throw new CanopyOperationError(
          vaultError('core.vault.entry.writerRefused', {
            reason: 'managed_family',
          }),
        );
      const reader = await repository();
      lifetime.signal.throwIfAborted();
      if (issuedWriters.has(family)) throw refused();
      const writer = reader.writer(family);
      issuedWriters.add(family);
      return writer;
    },
    repository: async (): Promise<VaultRepository> => {
      const reader = await repository();
      lifetime.signal.throwIfAborted();
      return reader.repository;
    },
    probeKeyIfDue: async (): Promise<void> => {
      const reader = await repository();
      lifetime.signal.throwIfAborted();
      await reader.probeKeyIfDue();
      lifetime.signal.throwIfAborted();
    },
    dispose,
  };
}
