import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import {
  createGitReadRunner,
  type GitReadOutput,
  type GitReadRequest,
} from '../git-read/runner';
import type { GitReadCommand } from '../git-read/commands';
import { evidenceRecorder } from './git-read-evidence';

// Real host commands, each on the only OS whose command set includes it.
const linux = process.platform === 'linux';
const darwin = process.platform === 'darwin';
const linuxDescribe = linux ? describe : describe.skip;
const darwinDescribe = darwin ? describe : describe.skip;
const evidence = evidenceRecorder('host-probes');

const AMBIENT_ONLY = 'CANOPY_GIT_READ_AMBIENT_ONLY';
const LINUX_PATH_MARKER = '__CANOPY_LOGIN_PATH__';
const LOGIN_MARKER = '/canopy-login-marker';
// ld.so reports a preload it cannot open, so a leaked LD_PRELOAD is visible.
const BOGUS_PRELOAD = '/nonexistent/canopy-git-read-preload.so';

let dir = '';

const lines = (text: string): string[] => text.split('\n').filter(Boolean);

function request(environment: Record<string, string>): GitReadRequest {
  return {
    cwd: dir,
    environment,
    deadlineAt: performance.now() + 20_000,
  };
}

/** Runs `command` with `AMBIENT_ONLY` set on this process only. */
async function runWithAmbient(
  os: 'darwin' | 'linux',
  command: GitReadCommand,
  environment: Record<string, string>,
): Promise<GitReadOutput> {
  const saved = process.env[AMBIENT_ONLY];
  process.env[AMBIENT_ONLY] = 'ambient';
  try {
    return await createGitReadRunner({ os }).run(command, request(environment)); // prettier-ignore
  } finally {
    if (saved === undefined) delete process.env[AMBIENT_ONLY];
    else process.env[AMBIENT_ONLY] = saved;
  }
}

/** A home whose login profiles prepend the marker and record what they saw. */
function profileHome(files: readonly string[]): string {
  const home = mkdtempSync(join(dir, 'home-'));
  const profile = [
    `export PATH="${LOGIN_MARKER}:$PATH"`,
    `printf '%s|%s\\n' "\${${AMBIENT_ONLY}-unset}" "\${CANOPY_SUPPLIED-unset}" > "$HOME/profile-ran"`,
  ].join('\n');
  for (const file of files) writeFileSync(join(home, file), `${profile}\n`);
  writeFileSync(join(home, 'env.sh'), ': > "$HOME/env-ran"\n');
  return home;
}

function profileSeen(home: string): string | null {
  const file = join(home, 'profile-ran');
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}

beforeAll(() => {
  dir = mkdtempSync(join(realpathSync(tmpdir()), 'git-read-probes-'));
});

afterAll(() => {
  evidence.flush();
  rmSync(dir, { recursive: true, force: true });
});

