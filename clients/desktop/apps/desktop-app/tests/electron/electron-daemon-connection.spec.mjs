import { expect, test } from '@playwright/test';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import {
  requestHost,
  withNativeDaemonHosts,
} from './helpers/native-daemon-hosts.mjs';

test('native Electron and CLI hosts retain one daemon across lease owners and quit', async ({}, testInfo) => {
  test.skip(process.platform !== 'darwin', 'H1 owned serving is Darwin only.');
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
      dataRoot,
      cliExecutable,
      closeElectron,
    }) => {
      expect(evidence.reused).toBe(true);
      expect(cliSession.started).toBe(false);
      for (const field of ['runtimeId', 'authorityId', 'hostId', 'daemonEpoch'])
        expect(evidence.electron[field]).toBe(cliSession.identity[field]);
      expect(evidence.electron.connectionId).not.toBe(
        cliSession.identity.connectionId,
      );
      expect(evidence.electronLease.leaseId).not.toBe(cliSession.lease.leaseId);
      expect(evidence.electronLease.clientInstanceId).toBe('electron-main-h3');
      expect(cliSession.lease.clientInstanceId).toBe('cli-h3-native');
      expect(evidence.health.runtime).toEqual(cliSession.health.runtime);
      expect(evidence.electron.authorityId).toMatch(/^[a-f0-9]{64}$/);
      expect(evidence.electron.authorityId).toBe(evidence.expectedAuthorityId);
      expect(evidence.health.runtime.authorityId).toBe(
        evidence.expectedAuthorityId,
      );
      expect(evidence.health.runtime.runtimeId).toBe(
        evidence.electron.runtimeId,
      );
      expect(descriptor.endpoint.path).toContain(await realpath(dataRoot));
      expect(descriptor.pid).not.toBe(evidence.mainPid);
      expect(descriptor.pid).not.toBe(cliHost.pid);
      expect(evidence.manifest).toContain('core.client.capabilities.register');
      expect(evidence.streams).toContain('core.runtime.events');
      expect(evidence.events).toEqual([]);
      const registered = await electron.evaluate(() =>
        globalThis.h3State.register(),
      );
      expect(registered.effectiveCapabilities).toContain('core.test.native');
      const ownerLoss = await electron.evaluate(() =>
        globalThis.h3State.loseOwner(),
      );
      expect(ownerLoss.releasedRegistrationCount).toBe(2);
      const reacquired = await electron.evaluate(() =>
        globalThis.h3State.reacquire(),
      );
      expect(reacquired.lease.leaseId).not.toBe(evidence.electronLease.leaseId);
      expect(reacquired.identity.runtimeId).toBe(evidence.electron.runtimeId);
      const registeredAgain = await electron.evaluate(() =>
        globalThis.h3State.register(),
      );
      const explicitRelease = await electron.evaluate(() =>
        globalThis.h3State.releaseRegistered(),
      );
      expect(explicitRelease.releasedRegistrationCount).toBe(1);
      Object.assign(report, {
        registered,
        ownerLoss,
        reacquired,
        registeredAgain,
        explicitRelease,
      });
      await electron.evaluate(() => globalThis.h3State.reacquire());
      const cli = await promisify(execFile)(
        cliExecutable,
        ['daemon', 'status'],
        {
          env: {
            ...process.env,
            CANOPY_DATA_DIR: dataRoot,
            NODE_ENV: 'development',
          },
          timeout: 30_000,
        },
      );
      expect(cli.stdout).toContain(`Runtime: ${evidence.electron.runtimeId}`);
      expect((await readDescriptor()).pid).toBe(descriptor.pid);
      await electron.evaluate(async () => globalThis.h3State.cleanup());
      await closeElectron();
      electron = undefined;
      expect((await requestHost(cliHost, 'health')).runtime.runtimeId).toBe(
        evidence.electron.runtimeId,
      );
      expect((await readDescriptor()).pid).toBe(descriptor.pid);
      await requestHost(cliHost, 'release');
      await new Promise((resolve) => setTimeout(resolve, 750));
      expect((await readDescriptor()).pid).toBe(descriptor.pid);
      const graceReconnect = await requestHost(cliHost, 'reacquire');
      expect(graceReconnect.identity.runtimeId).toBe(
        evidence.electron.runtimeId,
      );
      expect((await readDescriptor()).pid).toBe(descriptor.pid);
      await requestHost(cliHost, 'release');
      await expect
        .poll(
          () =>
            readDescriptor().catch((error) => {
              if (error.code === 'ENOENT') return null;
              throw error;
            }),
          { timeout: 45_000 },
        )
        .toBeNull();
      Object.assign(report, {
        cliOutput: cli.stdout,
        graceReconnect,
        cleanup:
          'desktop quit with CLI retained; last CLI release stopped daemon after cancelled idle grace',
      });
    },
  );
});
