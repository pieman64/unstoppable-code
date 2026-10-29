import { lstat, readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type {
  PlatformServices,
  DaemonStartupClaimPort,
} from '@canopy/core-runtime';
import { createCanopyStartupClaimPort } from '@canopy/core-transport/node';
import { CanopyRuntimeDescriptorSchema } from '@canopy/protocol/canopy-core';
import {
  restoreW5Backup,
  type W5BackupContext,
  type W5ExclusiveMaintenance,
} from './w5-backup';
import { isErrnoException } from './type-guards';
import type { W5Diagnosis } from './w5-maintenance-diagnosis';

export type W5MaintenanceRefusal =
  | 'invalid-request'
  | 'writer-active'
  | 'runtime-unavailable'
  | 'identity-unprovable'
  | 'claim-held'
  | 'claim-ambiguous'
  | 'endpoint-unavailable'
  | 'claim-lost'
  | 'release-uncertain'
  | 'writer-exit-unconfirmed'
  | 'recovery-required';

export class W5MaintenanceRefusedError extends Error {
  constructor(
    readonly reason: W5MaintenanceRefusal,
    readonly operationError?: unknown,
  ) {
    super(`W5 maintenance refused (${reason}).`);
    this.name = 'W5MaintenanceRefusedError';
  }
}

export type W5MaintenanceRequest = {
  readonly source: 'offline_maintenance';
} & (
  | { readonly mode: 'diagnose' }
  | {
      readonly mode: 'restore';
      readonly backupPath: string;
      readonly unreadableOverride?: string;
    }
);
export type W5MaintenanceResult =
  | { readonly mode: 'diagnose'; readonly diagnosis: W5Diagnosis }
  | { readonly mode: 'restore'; readonly commitId: number };

/** Trusted offline host composition only; no IPC/UI/CLI/startup callers. */
export interface W5MaintenanceContext extends W5BackupContext {
  readonly platform: Pick<
    PlatformServices,
    'supervision' | 'secureFiles' | 'endpoints'
  >;
}
interface HeldMaintenance {
  readonly dataRoot: string;
  readonly claims: DaemonStartupClaimPort;
  readonly handle: object;
  readonly verifyRuntime: () => Promise<void>;
}
const held = new WeakMap<W5ExclusiveMaintenance, HeldMaintenance>();

/** Validation only: callers cannot mint or retain admission after completion. */
export async function isW5MaintenanceHeld(
  exclusive: W5ExclusiveMaintenance,
  dataRoot: string,
): Promise<boolean> {
  const state = held.get(exclusive);
  if (!state || state.dataRoot !== resolve(dataRoot)) return false;
  try {
    await state.verifyRuntime();
    const identity = await state.claims.identity(state.handle);
    return (
      held.get(exclusive) === state && identity?.dataRoot === state.dataRoot
    );
  } catch {
    return false;
  }
}

function refuse(reason: W5MaintenanceRefusal): never {
  throw new W5MaintenanceRefusedError(reason);
}

/**
 * CAN-3797 preparation. Serializes with Phase 1 launch/publication, not legacy
 * Electron writers: CAN-3729 must gate both hosts before this is exposed.
 * Runtime must already exist and be private; maintenance never repairs it.
 */
export async function runW5Maintenance(
  context: W5MaintenanceContext,
  request: W5MaintenanceRequest,
  signal?: AbortSignal,
): Promise<W5MaintenanceResult> {
  if (
    request.source !== 'offline_maintenance' ||
    (request.mode !== 'diagnose' && request.mode !== 'restore')
  )
    refuse('invalid-request');
  signal?.throwIfAborted();
  if (context.host.workersStarted !== 0) refuse('writer-active');
  const { dataRoot, platform } = context;
  const runtime = join(dataRoot, 'runtime');
  async function privateDirectory(path: string): Promise<void> {
    if ((await realpath(path)) !== path || !(await lstat(path)).isDirectory())
      refuse('runtime-unavailable');
    const permission = await platform.secureFiles.permissions({
      path,
      kind: 'directory',
      mode: 'owner-only',
      action: 'verify',
    });
    if (permission.state !== 'private') refuse('runtime-unavailable');
  }
  let runtimeIdentity;
  try {
    if (resolve(dataRoot) !== dataRoot) refuse('runtime-unavailable');
    await privateDirectory(dataRoot);
    await privateDirectory(runtime);
    runtimeIdentity = await lstat(runtime);
  } catch {
    refuse('runtime-unavailable');
  }
  const { dev, ino } = runtimeIdentity;
  async function verifyRuntime(): Promise<void> {
    await privateDirectory(runtime);
    const current = await lstat(runtime);
    if (current.dev !== dev || current.ino !== ino)
      refuse('runtime-unavailable');
  }
  const self = await platform.supervision.inspectProcess({
    pid: process.pid,
    signal,
  });
  if (self.state !== 'running') refuse('identity-unprovable');
  const claims = createCanopyStartupClaimPort({
    dataRoot,
    owner: { pid: process.pid, startIdentity: self.startIdentity },
    inspectProcess: async (pid, inspectionSignal) => {
      const found = await platform.supervision.inspectProcess({
        pid,
        signal: inspectionSignal,
      });
      if (found.state === 'running')
        return { kind: 'alive', startIdentity: found.startIdentity };
      return { kind: found.state === 'absent' ? 'dead' : 'unknown' };
    },
  });
  // Structural compatibility with the same Phase 1 runtime contract.
  const claimPort: DaemonStartupClaimPort = claims;
  const acquisition = await claimPort.tryAcquire(signal, {
    recoverDeparted: true,
  });
  if (acquisition.kind !== 'acquired')
    refuse(acquisition.kind === 'held' ? 'claim-held' : 'claim-ambiguous');
  const { handle } = acquisition;
  // Until an absent endpoint is proven, keep any inherited bind evidence.
  let preserveEndpointBind = acquisition.recovered?.endpointBound === true;
  let operationError: unknown;
  const exclusive: W5ExclusiveMaintenance = Object.freeze({
    kind: 'w5-exclusive-maintenance',
  });
  async function releaseClaim(): Promise<void> {
    const result = await claims.release(handle, { preserveEndpointBind });
    if (result !== 'released')
      throw new W5MaintenanceRefusedError('release-uncertain', operationError);
  }
  async function finishMaintenance(): Promise<void> {
    held.delete(exclusive);
    // Preserve departed bind evidence when a refused/uncertain endpoint remains.
    try {
      if (context.host.workersStarted > 0) {
        await context.host.shutdown();
        // Shutdown waits a bounded time for workers to exit. A worker still
        // alive could keep writing, so the claim must stay held.
        if (context.host.runningWorkerCount > 0)
          throw new W5MaintenanceRefusedError(
            'writer-exit-unconfirmed',
            operationError,
          );
      }
    } catch (error) {
      if (operationError !== undefined) {
        operationError = Object.assign(
          new Error('W5 maintenance and writer shutdown failed.'),
          { errors: [operationError, error] },
        );
        throw operationError;
      }
      operationError = error;
      throw error;
    } finally {
      // An unconfirmed worker exit keeps the claim; the contract's departed-
      // holder recovery frees it once this process has exited.
      if (context.host.runningWorkerCount === 0) await releaseClaim();
    }
  }
  try {
    signal?.throwIfAborted();
    await verifyRuntime();
    // A published daemon no longer holds the startup claim. Probe its lifetime
    // lock even when discovery is missing, and never unlink runtime artifacts.
    const endpoints = platform.endpoints;
    const address = endpoints.address({ dataRoot, endpointName: 'core' });
    const probe =
      endpoints.semantics === 'filesystem-socket'
        ? await endpoints.probe(
            endpoints.address({ dataRoot, endpointName: 'core' }),
          )
        : await endpoints.probe(
            endpoints.address({ dataRoot, endpointName: 'core' }),
          );
    if (probe.state !== 'absent') {
      preserveEndpointBind = acquisition.recovered?.endpointBound === true;
      refuse('endpoint-unavailable');
    }
    preserveEndpointBind = false;
    let descriptorBytes: Buffer | undefined;
    const descriptorPath = join(runtime, 'core.json');
    try {
      const stat = await lstat(descriptorPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024)
        refuse('endpoint-unavailable');
      const permissions = await platform.secureFiles.permissions({
        path: descriptorPath,
        kind: 'file',
        mode: 'owner-only',
        action: 'verify',
      });
      if (permissions.state !== 'private') refuse('endpoint-unavailable');
      descriptorBytes = await readFile(descriptorPath);
    } catch (error) {
      if (!isErrnoException(error) || error.code !== 'ENOENT') throw error;
    }
    if (descriptorBytes) {
      let raw: unknown;
      try {
        raw = JSON.parse(descriptorBytes.toString('utf8'));
      } catch {
        refuse('endpoint-unavailable');
      }
      const descriptor = CanopyRuntimeDescriptorSchema.safeParse(raw);
      if (
        !descriptor.success ||
        descriptor.data.endpoint.path !== address.path ||
        descriptor.data.endpoint.kind !==
          (address.kind === 'unix-socket' ? 'socket' : 'pipe')
      )
        refuse('endpoint-unavailable');
      const owner = await platform.supervision.inspectProcess({
        pid: descriptor.data.pid,
        signal,
      });
      if (
        owner.state === 'unverifiable' ||
        (owner.state === 'running' &&
          owner.startIdentity === descriptor.data.startIdentity)
      )
        refuse('identity-unprovable');
    }
    held.set(exclusive, { dataRoot, claims: claimPort, handle, verifyRuntime });
    if (!(await isW5MaintenanceHeld(exclusive, dataRoot))) refuse('claim-lost');
    // Local import keeps SQLite and offline scans off the desktop startup graph.
    const { diagnoseW5State } = await import('./w5-maintenance-diagnosis');
    const diagnosis = await diagnoseW5State(dataRoot);
    signal?.throwIfAborted();
    if (!(await isW5MaintenanceHeld(exclusive, dataRoot))) refuse('claim-lost');
    if (request.mode === 'diagnose') return { mode: 'diagnose', diagnosis };
    // Do not start a recovery-capable writer with unresolved decisions/effects.
    if (
      diagnosis.logIssue ||
      diagnosis.commits.length ||
      diagnosis.reservations.length
    )
      refuse('recovery-required');
    const commitId = await restoreW5Backup(context, {
      source: request.source,
      backupPath: request.backupPath,
      exclusive,
      unreadableOverride: request.unreadableOverride,
    });
    return { mode: 'restore', commitId };
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    await finishMaintenance();
  }
}
