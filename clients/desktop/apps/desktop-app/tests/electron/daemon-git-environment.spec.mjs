import { expect, test } from '@playwright/test';
import { _electron } from '@playwright/test';
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { verifyE2eDaemonHosts } from '../../../../scripts/lib/e2e-core-daemon-artifact.mjs';

/*
 * CAN-5496 (N4): daemon-served Git for an Electron caller runs with the
 * environment Electron builds per request (V1, q-8 option a), not the
 * daemon's launch-filtered one. Real Electron main composes the production
 * builder, createElectronDaemonHost and the daemon client, and launches a
 * daemon built from source through the owned-child launcher. The daemon
 * build adds worker.git.read for its peers and bundled worker at bundle time
 * (test-only, as the jest suites' module mocks): the shipped daemon and
 * every production caller hold no such grant. Loopback ssh and HTTP only;
 * no developer ssh or Git configuration is read.
 *
 * The pre-commit (node on the login PATH) and LFS pre-push cases need the
 * daemon's commit and push, which CAN-4108 adds on this harness.
 */

const root = process.cwd();

/** The staged E2E artifact's verified addon; a local build only off CI. */
function ownedChildAddon() {
  try {
    return verifyE2eDaemonHosts({
      root,
      sourceSha: execFileSync('git', ['rev-parse', 'HEAD']).toString().trim(),
      platform: process.platform,
      arch: process.arch,
    }).ownedChildNativePath;
  } catch (error) {
    // CI must run the verified artifact, never an unverified local build.
    if (process.env.CI) throw error;
    const local = resolve(
      `.cache/native-owned-child/${process.platform}-${process.arch}/core-owned-child.node`,
    );
    if (!existsSync(local))
      throw new Error(
        'The owned-child addon is missing: stage the E2E daemon artifact or run pnpm run build:owned-child.',
      );
    return local;
  }
}

/** Rewrites the daemon's two runtime imports to add the test-only grant. */
const grantShim = {
  name: 'can-5496-test-grants',
  setup(builder) {
    builder.onResolve({ filter: /^@canopy\/core-runtime(\/node)?$/ }, (args) =>
      args.importer.includes('/apps/core-daemon/src/')
        ? { path: args.path, namespace: 'can-5496-grant' }
        : undefined,
    );
    builder.onLoad({ filter: /.*/, namespace: 'can-5496-grant' }, (args) => ({
      resolveDir: root,
      loader: 'js',
      contents:
        args.path === '@canopy/core-runtime'
          ? `import * as actual from '@canopy/core-runtime';
             export * from '@canopy/core-runtime';
             export function createRuntimeProfileGraph(options) {
               return actual.createRuntimeProfileGraph({...options, ...(options.workerCaller && {
                 workerCaller: {...options.workerCaller, grants: [...options.workerCaller.grants, 'worker.git.read']},
               })});
             }`
          : `import * as actual from '@canopy/core-runtime/node';
             export * from '@canopy/core-runtime/node';
             export function serveCanopyDaemonControlPlane(options) {
               return actual.serveCanopyDaemonControlPlane({...options, callerFor: (identity) => {
                 const caller = options.callerFor(identity);
                 return {...caller, grants: [...caller.grants, 'worker.git.read']};
               }});
             }`,
    }));
  },
};

const NODE_BUNDLE = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
};

async function requireBundle(directory, name, contents) {
  const outfile = join(directory, `${name}.cjs`);
  await build({ stdin: { contents, resolveDir: root, loader: 'ts' }, outfile, ...NODE_BUNDLE }); // prettier-ignore
  return createRequire(import.meta.url)(outfile);
}

/** The daemon from source, run by this Node through an absolute-path wrapper. */
async function testDaemon(directory, brand) {
  const bundle = join(directory, 'daemon.cjs');
  await build({
    entryPoints: [join(root, 'apps/core-daemon/src/main.ts')],
    outfile: bundle,
    ...NODE_BUNDLE,
    external: ['node:*'],
    logLevel: 'error',
    plugins: [grantShim],
    define: {
      __CANOPY_DAEMON_BUILD_VERSION__: JSON.stringify('0.0.0-can-5496'),
      __CANOPY_DAEMON_BUILD_BRAND_ID__: JSON.stringify(brand.id),
      __CANOPY_DAEMON_BUILD_COWORK_DIR_NAME__: JSON.stringify(brand.cowork),
    },
  });
  // The daemon's own PATH has no node, so no `#!/usr/bin/env node`.
  const executable = join(directory, 'daemon');
  writeFileSync(
    executable,
    `#!/bin/sh\nexec '${process.execPath}' '${bundle}' "$@"\n`,
  );
  chmodSync(executable, 0o755);
  return executable;
}

