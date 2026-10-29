/**
 * Device-to-device remote access across several computers at once.
 *
 * Four desktops on one machine, one account, the real `apps/device-relay`:
 * controller A controls hosts B and C at the same time, and a second
 * controller D also controls B. Work runs in parallel across all sessions,
 * a real chat turn (bundled Claude CLI against the mock LLM) started from A's
 * window streams back to A and to B's own window, and revoking A on B leaves
 * D's session to B and A's session to C working.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { startDeviceRelay } from './helpers/deviceRelay.mjs';
import {
  DEMO_APPS,
  launchDesktop,
  openRemoteWindow,
  pairDevices,
  remoteState,
  runRemoteTerminal,
} from './helpers/remoteAccess.mjs';
import { closeCanopy } from './launchCanopy.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';
import {
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
} from './seeders/registerScenario.mjs';

const WORKTREE_ID = 'demo-main';
const B_PROJECT = 'demo-ts-pnpm-vite';
const C_PROJECT = 'demo-ts-bun-api';
const CHAT_ID = 'remote-access-chat';
const REPLY = 'Hello from the host computer through remote access.';

async function worktreePath(desktop, projectId) {
  return desktop.window.evaluate(
    ({ projectId, worktreeId }) =>
      window.api.getWorktreePath({ projectId, worktreeId }),
    { projectId, worktreeId: WORKTREE_ID },
  );
}

test.describe('device-to-device remote access, several computers', () => {
  test.setTimeout(600_000);

  test('one controller drives two computers while another shares one', async () => {
    const relay = await startDeviceRelay();
    const apiKey = `csk_remote_multi_${randomUUID()}`;
    const marker = `Canopy-CREMOTEMULTI${randomUUID().slice(0, 8).toUpperCase()}`;
    await registerScenario(undefined, apiKey, {
      cloud: {
        deviceRelay: {
          url: relay.url,
          secret: relay.secret,
          userId: 'remote-access-multi-user',
        },
      },
    });
    await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
      llm: {
        steps: [{ text: REPLY, streamMs: 2_000, chunkChars: 6 }],
      },
    });

    const desktops = [];
    try {
      const b = await launchDesktop({
        label: 'b',
        demoApp: 'ts-pnpm-vite',
        apiKey,
        seed: (userDataDir) => {
          seedWorktreeChat({
            userDataDir,
            workspaceId: B_PROJECT,
            worktreeId: WORKTREE_ID,
            providerType: 'claude',
            tabs: [
              {
                id: CHAT_ID,
                title: 'Remote chat',
                model: 'claude-haiku-4-5-20251001',
              },
            ],
          });
        },
      });
      desktops.push(b);
      const c = await launchDesktop({
        label: 'c',
        demoApp: 'ts-bun-api',
        apiKey,
      });
      desktops.push(c);
      const a = await launchDesktop({ label: 'a', apiKey });
      desktops.push(a);
      const d = await launchDesktop({ label: 'd', apiKey });
      desktops.push(d);

      await pairDevices(a, b);
      await pairDevices(a, c);
      await pairDevices(d, b);
      const aState = await remoteState(a.window);
      expect(aState.hosts.map((host) => host.deviceId).sort()).toEqual(
        [b.deviceId, c.deviceId].sort(),
      );
      await expect
        .poll(async () => (await remoteState(b.window)).controllers.length)
        .toBe(2);

      // A opens both computers; D opens B. Each window shows its own host.
      const aOnB = await openRemoteWindow(a, b);
      const aOnC = await openRemoteWindow(a, c);
      const dOnB = await openRemoteWindow(d, b);
      await expect(aOnB.window.getByTestId('app-sidebar')).not.toContainText(
        DEMO_APPS['ts-bun-api'],
      );
      await expect(aOnC.window.getByTestId('app-sidebar')).not.toContainText(
        DEMO_APPS['ts-pnpm-vite'],
      );
      await expect
        .poll(async () =>
          (await remoteState(b.window)).controllers.every(
            (controller) => controller.connected,
          ),
        )
        .toBe(true);

      // Parallel work across all three sessions; every file lands on the
      // computer that window shows.
      const bPath = await worktreePath(b, B_PROJECT);
      const cPath = await worktreePath(c, C_PROJECT);
      const jobs = [
        [aOnB, B_PROJECT, bPath, 'a-on-b'],
        [aOnC, C_PROJECT, cPath, 'a-on-c'],
        [dOnB, B_PROJECT, bPath, 'd-on-b'],
      ];
      const outputs = await Promise.all(
        jobs.map(([remote, projectId, , name]) =>
          runRemoteTerminal(remote.window, {
            projectId,
            worktreeId: WORKTREE_ID,
            command: `for i in $(seq 1 300); do echo ${name}-line-$i; done > ${name}.txt && echo DONE-${name}; sleep 1`,
            marker: `DONE-${name}`,
          }),
        ),
      );
      expect(outputs).toHaveLength(3);
      for (const [, , root, name] of jobs) {
        const file = path.join(root, `${name}.txt`);
        expect(existsSync(file)).toBe(true);
        expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(300);
      }
      expect(existsSync(path.join(cPath, 'a-on-b.txt'))).toBe(false);
      expect(existsSync(path.join(bPath, 'a-on-c.txt'))).toBe(false);

      // A real chat turn started from A's window runs on B; the streamed reply
      // reaches A's window and B's own window.
      const remoteApp = new CanopyAppDriver(aOnB.window);
      await remoteApp.openMainPage();
      await remoteApp.selectWorktree(WORKTREE_ID);
      const remotePanel = aOnB.window.getByTestId('panel-content-chat');
      await remotePanel
        .getByRole('textbox')
        .fill(`[${marker}] Say hello from the host`);
      await remotePanel.getByRole('textbox').press('Enter');
      await expect(remotePanel).toContainText(REPLY, { timeout: 120_000 });
      const hostApp = new CanopyAppDriver(b.window);
      await hostApp.openMainPage();
      await hostApp.selectWorktree(WORKTREE_ID);
      await expect(b.window.getByTestId('panel-content-chat')).toContainText(
        REPLY,
        { timeout: 60_000 },
      );
      // D's window on B sees the same conversation.
      const otherApp = new CanopyAppDriver(dOnB.window);
      await otherApp.openMainPage();
      await otherApp.selectWorktree(WORKTREE_ID);
      await expect(dOnB.window.getByTestId('panel-content-chat')).toContainText(
        REPLY,
        { timeout: 60_000 },
      );

      // B removes A. A loses B, but D keeps B and A keeps C.
      await b.window.evaluate(
        (deviceId) =>
          window.api.remoteControl.forgetDevice({
            deviceId,
            role: 'controller',
          }),
        a.deviceId,
      );
      await expect
        .poll(
          async () =>
            (await remoteState(a.window)).hosts.find(
              (host) => host.deviceId === b.deviceId,
            )?.connection,
          { timeout: 30_000 },
        )
        .not.toBe('connected');
      const after = await Promise.all([
        runRemoteTerminal(dOnB.window, {
          projectId: B_PROJECT,
          worktreeId: WORKTREE_ID,
          command: 'echo DONE-d-after; sleep 1',
          marker: 'DONE-d-after',
        }),
        runRemoteTerminal(aOnC.window, {
          projectId: C_PROJECT,
          worktreeId: WORKTREE_ID,
          command: 'echo DONE-c-after; sleep 1',
          marker: 'DONE-c-after',
        }),
      ]);
      expect(after).toHaveLength(2);
      await expect(
        aOnB.window.evaluate(() =>
          window.api.terminal.list().then(
            () => 'resolved',
            (error) => String(error),
          ),
        ),
      ).resolves.not.toBe('resolved');
    } finally {
      for (const desktop of desktops.reverse()) {
        await closeCanopy(desktop.electronApp, desktop.userDataDir);
      }
      await relay.stop();
    }
  });
});
