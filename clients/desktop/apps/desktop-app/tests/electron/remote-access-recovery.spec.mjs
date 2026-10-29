/**
 * Device-to-device remote access recovers on its own from everything that
 * breaks a long-lived connection, with no action from the user: the network
 * dropping, a corrupted packet in either direction, the relay restarting, and
 * either computer restarting. After each one, the controller's window on the
 * host works again (a terminal command runs on the host).
 *
 * Two desktops on one machine, one account, the real `apps/device-relay`,
 * reached through a proxy that can reset connections and corrupt bytes.
 */
import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { startDeviceRelay } from './helpers/deviceRelay.mjs';
import {
  launchDesktop,
  openRemoteWindow,
  pairDevices,
  remoteState,
  runRemoteTerminal,
  startDelayProxy,
} from './helpers/remoteAccess.mjs';
import { closeCanopy } from './launchCanopy.mjs';
import { registerScenario } from './seeders/registerScenario.mjs';

const PROJECT_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const RECOVERY_TIMEOUT_MS = 90_000;

test.describe('device-to-device remote access recovery', () => {
  test.setTimeout(900_000);

  test('recovers from network drops, bad packets, a relay restart and restarts of either computer', async () => {
    const relay = await startDeviceRelay();
    const proxy = await startDelayProxy({ targetPort: relay.port });
    const apiKey = `csk_remote_recovery_${randomUUID()}`;
    await registerScenario(undefined, apiKey, {
      cloud: {
        deviceRelay: {
          url: proxy.url,
          secret: relay.secret,
          userId: 'remote-access-recovery-user',
        },
      },
    });

    const running = new Map();
    const recoveries = {};
    try {
      let host = await launchDesktop({
        label: 'b',
        demoApp: 'ts-pnpm-vite',
        apiKey,
      });
      running.set('b', host);
      let controller = await launchDesktop({ label: 'a', apiKey });
      running.set('a', controller);
      await pairDevices(controller, host);
      let remote = await openRemoteWindow(controller, host);

      /**
       * Waits until a terminal command runs on the host through the remote
       * window, retrying while the window reconnects and reloads.
       */
      const expectWorking = async (name) => {
        const startedAt = Date.now();
        await expect
          .poll(
            async () => {
              try {
                await runRemoteTerminal(remote.window, {
                  projectId: PROJECT_ID,
                  worktreeId: WORKTREE_ID,
                  command: `echo DONE-${name}; sleep 1`,
                  marker: `DONE-${name}`,
                  timeoutMs: 15_000,
                });
                return true;
              } catch {
                return false;
              }
            },
            { timeout: RECOVERY_TIMEOUT_MS, intervals: [500, 1_000] },
          )
          .toBe(true);
        recoveries[name] = Date.now() - startedAt;
      };

      /** Streams terminal output from the host so frames are in flight. */
      const streamOutput = (name) =>
        runRemoteTerminal(remote.window, {
          projectId: PROJECT_ID,
          worktreeId: WORKTREE_ID,
          command: `seq 1 20000; echo DONE-${name}; sleep 1`,
          marker: `DONE-${name}`,
          timeoutMs: 15_000,
        }).catch(() => null);

      await expectWorking('baseline');

      // The network goes away under both computers at once.
      proxy.dropConnections();
      await expectWorking('network-drop');

      // A corrupted packet toward the controller, then toward the relay,
      // while output is streaming.
      proxy.corruptNext('toDesktop');
      await streamOutput('stream-1');
      await expect.poll(() => proxy.corrupted(), { timeout: 30_000 }).toBe(1);
      await expectWorking('bad-packet-to-desktop');
      proxy.corruptNext('toRelay');
      await streamOutput('stream-2');
      // Desktops send little to the relay while output streams the other
      // way; the window's own calls carry the second corruption.
      await expectWorking('bad-packet-to-relay');

      // The relay restarts.
      await relay.restart(1_000);
      await expectWorking('relay-restart');

      // The host restarts, keeping its data.
      await closeCanopy(host.electronApp, host.userDataDir, {
        keepUserData: true,
      });
      running.delete('b');
      host = await launchDesktop({
        label: 'b',
        demoApp: 'ts-pnpm-vite',
        apiKey,
        userDataDir: host.userDataDir,
      });
      host.deviceId = (await remoteState(host.window)).thisDevice.deviceId;
      running.set('b', host);
      await expectWorking('host-restart');

      // The controller restarts: it is still paired and opens the host again.
      const hostId = host.deviceId;
      await closeCanopy(controller.electronApp, controller.userDataDir, {
        keepUserData: true,
      });
      running.delete('a');
      controller = await launchDesktop({
        label: 'a',
        apiKey,
        userDataDir: controller.userDataDir,
      });
      running.set('a', controller);
      await expect
        .poll(
          async () =>
            (await remoteState(controller.window)).hosts.map(
              (entry) => entry.deviceId,
            ),
          { timeout: 30_000 },
        )
        .toContain(hostId);
      remote = await openRemoteWindow(controller, host);
      await expectWorking('controller-restart');
      await expect
        .poll(
          async () =>
            (await remoteState(host.window)).controllers.every(
              (entry) => entry.connected,
            ),
          { timeout: 30_000 },
        )
        .toBe(true);

      console.log(
        `[remote-access-recovery] ${JSON.stringify({
          recoveredInMs: recoveries,
          corruptedChunks: proxy.corrupted(),
        })}`,
      );
    } finally {
      for (const desktop of running.values()) {
        await closeCanopy(desktop.electronApp, desktop.userDataDir);
      }
      await proxy.stop();
      await relay.stop();
    }
  });
});