const ELECTRON_MAIN = `
  import {app} from 'electron';
  import {createElectronDaemonHost,ELECTRON_DAEMON_DEFINITIONS} from './apps/desktop-app/src/main/canopy-runtime/electron-daemon-host';
  import {daemonGitRequestExecution} from './apps/desktop-app/src/main/canopy-runtime/daemon-git-environment';
  import {prewarmLoginShellPath} from '@canopy/desktop-shared/pipelines/config-paths';
  import {attachOrStartCanopyDaemon} from '@canopy/core-client/node';
  import {WORKER_QUERY_DEFINITIONS} from '@canopy/protocol/canopy-core';
  const definitions={...ELECTRON_DAEMON_DEFINITIONS,queries:{...ELECTRON_DAEMON_DEFINITIONS.queries,
    'worker.git.branch.list':WORKER_QUERY_DEFINITIONS['worker.git.branch.list'],
    'worker.git.remote.get':WORKER_QUERY_DEFINITIONS['worker.git.remote.get']}};
  globalThis.n4Ready=app.whenReady().then(async()=>{
    await prewarmLoginShellPath();
    const host=await createElectronDaemonHost(JSON.parse(process.env.CAN5496_HOST_INPUTS));
    const {value:client}=await attachOrStartCanopyDaemon({...host.launch,signal:new AbortController().signal,
      attach:(endpoint,setup)=>host.connect({endpoint,...setup,clientName:'desktop',clientVersion:'can-5496',definitions}),
      dispose:(connected)=>connected.close()});
    await client.instruction('core.client.lease.acquire',{clientInstanceId:'electron-main-can-5496',interfaceKind:'desktop',
      label:'Desktop',interactive:true,foreground:true,renewalIntervalMs:15000,_meta:{idempotencyKey:'can-5496'}});
    const reference=(workspaceId)=>({scope:{workspaceId},repository:{kind:'reference'}});
    globalThis.n4={
      // Built per request in this async context, as a route adapter would.
      forwarded:async(workspaceId)=>(await client.query('worker.git.branch.list',reference(workspaceId),
        {execution:daemonGitRequestExecution('repository-read')})).defaultBranchSource,
      // The CLI's shape: no forwarded environment.
      own:async(workspaceId)=>(await client.query('worker.git.branch.list',reference(workspaceId))).defaultBranchSource,
      setEnv:(key,value)=>{process.env[key]=value;},
      loginPath:()=>process.env.PATH,
      close:()=>client.close(),
    };
  });`;

const ELECTRON_DEFINE = {
  __CANOPY_CURSOR_CLI__: JSON.stringify(
    JSON.parse(readFileSync(resolve('package.json'), 'utf8'))['cursor-cli'],
  ),
  __CANOPY_E2E__: 'false',
  __CANOPY_RELEASE_FLAVOR__: JSON.stringify('internal'),
  __CANOPY_CLOUD_BASE_URL__: JSON.stringify(''),
  __CANOPY_CLI_LINUX_ARM64_DEVELOPMENT__: 'false',
};

/** A login shell whose PATH is the fixture's, as the managed PATH probe reads it. */
function loginShell(directory, loginPath) {
  const shell = join(directory, 'login-shell');
  writeFileSync(
    shell,
    [
      '#!/bin/sh',
      `exec /bin/zsh -f -lic 'PATH="$CAN5496_LOGIN_PATH"; export PATH; eval "$1"' fixture "$2"`,
      '',
    ].join('\n'),
  );
  chmodSync(shell, 0o755);
  return { SHELL: shell, CAN5496_LOGIN_PATH: loginPath };
}

function git(cwd, env, ...args) {
  return execFileSync(
    'git',
    ['-c', 'user.name=Canopy', '-c', 'user.email=canopy@example.com', ...args],
    { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] },
  ).toString();
}

