jest.mock('node:fs/promises', () => {
  const actual: typeof fs = jest.requireActual('node:fs/promises');
  return { __esModule: true, ...actual };
});

import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { BRAND } from '@canopy/brand/current';
import { daemonName } from '@canopy/protocol/brand';
import { createLinuxCliInstaller } from '../ipc/linux-cli-install';

const execFileAsync = promisify(execFile);
const TOOLS = ['claude', 'codex', 'codex-code-mode-host', 'gh', 'rg', 'rtk'];
const DAEMON = daemonName(BRAND);
const DAEMON_COMPANIONS = [
  DAEMON,
  `${DAEMON}.identity.json`,
  'w5-commit-log-worker.js',
  'node-pty',
];
let root: string;
let home: string;
let gui: string;
let bundledCliPath: string;

function installer(
  env: NodeJS.ProcessEnv = {},
): ReturnType<typeof createLinuxCliInstaller> {
  return createLinuxCliInstaller({ bundledCliPath, homeDir: home, env });
}

async function write(file: string, value: string, mode = 0o644): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, value, { mode });
}

// Executable fixtures use the host Node only to exercise filesystem lifetime,
// NOT to claim Linux SEA/ELF acceptance on the macOS test host.
function executable(version: string, companion = false): string {
  return `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const root = path.dirname(fs.realpathSync(process.argv[1]));
function probe() {
  process.stdout.write(JSON.stringify({
    version: ${JSON.stringify(version)},
    root,
    companion: ${companion},
    wasm: fs.readFileSync(path.join(root, 'resources/code-graph/parser.wasm'), 'utf8'),
    module: fs.readFileSync(path.join(root, 'node_modules/typescript/index.js'), 'utf8'),
    tool: fs.readFileSync(path.join(root, 'rg'), 'utf8')
  }) + '\\n');
}
if (process.argv.includes('--watch')) {
  ${
    companion
      ? `process.stdout.write('ready\\n');
  require('node:readline').createInterface({ input: process.stdin }).on('line', probe);`
      : `const child = require('node:child_process').spawn(path.join(root, 'codex'), ['--watch'], { stdio: ['pipe', 'inherit', 'inherit'] });
  process.stdin.pipe(child.stdin);
  child.on('exit', code => process.exit(code || 0));
  process.on('SIGTERM', () => child.kill());`
  }
} else probe();
`;
}

async function distribution(version: string, packaged = true): Promise<void> {
  const cli = packaged ? path.join(gui, 'resources/cli') : gui;
  bundledCliPath = path.join(cli, BRAND.cliName);
  await write(bundledCliPath, executable(version), 0o755);
  for (const tool of TOOLS) {
    await write(
      path.join(packaged ? path.join(gui, 'resources/bin') : cli, tool),
      tool === 'codex' ? executable(version, true) : `${tool}-${version}`,
      0o755,
    );
  }
  const bin = packaged ? path.join(gui, 'resources/bin') : cli;
  await write(path.join(bin, DAEMON), `daemon-${version}`, 0o755);
  await write(
    path.join(bin, `${DAEMON}.identity.json`),
    JSON.stringify({ brandId: BRAND.id, version }),
  );
  await write(path.join(bin, 'w5-commit-log-worker.js'), `worker-${version}`);
  await write(path.join(bin, 'node-pty/package.json'), '{}');
  await write(
    path.join(bin, 'node-pty/build/Release/pty.node'),
    `pty-${version}`,
  );
  await write(
    path.join(cli, 'resources/code-graph/parser.wasm'),
    `wasm-${version}`,
  );
  await write(
    path.join(cli, 'resources/code-graph/query.scm'),
    `query-${version}`,
  );
  await write(
    path.join(cli, 'node_modules/web-tree-sitter/package.json'),
    '{}',
  );
  await write(
    path.join(cli, 'node_modules/web-tree-sitter/index.js'),
    `parser-${version}`,
  );
  await write(
    path.join(cli, 'node_modules/web-tree-sitter/parser.wasm'),
    `parser-wasm-${version}`,
  );
  await write(path.join(cli, 'node_modules/typescript/package.json'), '{}');
  await write(
    path.join(cli, 'node_modules/typescript/index.js'),
    `typescript-${version}`,
  );
  await write(path.join(cli, 'LICENSE'), `license-${version}`);
  await write(
    path.join(
      packaged ? path.join(gui, 'resources') : cli,
      'THIRD_PARTY_NOTICES.txt',
    ),
    `notices-${version}`,
  );
}

