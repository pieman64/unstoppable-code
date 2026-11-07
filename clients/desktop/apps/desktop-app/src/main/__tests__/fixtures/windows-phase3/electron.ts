import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { app } from 'electron';
import {
  hostPlatformServices,
  createPlatformEndpointServices,
} from '@canopy/core-platform';
import { CanopyRuntimeDescriptorSchema } from '@canopy/protocol/canopy-core';

// No BrowserWindow: this is actual Electron main, not an Electron mock or a
// packaged-app simulation. All product paths are explicitly isolated.
async function qualify(): Promise<void> {
  assert.equal(process.platform, 'win32');
  assert.ok(process.versions.electron, 'actual electron.exe required');
  const [directory, executable, addon, helper, runtimeRoot] =
    process.argv.slice(2);
  assert.ok(
    directory && executable && addon && helper && runtimeRoot,
    'fixture paths required',
  );
  const userData = join(runtimeRoot, 'electron');
  await mkdir(userData, { recursive: true });
  app.setPath('userData', userData);
  app.setAppLogsPath(join(userData, 'logs'));
  await app.whenReady();
  const {
    getElectronDaemonConnections,
    getElectronDaemonFilesContext,
    disposeElectronDaemonConnections,
  } = await import('../../../canopy-runtime/electron-daemon-access');
  const dataRoot = join(runtimeRoot, 'data');
  const platform = hostPlatformServices(
    createPlatformEndpointServices('win32'),
    {
      windowsProcessPath: helper,
    },
  );
  const clients: { close(): Promise<void> }[] = [];
  let identity: { pid: number; startIdentity: string } | undefined;
  let daemonExecutable: string | undefined;
  async function cleanup(): Promise<void> {
    await Promise.all(clients.map((client) => client.close()));
    await disposeElectronDaemonConnections();
    // Never stop an unrelated/reused PID after a failed assertion.
    if (!identity) {
      try {
        identity = CanopyRuntimeDescriptorSchema.parse(
          JSON.parse(
            await readFile(join(dataRoot, 'runtime/core.json'), 'utf8'),
          ),
        );
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            'code' in error &&
            error.code === 'ENOENT'
          )
        )
          throw error;
      }
    }
    if (identity) {
      const observed = await platform.supervision.inspectProcess({
        pid: identity.pid,
      });
      if (
        observed.state === 'running' &&
        observed.startIdentity === identity.startIdentity
      ) {
        const stopped = await platform.supervision.killProcessTree({
          pid: identity.pid,
          mode: 'graceful',
        });
        assert.ok(stopped.kind === 'signaled' || stopped.kind === 'absent');
        assert.equal(
          (await platform.supervision.inspectProcess({ pid: identity.pid }))
            .state,
          'absent',
        );
      }
    }
    await rm(runtimeRoot, { recursive: true, force: true });
  }
  try {
    const task = 'workspaces/phase3/worktrees/task';
    const seed = async (path: string, value: unknown): Promise<void> => {
      const file = join(dataRoot, path);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(value));
    };
    await seed('workspaces/index.json', {
      version: 1,
      workspaces: [
        { id: 'phase3', name: 'phase3', type: 'single-repo', color: '#fff' },
      ],
    });
    await seed('workspaces/phase3/workspace.json', {
      version: 1,
      type: 'single-repo',
      repos: [],
    });
    await seed('workspaces/phase3/worktrees.json', {
      version: 1,
      worktrees: [{ id: 'task', branchName: 'phase3', createdAt: 'now' }],
    });
    await seed(`${task}/fixture.json`, { phase3: true });
    const cases: string[] = [];
    for (const started of [true, false]) {
      // Drive the product entry, including getHost/connectTrusted and leases;
      // distinct callers force a new attachment rather than a cached session.
      const context = await getElectronDaemonFilesContext();
      assert.equal(resolve(context.canonicalDataRoot), resolve(dataRoot));
      if (started) {
        await assert.rejects(readFile(join(dataRoot, 'runtime/core.json')), {
          code: 'ENOENT',
        });
      }
      const session = await getElectronDaemonConnections().get(
        {
          authorityId: context.authorityId,
          principalId: 'phase3',
          clientInstanceId: `phase3-${started}`,
          interfaceKind: 'desktop',
          grants: ['worker.filesystem.read'],
        },
        new AbortController().signal,
      );
      clients.push(session);
      const descriptor = CanopyRuntimeDescriptorSchema.parse(
        JSON.parse(await readFile(join(dataRoot, 'runtime/core.json'), 'utf8')),
      );
      assert.equal(descriptor.endpoint.kind, 'pipe');
      assert.ok(process.env.SystemRoot, 'Windows system directory required');
      daemonExecutable = execFileSync(
        join(
          process.env.SystemRoot,
          'System32/WindowsPowerShell/v1.0/powershell.exe',
        ),
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-Process -Id ${descriptor.pid} -ErrorAction Stop).Path`,
        ],
        { encoding: 'utf8', windowsHide: true, timeout: 10_000 },
      ).trim();
      assert.equal(
        resolve(daemonExecutable).toLowerCase(),
        resolve(executable).toLowerCase(),
      );
      if (identity) {
        assert.equal(
          descriptor.pid,
          identity.pid,
          'attachment must reuse the daemon',
        );
        assert.equal(descriptor.startIdentity, identity.startIdentity);
      }
      identity = descriptor;
      const roots = await session.client.query('worker.filesystem.roots.list', {
        scope: { workspaceId: 'phase3', worktreeId: 'task' },
      });
      assert.ok(roots.roots.some(({ fileRootId }) => fileRootId === 'phase3'));
      cases.push(
        started
          ? 'electron-launch-secured-pipe'
          : 'electron-attachment-same-daemon',
      );
    }
    await writeFile(
      join(directory, 'electron.json'),
      JSON.stringify(
        {
          cases,
          electron: process.versions.electron,
          executable: process.execPath,
          daemonExecutable,
          packaged: app.isPackaged,
          entry: 'getElectronDaemonConnections',
          stagedAddon: resolve(addon),
          identity,
        },
        null,
        2,
      ),
    );
  } finally {
    await cleanup();
  }
}
void qualify().then(
  () => app.exit(0),
  (error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.stack : 'qualification failed'}\n`,
    );
    app.exit(1);
  },
);