/** A recorded single-repo workspace tracking `bare` locally, origin set to `url`. */
function seedWorkspace(dataRoot, fixtures, env, { id, bare, url, config }) {
  mkdirSync(bare, { recursive: true });
  git(bare, env, 'init', '--quiet', '--bare');
  git(bare, env, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  const source = join(fixtures, `${id}-source`);
  mkdirSync(source, { recursive: true });
  git(source, env, 'init', '--quiet');
  git(source, env, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  git(source, env, 'commit', '--quiet', '--allow-empty', '-m', 'init');
  git(source, env, 'remote', 'add', 'origin', bare);
  git(source, env, 'push', '--quiet', 'origin', 'main');
  git(source, env, 'fetch', '--quiet', 'origin');
  git(source, env, 'remote', 'set-head', 'origin', 'main');
  git(source, env, 'remote', 'set-url', 'origin', url);
  for (const [key, value] of Object.entries(config))
    git(source, env, 'config', key, value);
  const write = (relative, document) => {
    const target = join(dataRoot, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify(document));
  };
  const indexPath = join(dataRoot, 'workspaces/index.json');
  let index = { version: 1, workspaces: [] };
  try {
    index = JSON.parse(readFileSync(indexPath, 'utf8'));
  } catch {
    // First workspace.
  }
  write('workspaces/index.json', {
    version: 1,
    workspaces: [
      ...index.workspaces,
      { id, name: id, type: 'single-repo', color: '#fff' },
    ],
  });
  write(`workspaces/${id}/workspace.json`, {
    version: 1,
    type: 'single-repo',
    repoPath: source,
    repos: [],
  });
}

function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return filesUnder(path);
    return entry.isFile() ? [path] : [];
  });
}