async function installedRoot(): Promise<string> {
  const status = await installer().getStatus();
  if (!status.symlinkPath) throw new Error('Expected launcher');
  return path.dirname(await fs.realpath(status.symlinkPath));
}

beforeEach(async () => {
  root = await fs.realpath(
    await fs.mkdtemp(path.join(tmpdir(), 'canopy-linux-cli-')),
  );
  home = path.join(root, 'home');
  gui = path.join(root, 'fake GUI install');
  await fs.mkdir(home);
  await distribution('v1');
});

afterEach(async () => {
  jest.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

describe('Linux complete per-user CLI install', () => {
  it('composes the actual split packaged CLI, sibling tools and notices without changing PATH', async () => {
    // build-cli stages only the SEA/resources/modules in resources/cli;
    // builder maps .cache/bin separately and puts notices at resources root.
    const cliEntries = await fs.readdir(path.dirname(bundledCliPath));
    expect(cliEntries).not.toContain('codex');
    expect(cliEntries).not.toContain('THIRD_PARTY_NOTICES.txt');
    const env = { PATH: '/usr/bin:/bin' };
    expect(await installer(env).getStatus()).toMatchObject({
      state: 'missing',
      managedPathEntry: path.join(home, '.local/bin'),
    });
    expect(await installer(env).install()).toEqual({
      success: true,
      error: null,
    });
    const copied = await installedRoot();
    expect(copied).toContain(
      path.join(home, '.local/share', BRAND.cliName, 'cli/versions'),
    );
    expect((await fs.stat(copied)).mode & 0o777).toBe(0o700);
    for (const tool of [BRAND.cliName, ...TOOLS, DAEMON]) {
      expect((await fs.stat(path.join(copied, tool))).mode & 0o777).toBe(0o755);
    }
    for (const file of [
      DAEMON,
      `${DAEMON}.identity.json`,
      'w5-commit-log-worker.js',
      'node-pty/package.json',
      'node-pty/build/Release/pty.node',
    ]) {
      expect(await fs.readFile(path.join(copied, file))).toEqual(
        await fs.readFile(path.join(gui, 'resources/bin', file)),
      );
    }
    expect(await fs.readFile(path.join(copied, 'LICENSE'), 'utf8')).toBe(
      'license-v1',
    );
    expect(
      await fs.readFile(path.join(copied, 'THIRD_PARTY_NOTICES.txt'), 'utf8'),
    ).toBe('notices-v1');
    expect(env).toEqual({ PATH: '/usr/bin:/bin' });
    expect(await fs.readdir(home)).toEqual(['.local']);
    expect(await installer(env).getStatus()).toMatchObject({
      state: 'correct-symlink',
      managedPathEntry: path.join(home, '.local/bin'),
    });
  });

  it('persists current and outdated status across fresh services and package upgrades', async () => {
    expect((await installer().install()).success).toBe(true);
    expect((await installer().getStatus()).state).toBe('correct-symlink');
    const old = await installedRoot();
    await fs.rm(gui, { recursive: true });
    // The installed CLI remains usable independently of the GUI package.
    expect((await installer().getStatus()).state).toBe('correct-symlink');
    await distribution('v2');
    expect((await installer().getStatus()).state).toBe('outdated');
    expect(await installedRoot()).toBe(old);
    expect((await installer().install()).success).toBe(true);
    expect((await installer().getStatus()).state).toBe('correct-symlink');
    expect(await installedRoot()).not.toBe(old);
    expect(await fs.readFile(path.join(old, 'LICENSE'), 'utf8')).toBe(
      'license-v1',
    );
  });

  it('detects a companion-only package upgrade and can remove an outdated launcher', async () => {
    expect((await installer().install()).success).toBe(true);
    await fs.writeFile(path.join(gui, 'resources/bin/rg'), 'updated-rg');
    expect((await installer().getStatus()).state).toBe('outdated');
    expect((await installer().uninstall()).success).toBe(true);
    expect((await installer().getStatus()).state).toBe('missing');
  });

  it('detects a daemon-only upgrade and retains the old daemon generation on refresh', async () => {
    const daemon = path.join(gui, 'resources/bin', DAEMON);
    const timestamp = 1_700_000_000;
    await fs.utimes(daemon, timestamp, timestamp);
    expect((await installer().install()).success).toBe(true);
    const old = await installedRoot();
    await fs.writeFile(daemon, 'daemon-v2');
    await fs.utimes(daemon, timestamp, timestamp);
    expect((await installer().getStatus()).state).toBe('outdated');
    expect((await installer().install()).success).toBe(true);
    expect((await installer().getStatus()).state).toBe('correct-symlink');
    expect(await fs.readFile(path.join(old, DAEMON), 'utf8')).toBe('daemon-v1');
    expect(
      await fs.readFile(path.join(await installedRoot(), DAEMON), 'utf8'),
    ).toBe('daemon-v2');
  });

  it('refuses a split package missing its daemon before publishing a generation', async () => {
    await fs.unlink(path.join(gui, 'resources/bin', DAEMON));
    expect(await installer().install()).toEqual({
      success: false,
      error: `Incomplete CLI distribution: ${DAEMON}`,
    });
    expect((await installer().getStatus()).state).toBe('missing');
    expect(
      await fs.readdir(
        path.join(home, '.local/share', BRAND.cliName, 'cli/versions'),
      ),
    ).toEqual([]);
  });

  it.each([
    `${DAEMON}.identity.json`,
    'w5-commit-log-worker.js',
    'node-pty/package.json',
    'node-pty/build/Release/pty.node',
  ])('refuses a package missing the daemon dependency %s', async (file) => {
    await fs.unlink(path.join(gui, 'resources/bin', file));
    expect((await installer().install()).success).toBe(false);
    expect((await installer().getStatus()).state).toBe('missing');
  });

  it('refuses a non-executable daemon', async () => {
    await fs.chmod(path.join(gui, 'resources/bin', DAEMON), 0o644);
    expect(await installer().install()).toEqual({
      success: false,
      error: `Incomplete CLI distribution: ${DAEMON}`,
    });
    expect((await installer().getStatus()).state).toBe('missing');
  });

  it('keeps the published version when the package changes during an update', async () => {
    expect((await installer().install()).success).toBe(true);
    const old = await installedRoot();
    await fs.rm(gui, { recursive: true });
    await distribution('v2');
    const original = fs.open;
    let changed = false;
    jest
      .spyOn(fs, 'open')
      .mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        if (
          !changed &&
          String(args[0]) ===
            path.join(path.dirname(bundledCliPath), 'LICENSE') &&
          args[1] === (constants.O_RDONLY | constants.O_NOFOLLOW)
        ) {
          changed = true;
          await fs.writeFile(
            path.join(gui, 'resources/bin/rg'),
            'mid-copy-package-change',
          );
        }
        return original(...args);
      });
    expect(await installer().install()).toEqual({
      success: false,
      error: 'CLI package changed during installation. Try again.',
    });
    expect(await installedRoot()).toBe(old);
    expect((await installer().getStatus()).state).toBe('outdated');
  });

  it('removes an owned launcher even when the GUI package is incomplete', async () => {
    expect((await installer().install()).success).toBe(true);
    await fs.unlink(path.join(gui, 'resources/bin/rg'));
    expect(await installer().uninstall()).toEqual({
      success: true,
      error: null,
    });
    expect((await installer().getStatus()).state).toBe('missing');
  });

  it('detects same-size package replacements even when build mtimes are preserved', async () => {
    const tool = path.join(gui, 'resources/bin/rg');
    const timestamp = 1_700_000_000;
    await fs.utimes(tool, timestamp, timestamp);
    expect((await installer().install()).success).toBe(true);
    await fs.writeFile(tool, 'rg-v2');
    await fs.utimes(tool, timestamp, timestamp);
    expect((await installer().getStatus()).state).toBe('outdated');
  });

  it.each([
    `resources/cli/${BRAND.cliName}`,
    'resources/bin/rg',
    'resources/THIRD_PARTY_NOTICES.txt',
    'resources/cli/resources/code-graph/parser.wasm',
    'resources/cli/resources/code-graph/query.scm',
    'resources/cli/node_modules/web-tree-sitter/index.js',
    'resources/cli/node_modules/typescript/package.json',
    `resources/bin/${DAEMON}`,
    `resources/bin/${DAEMON}.identity.json`,
    'resources/bin/w5-commit-log-worker.js',
    'resources/bin/node-pty/package.json',
    'resources/bin/node-pty/build/Release/pty.node',
  ])(
    'keeps an owned CLI removable when a package asset is truncated (%s)',
    async (asset) => {
      expect((await installer().install()).success).toBe(true);
      expect((await installer().getStatus()).state).toBe('correct-symlink');
      await fs.truncate(path.join(gui, asset), 0);
      expect((await installer().getStatus()).state).toBe('correct-symlink');
      expect((await installer().install()).success).toBe(false);
      expect((await installer().uninstall()).success).toBe(true);
      expect((await installer().getStatus()).state).toBe('missing');
    },
  );

  it('keeps installed status across source metadata changes unrelated to package contents', async () => {
    expect((await installer().install()).success).toBe(true);
    await fs.chmod(bundledCliPath, 0o750);
    await fs.chmod(path.dirname(bundledCliPath), 0o750);
    expect((await installer().getStatus()).state).toBe('correct-symlink');
  });

  it.each([
    'missing-tools',
    'mixed-layout',
    'source-symlink',
    'reserved-receipt',
  ])(
    'keeps independent status and removal usable with an invalid GUI (%s)',
    async (kind) => {
      expect((await installer().install()).success).toBe(true);
      if (kind === 'missing-tools')
        await fs.rm(path.join(gui, 'resources/bin'), { recursive: true });
      if (kind === 'mixed-layout')
        await write(
          path.join(path.dirname(bundledCliPath), 'rg'),
          'partial-tool',
          0o755,
        );
      if (kind === 'source-symlink') {
        const source = path.join(gui, 'resources/bin/rg');
        await fs.unlink(source);
        await fs.symlink(path.join(gui, 'resources/bin/gh'), source);
      }
      if (kind === 'reserved-receipt')
        await write(
          path.join(path.dirname(bundledCliPath), '.cli-install.json'),
          '{}',
        );
      expect((await installer().getStatus()).state).toBe('correct-symlink');
      expect((await installer().install()).success).toBe(false);
      expect((await installer().uninstall()).success).toBe(true);
    },
  );

  it('offers a safe refresh for an older receipt without package identity', async () => {
    expect((await installer().install()).success).toBe(true);
    await fs.writeFile(
      path.join(await installedRoot(), '.cli-install.json'),
      JSON.stringify({ version: 1, cliName: BRAND.cliName }),
    );
    expect((await installer().getStatus()).state).toBe('outdated');
    expect((await installer().install()).success).toBe(true);
    expect((await installer().getStatus()).state).toBe('correct-symlink');
  });

  it('installs an extracted flat archive and honors absolute XDG locations with spaces', async () => {
    await fs.rm(gui, { recursive: true });
    await distribution('flat', false);
    const env = {
      XDG_DATA_HOME: path.join(root, 'data with spaces'),
      XDG_BIN_HOME: path.join(root, 'bin with spaces'),
    };
    expect(await installer(env).install()).toEqual({
      success: true,
      error: null,
    });
    const status = await installer(env).getStatus();
    expect(status.managedPathEntry).toBe(env.XDG_BIN_HOME);
    const { stdout } = await execFileAsync(
      path.join(env.XDG_BIN_HOME, BRAND.cliName),
      [],
    );
    expect(JSON.parse(stdout)).toMatchObject({
      version: 'flat',
      wasm: 'wasm-flat',
      module: 'typescript-flat',
      tool: 'rg-flat',
    });
  });

  it('preserves a complete resources/cli tree without overwriting existing sibling members', async () => {
    const cli = path.dirname(bundledCliPath);
    for (const member of [
      ...TOOLS,
      ...DAEMON_COMPANIONS,
      'THIRD_PARTY_NOTICES.txt',
    ]) {
      const parent =
        member === 'THIRD_PARTY_NOTICES.txt'
          ? path.join(gui, 'resources')
          : path.join(gui, 'resources/bin');
      await fs.rename(path.join(parent, member), path.join(cli, member));
    }
    await fs.rm(path.join(gui, 'resources/bin'), { recursive: true });
    expect(await installer().install()).toEqual({ success: true, error: null });
    const copied = await installedRoot();
    expect(await fs.readFile(path.join(copied, 'rg'), 'utf8')).toBe('rg-v1');
    expect(
      await fs.readFile(path.join(copied, 'THIRD_PARTY_NOTICES.txt'), 'utf8'),
    ).toBe('notices-v1');
  });

  it('refuses a flat resources/cli tree missing only the daemon instead of mixing sources', async () => {
    const cli = path.dirname(bundledCliPath);
    for (const member of [
      ...TOOLS,
      ...DAEMON_COMPANIONS,
      'THIRD_PARTY_NOTICES.txt',
    ]) {
      const parent =
        member === 'THIRD_PARTY_NOTICES.txt'
          ? path.join(gui, 'resources')
          : path.join(gui, 'resources/bin');
      await fs.rename(path.join(parent, member), path.join(cli, member));
    }
    // A valid sibling daemon must not conceal an incomplete in-place tree.
    await fs.rename(
      path.join(cli, DAEMON),
      path.join(gui, 'resources/bin', DAEMON),
    );
    expect(await installer().install()).toEqual({
      success: false,
      error: 'Incomplete in-place CLI distribution.',
    });
    expect((await installer().getStatus()).state).toBe('missing');
  });

  it('rejects a partial in-place distribution instead of mixing companion sources', async () => {
    await write(
      path.join(path.dirname(bundledCliPath), 'rg'),
      'stale-rg',
      0o755,
    );
    const result = await installer().install();
    expect(result.success).toBe(false);
    expect(result.error).toContain('Incomplete in-place CLI distribution');
    expect((await installer().getStatus()).state).toBe('missing');
  });

  it.each(['XDG_DATA_HOME', 'XDG_BIN_HOME'])(
    'rejects relative %s without writing user files',
    async (key) => {
      const result = await installer({ [key]: 'relative/path' }).install();
      expect(result.success).toBe(false);
      expect(result.error).toContain('absolute path');
      expect(await fs.readdir(home)).toEqual([]);
    },
  );

  it.each(['file', 'symlink'])(
    'never overwrites or uninstalls an unrelated command (%s)',
    async (kind) => {
      const command = path.join(home, '.local/bin', BRAND.cliName);
      await fs.mkdir(path.dirname(command), { recursive: true });
      const unrelated = path.join(root, 'unrelated');
      await write(unrelated, 'do not touch');
      if (kind === 'file') await write(command, 'other command');
      else await fs.symlink(unrelated, command);
      expect(await installer().install()).toMatchObject({ success: false });
      expect(await installer().uninstall()).toMatchObject({ success: false });
      expect(await fs.readFile(command, 'utf8')).toBe(
        kind === 'file' ? 'other command' : 'do not touch',
      );
      expect(await fs.readFile(unrelated, 'utf8')).toBe('do not touch');
    },
  );

  it.each(['bin', 'data'])(
    'rejects a symlink in the target %s ancestors without writing through it',
    async (kind) => {
      const outside = path.join(root, 'outside');
      await fs.mkdir(outside);
      const alias = path.join(root, 'alias');
      await fs.symlink(outside, alias);
      const env =
        kind === 'bin'
          ? { XDG_BIN_HOME: path.join(alias, 'bin') }
          : { XDG_DATA_HOME: path.join(alias, 'data') };
      const result = await installer(env).install();
      expect(result.success).toBe(false);
      expect(result.error).toContain('symlink');
      expect(await fs.readdir(outside)).toEqual([]);
    },
  );

  it('rejects an escaping source asset symlink and leaves no published launcher', async () => {
    const asset = path.join(
      path.dirname(bundledCliPath),
      'resources/code-graph/parser.wasm',
    );
    const outside = path.join(root, 'outside.wasm');
    await write(outside, 'outside');
    await fs.unlink(asset);
    await fs.symlink(outside, asset);
    const result = await installer().install();
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unsafe CLI distribution member');
    expect((await installer().getStatus()).state).toBe('missing');
    expect(await fs.readFile(outside, 'utf8')).toBe('outside');
    expect(
      await fs.readdir(
        path.join(home, '.local/share', BRAND.cliName, 'cli/versions'),
      ),
    ).toEqual([]);
  });

  it.each(['bin/codex', 'THIRD_PARTY_NOTICES.txt'])(
    'rejects an escaping packaged sibling symlink (%s) before publication',
    async (member) => {
      const source = path.join(gui, 'resources', member);
      const outside = path.join(root, 'outside');
      await write(outside, 'outside must not be copied');
      await fs.unlink(source);
      await fs.symlink(outside, source);
      const result = await installer().install();
      expect(result.success).toBe(false);
      expect(result.error).toContain('Unsafe CLI distribution member');
      expect((await installer().getStatus()).state).toBe('missing');
      expect(await fs.readFile(outside, 'utf8')).toBe(
        'outside must not be copied',
      );
      expect(
        await fs.readdir(
          path.join(home, '.local/share', BRAND.cliName, 'cli/versions'),
        ),
      ).toEqual([]);
    },
  );

  it('rejects a symlink ancestor of packaged sibling tools', async () => {
    const bin = path.join(gui, 'resources/bin');
    const outside = path.join(root, 'outside-bin');
    await fs.rename(bin, outside);
    await fs.symlink(outside, bin);
    const result = await installer().install();
    expect(result.success).toBe(false);
    expect(result.error).toContain('symlink');
    expect((await installer().getStatus()).state).toBe('missing');
    expect(await fs.readFile(path.join(outside, 'rg'), 'utf8')).toBe('rg-v1');
  });

  it('refuses a forged private version pointer instead of treating any link as owned', async () => {
    expect((await installer().install()).success).toBe(true);
    const current = path.join(
      home,
      '.local/share',
      BRAND.cliName,
      'cli/current',
    );
    await fs.unlink(current);
    await fs.symlink(gui, current);
    const result = await installer().install();
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unmanaged CLI version pointer');
    expect(await installer().uninstall()).toMatchObject({ success: false });
    expect(await fs.readlink(current)).toBe(gui);
  });

  it.each(['parser.wasm', 'codex'])(
    'keeps the old version when a later %s copy is interrupted',
    async (member) => {
      expect((await installer().install()).success).toBe(true);
      const old = await installedRoot();
      await fs.rm(gui, { recursive: true });
      await distribution('v2');
      const original = fs.open;
      jest
        .spyOn(fs, 'open')
        .mockImplementation(async (...args: Parameters<typeof fs.open>) => {
          if (
            String(args[0]).endsWith(member) &&
            (member === 'codex'
              ? args[1] === 'wx'
              : args[1] === (constants.O_RDONLY | constants.O_NOFOLLOW))
          ) {
            if (member === 'codex') {
              const partial = await original(...args);
              await partial.writeFile('partial companion copy');
              await partial.close();
            }
            throw new Error('simulated interrupted copy');
          }
          return original(...args);
        });
      expect(await installer().install()).toEqual({
        success: false,
        error: 'simulated interrupted copy',
      });
      expect(await installedRoot()).toBe(old);
      expect(await fs.readdir(path.dirname(old))).toEqual([path.basename(old)]);
      const { stdout } = await execFileAsync(
        path.join(home, '.local/bin', BRAND.cliName),
        [],
      );
      expect(JSON.parse(stdout)).toMatchObject({
        version: 'v1',
        wasm: 'wasm-v1',
      });
    },
  );

  it('does not publish an incomplete distribution missing a required companion', async () => {
    await fs.unlink(path.join(gui, 'resources/bin/codex-code-mode-host'));
    expect(await installer().install()).toMatchObject({ success: false });
    expect((await installer().getStatus()).state).toBe('missing');
  });

  it('rejects an empty required parser asset before publication', async () => {
    await fs.writeFile(
      path.join(
        path.dirname(bundledCliPath),
        'resources/code-graph/parser.wasm',
      ),
      '',
    );
    const result = await installer().install();
    expect(result.success).toBe(false);
    expect(result.error).toContain('Incomplete CLI resource');
    expect((await installer().getStatus()).state).toBe('missing');
  });

  it('preserves an unrelated command introduced while the distribution is copying', async () => {
    const launcher = path.join(home, '.local/bin', BRAND.cliName);
    const original = fs.open;
    let introduced = false;
    jest
      .spyOn(fs, 'open')
      .mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        if (
          !introduced &&
          String(args[0]) ===
            path.join(path.dirname(bundledCliPath), 'LICENSE') &&
          args[1] === (constants.O_RDONLY | constants.O_NOFOLLOW)
        ) {
          introduced = true;
          await write(launcher, 'racing unrelated command');
        }
        return original(...args);
      });
    expect(await installer().install()).toMatchObject({ success: false });
    expect(introduced).toBe(true);
    expect(await fs.readFile(launcher, 'utf8')).toBe(
      'racing unrelated command',
    );
  });

  it('survives GUI upgrade/removal and preserves a live owned companion across upgrade AND uninstall', async () => {
    expect((await installer().install()).success).toBe(true);
    const old = await installedRoot();
    const launcher = path.join(home, '.local/bin', BRAND.cliName);
    const originalLink = await fs.readlink(launcher);
    const child = spawn(launcher, ['--watch'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const exited = once(child, 'exit');
    const reader = createInterface({ input: child.stdout });
    const lines = reader[Symbol.asyncIterator]();
    const probe = async (): Promise<void> => {
      child.stdin.write('probe\n');
      const line = await lines.next();
      if (line.done) throw new Error('Owned CLI/companion exited early');
      expect(JSON.parse(line.value)).toMatchObject({
        version: 'v1',
        companion: true,
        root: old,
        wasm: 'wasm-v1',
        module: 'typescript-v1',
        tool: 'rg-v1',
      });
    };
    try {
      expect((await lines.next()).value).toBe('ready');
      // Replace the fake deb GUI installation while its installed CLI is live.
      await fs.rm(gui, { recursive: true });
      await distribution('v2');
      expect((await installer().install()).success).toBe(true);
      expect(await installedRoot()).not.toBe(old);
      expect(await fs.readlink(launcher)).toBe(originalLink);
      await probe();
      await fs.rm(gui, { recursive: true });
      const { stdout } = await execFileAsync(launcher, []);
      expect(JSON.parse(stdout)).toMatchObject({
        version: 'v2',
        wasm: 'wasm-v2',
        module: 'typescript-v2',
        tool: 'rg-v2',
      });
      expect(await installer().uninstall()).toEqual({
        success: true,
        error: null,
      });
      expect((await installer().getStatus()).state).toBe('missing');
      await probe();
      expect(
        await fs.readFile(
          path.join(old, 'resources/code-graph/parser.wasm'),
          'utf8',
        ),
      ).toBe('wasm-v1');
      expect(await fs.readdir(path.dirname(old))).toHaveLength(2);
      expect(await installer().uninstall()).toEqual({
        success: true,
        error: null,
      });
    } finally {
      child.stdin.end();
      reader.close();
      await exited;
    }
  }, 15000);
});
