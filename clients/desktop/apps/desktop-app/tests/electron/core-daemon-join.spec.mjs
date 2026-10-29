import { createServer } from 'node:net';
import { writeFile, readFile, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import {
  requestHost,
  withNativeDaemonArtifacts,
  withNativeDaemonHosts,
} from './helpers/native-daemon-hosts.mjs';

test('Join retains declarations through reconnect and isolates TTL, late completion, and CLI exits', async ({}, testInfo) => {
  test.skip(
    process.platform !== 'darwin',
    'Native Join acceptance requires macOS.',
  );
  test.setTimeout(150_000);
  await withNativeDaemonHosts(
    testInfo,
    async ({
      electron,
      cliHost,
      evidence,
      cliSession,
      descriptor,
      readDescriptor,
      report,
    }) => {
      expect(cliSession.started).toBe(false);
      for (const field of ['runtimeId', 'authorityId', 'hostId', 'daemonEpoch'])
        expect(cliSession.identity[field]).toBe(evidence.electron[field]);
      expect(cliSession.lease.leaseId).not.toBe(evidence.electronLease.leaseId);
      expect(cliSession.identity.connectionId).not.toBe(
        evidence.electron.connectionId,
      );
      expect(descriptor.endpoint.path).toContain(report.dataRoot);
      expect(descriptor.pid).not.toBe(evidence.mainPid);
      expect(descriptor.pid).not.toBe(cliHost.pid);
      const declared = await electron.evaluate(() =>
        globalThis.h3State.register(),
      );
      await electron.evaluate(async () => {
        const state = globalThis.h3State;
        await state.session.client.openStream('core.runtime.events', {});
      });
      const pending = await electron.evaluate(() =>
        globalThis.h3State.pauseReconnect(),
      );
      expect(pending.identity.connectionId).not.toBe(
        evidence.electron.connectionId,
      );
      expect(pending.lease).toBeNull();
      await electron.evaluate(() => globalThis.h3State.resumeReconnect());
      await expect
        .poll(() =>
          electron.evaluate(() => {
            try {
              return globalThis.h3State.snapshot();
            } catch {
              return null;
            }
          }),
        )
        .toMatchObject({
          identity: { runtimeId: evidence.electron.runtimeId },
          lease: { leaseId: evidence.electronLease.leaseId },
        });
      const rebound = await electron.evaluate(() =>
        globalThis.h3State.snapshot(),
      );
      expect(rebound.identity.connectionId).not.toBe(
        evidence.electron.connectionId,
      );
      expect(rebound.lease.leaseId).toBe(evidence.electronLease.leaseId);
      expect(rebound.identity.runtimeId).toBe(evidence.electron.runtimeId);
      const history = await electron.evaluate(() => ({
        acquisitions: globalThis.h3State.acquisitions,
        declarations: globalThis.h3State.declarations,
      }));
      expect(history.acquisitions.at(-1).params.previousLeaseId).toBe(
        evidence.electronLease.leaseId,
      );
      expect(history.declarations).toHaveLength(1);
      report.reconnectHistory = { ...history, pending };
      // Same key returns the retained declaration; reopening replaces one detached subscription.
      expect(
        await electron.evaluate(() => globalThis.h3State.register()),
      ).toEqual(declared);
      await electron.evaluate(() =>
        globalThis.h3State.session.client
          .openStream('core.runtime.events', {})
          .then(() => undefined),
      );
      const released = await electron.evaluate(() =>
        globalThis.h3State.releaseRegistered(),
      );
      expect(released.releasedRegistrationCount).toBe(3);
      expect(released.failedRequestIds).toEqual([]);
      expect((await requestHost(cliHost, 'health')).runtime.runtimeId).toBe(
        evidence.electron.runtimeId,
      );
      await electron.evaluate(() => globalThis.h3State.reacquire());
      const late = await electron.evaluate(() =>
        globalThis.h3State.lateRegistration(),
      );
      expect(late).toMatchObject({
        outcome: 'cancelled',
        state: 'released',
        lease: null,
        release: { releasedRegistrationCount: 1 },
      });
      report.late = late;
      await electron.evaluate(() => globalThis.h3State.reacquire());
      const fresh = await electron.evaluate(() =>
        globalThis.h3State.register(),
      );
      expect(fresh.registrationRevision).toBe(1);
      Object.assign(report, { declared, rebound, released, fresh });

      for (const command of ['status-failure', 'status-signal']) {
        const result = await requestHost(cliHost, command);
        expect(result.code).toBe(command === 'status-failure' ? 1 : 143);
        expect(result.acquires).toHaveLength(1);
        expect(result.releases).toHaveLength(1);
        expect(result.releases[0]).toMatchObject({
          released: true,
          releasedRegistrationCount: 0,
          failedRequestIds: [],
        });
        expect(result.identity.runtimeId).toBe(evidence.electron.runtimeId);
        expect(result.acquires[0].leaseId).not.toBe(cliSession.lease.leaseId);
        expect((await readDescriptor()).pid).toBe(descriptor.pid);
        report[command] = result;
      }
      // Use the production CLI host connection with no renewer to exercise real TTL delivery.
      const passive = await requestHost(cliHost, 'passive');
      expect(passive.identity.runtimeId).toBe(evidence.electron.runtimeId);
      expect(passive.lease.renewAfterMs).toBe(5000);
      await expect
        .poll(() => requestHost(cliHost, 'events'), { timeout: 30_000 })
        .toEqual([
          {
            leaseId: passive.lease.leaseId,
            reason: 'expired',
            releasedRegistrationCount: 2,
          },
        ]);
      const survivor = await electron.evaluate(async () => ({
        snapshot: globalThis.h3State.snapshot(),
        health: await globalThis.h3State.session.client.query(
          'core.runtime.health.get',
          {},
        ),
      }));
      expect(
        await electron.evaluate(() => globalThis.h3State.evictions),
      ).toEqual([]);
      expect(
        await electron.evaluate(() => globalThis.h3State.evictions),
      ).toEqual([]);
      expect(survivor.health.runtime.runtimeId).toBe(
        evidence.electron.runtimeId,
      );
      expect(survivor.snapshot.lease.leaseId).not.toBe(passive.lease.leaseId);
      expect((await readDescriptor()).pid).toBe(descriptor.pid);
      const remaining = await electron.evaluate(() =>
        globalThis.h3State.releaseRegistered(),
      );
      expect(remaining.releasedRegistrationCount).toBe(1);
      Object.assign(report, {
        passive,
        evictions: await requestHost(cliHost, 'events'),
        survivor,
        remaining,
      });
    },
  );
});

test('native artifact cleanup retains the original failure when a socket survives', async ({}, testInfo) => {
  test.skip(
    process.platform !== 'darwin',
    'Native Unix socket cleanup requires macOS.',
  );
  const server = createServer();
  let owned;
  try {
    await expect(
      withNativeDaemonArtifacts(testInfo, async (directory) => {
        owned = directory;
        await writeFile(join(directory, 'host.log'), 'owned evidence');
        await new Promise((done, reject) => {
          server.once('error', reject);
          server.listen(join(directory, 'core.sock'), done);
        });
        throw new Error('controlled host failure');
      }),
    ).rejects.toThrow('controlled host failure');
    expect(
      await readFile(testInfo.outputPath('native-host/host.log'), 'utf8'),
    ).toBe('owned evidence');
    expect(
      await stat(owned).catch((error) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      }),
    ).toBeNull();
  } finally {
    await new Promise((done) => server.close(done));
    if (owned) await rm(owned, { recursive: true, force: true });
  }
});