test('daemon-served Git runs with the Electron request environment, per request', async ({}, testInfo) => {
  test.skip(process.platform !== 'darwin', 'Owned daemon serving and the loopback sshd are macOS only.'); // prettier-ignore
  test.setTimeout(180_000);
  const scratch = realpathSync(mkdtempSync('/tmp/c5496-e-'));
  const dataRoot = join(scratch, 'data');
  const fixtures = join(scratch, 'f');
  const home = join(scratch, 'home');
  for (const directory of [dataRoot, fixtures, home])
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  const sentinel = `canopy-n4-${randomBytes(12).toString('hex')}`;
  const stoppables = [];
  let electron;
  let electronOutput = '';
  try {
    const transport = await requireBundle(
      scratch,
      'transport',
      "export * from './apps/core-daemon/src/__tests__/git-transport-fixtures';",
    );
    const brand = await requireBundle(
      scratch,
      'brand',
      "import {BRAND} from '@canopy/brand/current'; export const id=BRAND.id; export const cowork=BRAND.storage.projectConfigDirNames[0];",
    );
    const fixtureEnv = {
      PATH: process.env.PATH,
      HOME: home,
      ...transport.ISOLATED_GIT_CONFIG,
    };

    const sshBare = join(fixtures, 'ssh.git');
    const ssh = await transport.startSshOrigin(join(fixtures, 's'), sshBare);
    stoppables.push(ssh);
    seedWorkspace(dataRoot, fixtures, fixtureEnv, {
      id: 'ssh',
      bare: sshBare,
      url: ssh.url,
      config: { 'core.sshCommand': ssh.sshCommand },
    });
    const httpRoot = join(fixtures, 'http');
    const https = await transport.startHttpsOrigin(httpRoot);
    stoppables.push(https);
    const credential = transport.bareNameCredentialHelper(fixtures);
    const { bin } = credential;
    seedWorkspace(dataRoot, fixtures, fixtureEnv, {
      id: 'https',
      bare: join(httpRoot, 'https.git'),
      url: `${https.url}/https.git`,
      config: {
        'credential.helper': credential.helper,
        'http.sslCAInfo': https.caFile,
      },
    });
    const { inspect } = await requireBundle(
      scratch,
      'inspect',
      "import {hostPlatformServices,createPlatformEndpointServices,hostPlatformOperatingSystem} from '@canopy/core-platform'; export const inspect=hostPlatformServices(createPlatformEndpointServices(hostPlatformOperatingSystem())).supervision.inspectProcess;",
    );
    stoppables.push({
      // A failed run must not leave its daemon waiting out the idle grace;
      // only the process this data root's descriptor names is signalled.
      stop: async () => {
        let owned;
        try {
          owned = JSON.parse(readFileSync(join(dataRoot, 'runtime/core.json'), 'utf8')); // prettier-ignore
        } catch {
          return;
        }
        const current = await inspect({ pid: owned.pid });
        if (current.state !== 'running' || current.startIdentity !== owned.startIdentity) return; // prettier-ignore
        process.kill(owned.pid, 'SIGTERM');
        await expect
          .poll(async () => (await inspect({ pid: owned.pid })).state, {
            timeout: 30_000,
          }) // prettier-ignore
          .toBe('absent');
      },
    });

    const executable = await testDaemon(scratch, brand);
    const main = join(scratch, 'main.cjs');
    await build({
      stdin: { contents: ELECTRON_MAIN, resolveDir: root, loader: 'ts' },
      outfile: main,
      ...NODE_BUNDLE,
      define: ELECTRON_DEFINE,
      external: ['electron'],
      banner: {
        js: "process.on('unhandledRejection', error => {process.stderr.write(String(error && error.stack));});",
      },
    });
    const inherited = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) =>
          !key.startsWith('GIT_') &&
          !['SSH_AUTH_SOCK', 'CANOPY_ENV_ENHANCED', 'CANOPY_GIT_EXECUTABLE'].includes(key), // prettier-ignore
      ),
    );
    // The helper is only on the login PATH, as node is for a repo hook.
    const systemPath = '/usr/bin:/bin:/usr/sbin:/sbin';
    electron = await _electron.launch({
      args: [main, `--user-data-dir=${join(scratch, 'chromium')}`],
      env: {
        ...inherited,
        HOME: home,
        PATH: `${dirname(process.execPath)}:${systemPath}`,
        ...loginShell(scratch, `${bin}:${systemPath}`),
        ...transport.ISOLATED_GIT_CONFIG,
        SSH_AUTH_SOCK: ssh.agentSocket,
        CANOPY_N4_SENTINEL: sentinel,
        CAN5496_HOST_INPUTS: JSON.stringify({
          dataRoot,
          runtimeMode: 'dev',
          executable,
          ownedChildNativePath: ownedChildAddon(),
        }),
      },
    });
    electron.process().stderr.on('data', (chunk) => {
      electronOutput = (electronOutput + chunk).slice(-65_536);
    });
    electron.process().stdout.on('data', (chunk) => {
      electronOutput = (electronOutput + chunk).slice(-65_536);
    });
    await electron.evaluate(async () => globalThis.n4Ready);
    const call = (name, ...args) =>
      electron.evaluate(
        async (_, [method, values]) => globalThis.n4[method](...values),
        [name, args],
      );

    // SSH through Electron's agent; the daemon's own environment has none.
    await expect(call('forwarded', 'ssh')).resolves.toBe('remote');
    await expect(call('own', 'ssh')).resolves.toBe('local-origin-head');
    // Electron's own environment asking for prompts changes nothing.
    await call('setEnv', 'GIT_TERMINAL_PROMPT', '1');
    await call('setEnv', 'GCM_INTERACTIVE', 'always');
    await expect(call('forwarded', 'ssh')).resolves.toBe('remote');
    // A changed agent between two requests: each uses its own.
    await call('setEnv', 'SSH_AUTH_SOCK', ssh.deadAgentSocket);
    await expect(call('forwarded', 'ssh')).resolves.toBe('local-origin-head');
    await call('setEnv', 'SSH_AUTH_SOCK', ssh.agentSocket);
    await expect(call('forwarded', 'ssh')).resolves.toBe('remote');

    // HTTPS through a helper configured by bare name, found only on the
    // login PATH Electron's in-process Git uses.
    await expect(call('forwarded', 'https')).resolves.toBe('remote');
    // Without it the daemon's Git fails without prompting, and fast.
    const started = Date.now();
    await expect(call('own', 'https')).resolves.toBe('local-origin-head');
    expect(Date.now() - started).toBeLessThan(20_000);
    await call('close');
    // Every ssh and helper child, forwarded or not, ran non-interactive.
    for (const file of [ssh.switchesSeen, credential.switchesSeen]) {
      const seen = transport.recordedSwitches(file);
      expect(seen.length, file).toBeGreaterThan(0);
      expect(new Set(seen), file).toEqual(new Set(['0 never']));
    }

    // Never logged: no daemon file under the data root, and no Electron
    // output, holds a forwarded value.
    await electron.close();
    electron = undefined;
    // Stop the daemon so every file it writes is flushed before the scan.
    await stoppables.at(-1).stop();
    expect(electronOutput).not.toContain(sentinel);
    for (const file of [...filesUnder(dataRoot), ...filesUnder(home)])
      if (statSync(file).size < 16 * 1024 * 1024)
        expect(readFileSync(file, 'utf8'), file).not.toContain(sentinel);
  } finally {
    await electron?.close().catch(() => undefined);
    // The daemon first, then its transports.
    for (const stoppable of stoppables.reverse())
      await stoppable.stop().catch(() => undefined);
    await testInfo.attach('electron-output.txt', {
      body: electronOutput.replaceAll(sentinel, '<sentinel>'),
      contentType: 'text/plain',
    });
    rmSync(scratch, { recursive: true, force: true });
  }
});