linuxDescribe('native Linux probes (requires process.platform linux)', () => {
  jest.setTimeout(60_000);
  const probeEnv = (
    extra: Record<string, string> = {},
  ): Record<string, string> => ({
    // prettier-ignore
    PATH: '/usr/bin:/bin',
    HOME: dir,
    LANG: 'C',
    LD_PRELOAD: BOGUS_PRELOAD,
    ...extra,
  });

  it('getent passwd <uid> returns this account without the supplied LD_PRELOAD', async () => {
    const uid = process.getuid?.() ?? -1;
    const output = await createGitReadRunner({ os: 'linux' }).run(
      { kind: 'getent-passwd', uid },
      request(probeEnv()),
    );
    // Control: the same environment, unfiltered, makes ld.so complain.
    const control = spawnSync('/usr/bin/getent', ['passwd', String(uid)], {
      env: probeEnv(),
      encoding: 'utf8',
    });
    const fields = output.stdout.trimEnd().split(':');
    const account = userInfo();
    evidence.record('getent: own uid', {
      code: output.code,
      stderr: output.stderr,
      matchesUserInfo:
        fields[0] === account.username && fields[5] === account.homedir,
      controlSawPreload: control.stderr.includes('LD_PRELOAD'),
    });
    expect(control.stderr).toContain('LD_PRELOAD');
    expect(output).toMatchObject({ code: 0, signal: null, stderr: '' });
    expect([fields[0], fields[2], fields[5]]).toEqual([
      account.username,
      String(uid),
      account.homedir,
    ]);
  });

  it('getent passwd exits 2 for an unknown uid', async () => {
    const output = await createGitReadRunner({ os: 'linux' }).run(
      { kind: 'getent-passwd', uid: 2_147_483_000 },
      request(probeEnv()),
    );
    evidence.record('getent: unknown uid', { code: output.code });
    expect(output).toMatchObject({ code: 2, stdout: '', stderr: '' });
  });

  it.each(['/bin/bash', '/bin/sh'])(
    '%s login-shell PATH probe matches the native shell with a sanitized environment',
    async (shell) => {
      const home = profileHome(['.profile']);
      // The runner's probe environment after linuxProbeEnvironment, run directly.
      const nativeShell = (script: string): SpawnSyncReturns<string> =>
        spawnSync(shell, ['-lic', script], {
          cwd: dir,
          env: {
            PATH: '/usr/bin:/bin',
            HOME: home,
            LANG: 'C',
            CANOPY_SUPPLIED: 'yes',
          },
          encoding: 'utf8',
          timeout: 10_000,
        });
      // System profiles may replace HOME before the shell reads .profile.
      const loginHome = nativeShell('exec /usr/bin/printf %s "$HOME"').stdout;
      rmSync(join(home, 'profile-ran'), { force: true });
      const control = nativeShell(
        `exec /usr/bin/printf '${LINUX_PATH_MARKER}%s\\n' "$PATH"`,
      );
      const controlProfile = profileSeen(home);
      rmSync(join(home, 'profile-ran'), { force: true });
      const output = await runWithAmbient(
        'linux',
        { kind: 'linux-login-shell-path', shell },
        probeEnv({ HOME: home, CANOPY_SUPPLIED: 'yes', ENV: join(home, 'env.sh') }), // prettier-ignore
      );
      const marked = lines(output.stdout).find((line) =>
        line.startsWith(LINUX_PATH_MARKER),
      );
      const entries = marked?.slice(LINUX_PATH_MARKER.length).split(':') ?? [];
      const first = entries[0];
      evidence.record(`login shell: ${shell}`, {
        resolved: realpathSync(shell),
        code: output.code,
        firstPathEntry: first ?? null,
        markerInPath: entries.includes(LOGIN_MARKER),
        matchesNativeShell: output.stdout === control.stdout,
        loginHome: loginHome === home ? 'supplied' : loginHome,
        profileSaw: profileSeen(home),
        controlProfileSaw: controlProfile,
        envFileRan: existsSync(join(home, 'env-ran')),
        stderrMentionsPreload: output.stderr.includes('LD_PRELOAD'),
      });
      expect(control.error).toBeUndefined();
      expect(control.status).toBe(0);
      expect(control.stdout).toContain(LINUX_PATH_MARKER);
      expect([null, 'unset|yes\n']).toContain(controlProfile);
      expect(output.code).toBe(0);
      expect(output.stdout).toBe(control.stdout);
      expect(profileSeen(home)).toBe(controlProfile);
      expect(existsSync(join(home, 'env-ran'))).toBe(false);
      expect(output.stderr).not.toContain('LD_PRELOAD');
    },
  );

  it('git --version runs under the probe environment', async () => {
    const output = await createGitReadRunner({ os: 'linux' }).run(
      { kind: 'git-version', executable: 'git' },
      request(probeEnv()),
    );
    evidence.record('git --version', {
      code: output.code,
      stdout: output.stdout.trim(),
      stderr: output.stderr,
    });
    expect(output).toMatchObject({ code: 0, stderr: '' });
    expect(output.stdout).toMatch(/^git version \d/);
  });
});

darwinDescribe('native macOS probes (requires process.platform darwin)', () => {
  jest.setTimeout(60_000);

  it('xcode-select --print-path names an existing developer directory', async () => {
    const output = await createGitReadRunner({ os: 'darwin' }).run(
      { kind: 'xcode-select-print-path' },
      request({ PATH: '/usr/bin:/bin', HOME: dir }),
    );
    const developer = output.stdout.trim();
    evidence.record('xcode-select', {
      code: output.code,
      exists: existsSync(developer),
    });
    expect(output.code).toBe(0);
    expect(existsSync(developer)).toBe(true);
  });

  it.each([['/bin/zsh'], ['/bin/bash'], [undefined]])(
    'login-shell PATH probe with SHELL=%s reads only the supplied environment',
    async (shell) => {
      const home = profileHome(['.zprofile', '.profile']);
      const output = await runWithAmbient(
        'darwin',
        { kind: 'macos-login-shell-path' },
        {
          PATH: '/usr/bin:/bin',
          HOME: home,
          CANOPY_SUPPLIED: 'yes',
          ...(shell ? { SHELL: shell } : {}),
        },
      );
      const first = lines(output.stdout).at(-1)?.split(':')[0];
      evidence.record(`login shell: ${shell ?? 'default'}`, {
        code: output.code,
        firstPathEntry: first ?? null,
        profileSaw: profileSeen(home),
      });
      expect(output.code).toBe(0);
      expect(first).toBe(LOGIN_MARKER);
      expect(profileSeen(home)).toBe('unset|yes\n');
    },
  );

  it('bare-init smoke runs real Git and removes its scratch directory', async () => {
    const root = join(dir, 'scratch');
    mkdirSync(root);
    const reported: unknown[] = [];
    const output = await createGitReadRunner({
      os: 'darwin',
      onScratchCleanupFailure: (error) => void reported.push(error),
    }).run(
      { kind: 'git-bare-init-smoke', executable: 'git', temporaryRoot: root },
      request({ PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir }),
    );
    evidence.record('bare-init smoke', {
      code: output.code,
      initialized: output.stdout.includes('Initialized empty Git repository'),
      left: readdirSync(root).length,
      reported: reported.length,
    });
    expect(output).toMatchObject({ code: 0, pipes: 'closed' });
    expect(output.stdout).toContain(`Initialized empty Git repository in ${root}/git-validation-`); // prettier-ignore
    expect(readdirSync(root)).toEqual([]);
    expect(reported).toEqual([]);
  });
});
