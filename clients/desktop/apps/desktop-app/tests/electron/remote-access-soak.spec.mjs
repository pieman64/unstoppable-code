/**
 * Device-to-device remote access soak test (manual).
 *
 * Run: REMOTE_ACCESS_SOAK_MINUTES=15 pnpm run test:electron:built remote-access-soak.spec.mjs --reporter=line
 *
 * Controller A keeps windows open on hosts B and C for the given duration
 * while running, in every round and in parallel on both hosts: a burst of
 * tunneled calls, a streaming terminal job whose output must arrive
 * complete, and every third round a 1 MB attachment upload. The relay is
 * restarted twice mid-run; operations that fail while it is down are counted
 * separately, and every window must reconnect and keep working. Memory and
 * window counts are sampled each minute to catch leaks (for example bridge
 * windows that outlive their sessions). Results go to
 * `.performance/remote-access/soak-*.json`.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { startDeviceRelay } from './helpers/deviceRelay.mjs';
import {
  DEMO_APPS,
  launchDesktop,
  openRemoteWindow,
  pairDevices,
  remoteState,
  runRemoteTerminal,
  summarize,
} from './helpers/remoteAccess.mjs';
import { closeCanopy } from './launchCanopy.mjs';
import { registerScenario } from './seeders/registerScenario.mjs';

const MINUTES = Number(process.env.REMOTE_ACCESS_SOAK_MINUTES ?? '0');
const WORKTREE_ID = 'demo-main';
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);

async function processSample(desktop) {
  // A window reload (after a reconnect) can briefly interrupt evaluation.
  try {
    return await readProcessSample(desktop);
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    return readProcessSample(desktop);
  }
}

async function readProcessSample(desktop) {
  return desktop.electronApp.evaluate(({ BrowserWindow, webContents }) => ({
    rssMb: Math.round(process.memoryUsage().rss / 1e6),
    heapMb: Math.round(process.memoryUsage().heapUsed / 1e6),
    windows: BrowserWindow.getAllWindows().length,
    webContents: webContents.getAllWebContents().length,
  }));
}

async function invokeBurst(window, count) {
  return window.evaluate(async (n) => {
    const timings = await Promise.all(
      Array.from({ length: n }, async () => {
        const startedAt = performance.now();
        await window.api.terminal.list();
        return performance.now() - startedAt;
      }),
    );
    return timings;
  }, count);
}

async function uploadAttachment(window, projectId) {
  return window.evaluate(
    async ({ projectId, worktreeId }) => {
      const bytes = new Uint8Array(1024 * 1024);
      for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = index % 251;
      }
      const file = new File([bytes], `soak-${Date.now()}.bin`);
      // Uploads to the controlled computer and returns its path there.
      const filePaths = await window.api.getPathsForFiles([file]);
      if (filePaths.length !== 1 || filePaths[0] === '') {
        throw new Error('The upload returned no path.');
      }
      const response = await window.api.importWorktreeAttachments({
        projectId,
        worktreeId,
        filePaths,
      });
      return response.attachments.length;
    },
    { projectId, worktreeId: WORKTREE_ID },
  );
}

async function waitForRemoteReady(remote, host, controller) {
  await expect
    .poll(
      async () =>
        (await remoteState(controller.window)).hosts.find(
          (entry) => entry.deviceId === host.deviceId,
        )?.connection,
      { timeout: 90_000 },
    )
    .toBe('connected');
  await expect(remote.window.getByTestId('app-sidebar')).toContainText(
    DEMO_APPS[host.demoApp],
    { timeout: 60_000 },
  );
}

test.describe('device-to-device remote access soak', () => {
  test.skip(MINUTES <= 0, 'Manual soak: set REMOTE_ACCESS_SOAK_MINUTES');
  test.setTimeout((MINUTES + 10) * 60_000);

  test('stays correct and leak-free under sustained parallel use', async () => {
    const relay = await startDeviceRelay();
    const apiKey = `csk_remote_soak_${randomUUID()}`;
    await registerScenario(undefined, apiKey, {
      cloud: {
        deviceRelay: {
          url: relay.url,
          secret: relay.secret,
          userId: 'remote-access-soak-user',
        },
      },
    });
    const desktops = [];
    const report = {
      minutes: MINUTES,
      rounds: 0,
      operations: 0,
      failures: [],
      outageFailures: 0,
      relayRestarts: [],
      invokeMs: [],
      terminalJobMs: [],
      uploads: 0,
      samples: [],
    };
    try {
      const b = await launchDesktop({
        label: 'soak-b',
        demoApp: 'ts-pnpm-vite',
        apiKey,
      });
      desktops.push(b);
      const c = await launchDesktop({
        label: 'soak-c',
        demoApp: 'ts-bun-api',
        apiKey,
      });
      desktops.push(c);
      const a = await launchDesktop({ label: 'soak-a', apiKey });
      desktops.push(a);
      await pairDevices(a, b);
      await pairDevices(a, c);
      const targets = [
        { host: b, projectId: 'demo-ts-pnpm-vite' },
        { host: c, projectId: 'demo-ts-bun-api' },
      ];
      // Control experiment: REMOTE_ACCESS_SOAK_LOCAL=1 runs the same work on
      // each host's own window, without remote access, for comparison.
      const local = process.env.REMOTE_ACCESS_SOAK_LOCAL === '1';
      for (const target of targets) {
        target.remote = local
          ? { window: target.host.window }
          : await openRemoteWindow(a, target.host);
      }

      const startedAt = Date.now();
      const deadline = startedAt + MINUTES * 60_000;
      const restartAt = [0.33, 0.66].map(
        (fraction) => startedAt + MINUTES * 60_000 * fraction,
      );
      let nextSampleAt = startedAt;
      let outage = false;

      while (Date.now() < deadline) {
        if (Date.now() >= nextSampleAt) {
          nextSampleAt += 60_000;
          report.samples.push({
            atMinute: Math.round((Date.now() - startedAt) / 6_000) / 10,
            controller: await processSample(a),
            hostB: await processSample(b),
            hostC: await processSample(c),
          });
        }
        if (!local && restartAt.length > 0 && Date.now() >= restartAt[0]) {
          restartAt.shift();
          outage = true;
          const restartStartedAt = Date.now();
          await relay.restart(2_000);
          for (const target of targets) {
            await waitForRemoteReady(target.remote, target.host, a);
          }
          report.relayRestarts.push({
            atMinute: Math.round((restartStartedAt - startedAt) / 6_000) / 10,
            recoveredInMs: Date.now() - restartStartedAt,
          });
          outage = false;
        }

        report.rounds += 1;
        const round = report.rounds;
        const work = targets.flatMap(({ host, projectId, remote }) => {
          const jobs = [
            invokeBurst(remote.window, 20).then((timings) => {
              report.invokeMs.push(...timings);
            }),
            runRemoteTerminal(remote.window, {
              projectId,
              worktreeId: WORKTREE_ID,
              command: `for i in $(seq 1 2000); do echo soak-${round}-$i; done; echo SOAK-${round}-$((1+1))DONE; sleep 1`,
              marker: `SOAK-${round}-2DONE`,
              timeoutMs: 120_000,
            }).then((result) => {
              report.terminalJobMs.push(result.elapsedMs);
              if (!result.text.includes(`soak-${round}-2000`)) {
                throw new Error(`Terminal output incomplete on ${host.label}`);
              }
            }),
          ];
          if (round % 3 === 0) {
            jobs.push(
              uploadAttachment(remote.window, projectId).then((count) => {
                if (count !== 1) throw new Error('Upload did not import');
                report.uploads += 1;
              }),
            );
          }
          return jobs;
        });
        const settled = await Promise.allSettled(work);
        report.operations += settled.length;
        for (const result of settled) {
          if (result.status === 'fulfilled') continue;
          if (outage) {
            report.outageFailures += 1;
          } else {
            report.failures.push({
              round,
              error: String(result.reason).slice(0, 300),
            });
          }
        }
        // Clean up this round's terminals so PTYs do not accumulate.
        await Promise.all(
          targets.map(({ remote }) =>
            remote.window.evaluate(async () => {
              const terminals = await window.api.terminal.list();
              await Promise.all(
                terminals.map((terminal) =>
                  window.api.terminal.kill({ terminalId: terminal.id }),
                ),
              );
            }),
          ),
        );
      }
      report.samples.push({
        atMinute: Math.round((Date.now() - startedAt) / 6_000) / 10,
        controller: await processSample(a),
        hostB: await processSample(b),
        hostC: await processSample(c),
      });
    } finally {
      const outDir = path.join(repoRoot, '.performance', 'remote-access');
      mkdirSync(outDir, { recursive: true });
      const relayWarnings = relay
        .output()
        .split('\n')
        .filter((line) => /WARN|rate limited|dropped|undeliverable/i.test(line))
        .slice(-20);
      const summary = {
        ...report,
        relayWarnings,
        invokeMs: summarize(report.invokeMs),
        terminalJobMs: summarize(report.terminalJobMs),
      };
      writeFileSync(
        path.join(
          outDir,
          `soak-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
        ),
        `${JSON.stringify(summary, null, 2)}\n`,
      );
      console.log(`REMOTE-ACCESS-SOAK ${JSON.stringify(summary)}`);
      for (const desktop of desktops.reverse()) {
        await closeCanopy(desktop.electronApp, desktop.userDataDir);
      }
      await relay.stop();
    }
    expect(report.failures).toEqual([]);
    if (process.env.REMOTE_ACCESS_SOAK_LOCAL !== '1') {
      expect(report.relayRestarts).toHaveLength(2);
    }
    const first = report.samples[0];
    const last = report.samples[report.samples.length - 1];
    // One bridge window per connected controller: no leaks across reconnects.
    expect(last.hostB.windows).toBe(first.hostB.windows);
    expect(last.hostC.windows).toBe(first.hostC.windows);
  });
});
