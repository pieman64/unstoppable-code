// CAN-3233: synthetic Git policy only. Never changes the host's Git config,
// keys, agent, or credential store; hashes host Git config only to prove it
// stays unchanged. Shared by Jest and Electron goldens.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import {
  appendFileSync,
  lstatSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const GIT_FAILURE_CASES = Object.freeze([
  'pre-commit-blocking',
  'pre-commit-hanging',
  'commit-msg-blocking',
  'commit-msg-hanging',
  'gpg-no-key',
  'missing-identity',
  'ssh-agent-missing',
  'ssh-agent-dead',
  'credential-helper-prompt',
]);

function shellQuote(value) {
  return `'${value.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`;
}

/** Bounded child with full descendant cleanup when a hook/helper hangs. */
function runFixtureCommand(
  command,
  args,
  { cwd, env, input, timeoutMs = 3000 },
) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (data) => (stdout += data));
    child.stderr.on('data', (data) => (stderr += data));
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          timeout: 2000,
          stdio: 'ignore',
        });
      } else {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch (error) {
          if (error.code !== 'ESRCH') throw error;
        }
      }
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, timedOut, stdout, stderr });
    });
    child.stdin.on('error', (error) => {
      if (error.code !== 'EPIPE') reject(error);
    });
    child.stdin.end(input);
  });
}

/**
 * Caller owns root and removes it after all app/child processes exit.
 * env is an override map for launchCanopy; runGit/runControl use the same map.
 */
export function createGitFailureFixture(root, scenario) {
  // Hash only, never print or return host Git config contents (which may
  // embed credentials). The digest also detects writes through a symlink.
  const hostPaths = [
    ...new Set([
      path.join(os.homedir(), '.gitconfig'),
      path.join(
        process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
        'git',
        'config',
      ),
      ...(process.env.GIT_CONFIG_GLOBAL ? [process.env.GIT_CONFIG_GLOBAL] : []),
    ]),
  ];
  const snapshotHostPolicy = () =>
    hostPaths.map((file) => {
      try {
        const stat = lstatSync(file);
        return {
          file,
          dev: stat.dev,
          ino: stat.ino,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          ctimeMs: stat.ctimeMs,
          sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
        };
      } catch (error) {
        if (error.code === 'ENOENT') return { file, absent: true };
        throw error;
      }
    });
  const originalHostPolicy = snapshotHostPolicy();
  assert.ok(GIT_FAILURE_CASES.includes(scenario), `Unknown case: ${scenario}`);
  mkdirSync(root, { recursive: true });
  const configPath = path.join(root, 'global.gitconfig');
  const invocationPath = path.join(root, 'invocations.jsonl');
  const tracePath = path.join(root, 'git.trace');
  const hooksPath = path.join(root, 'hooks');
  const xdg = path.join(root, 'xdg');
  const gnupg = path.join(root, 'gnupg');
  const home = path.join(root, 'home');
  const xdgDirs = ['cache', 'data', 'state', 'runtime'].map((name) =>
    path.join(xdg, name),
  );
  for (const dir of [hooksPath, xdg, gnupg, home, ...xdgDirs])
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(invocationPath, '');
  writeFileSync(tracePath, '');
  const env = {
    HOME: home,
    USERPROFILE: home,
    XDG_CACHE_HOME: xdgDirs[0],
    XDG_DATA_HOME: xdgDirs[1],
    XDG_STATE_HOME: xdgDirs[2],
    XDG_RUNTIME_DIR: xdgDirs[3],
    GIT_CONFIG_GLOBAL: configPath,
    GIT_CONFIG_SYSTEM: path.join(root, 'absent-system-config'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_COUNT: '0',
    GIT_CONFIG_PARAMETERS: '',
    GIT_AUTHOR_NAME: '',
    GIT_AUTHOR_EMAIL: '',
    GIT_COMMITTER_NAME: '',
    GIT_COMMITTER_EMAIL: '',
    EMAIL: '',
    XDG_CONFIG_HOME: xdg,
    GNUPGHOME: gnupg,
    GIT_TERMINAL_PROMPT: '0',
    GIT_TRACE: tracePath,
    // undefined removes inherited repository overrides from Electron's env.
    GIT_DIR: undefined,
    GIT_COMMON_DIR: undefined,
    GIT_WORK_TREE: undefined,
    GIT_INDEX_FILE: undefined,
    GIT_OBJECT_DIRECTORY: undefined,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
    GIT_NAMESPACE: undefined,
    GIT_CONFIG: undefined,
    SSH_AUTH_SOCK:
      scenario === 'ssh-agent-dead'
        ? path.join(root, 'dead-agent.sock')
        : undefined,
    SSH_AGENT_PID: '',
  };
  // Identity comes from Git config, not launchCanopy's default identity env.
  // Empty identity variables suppress Git's config fallback, so use the same
  // explicit fixture identity except in the genuinely missing-identity case.
  if (scenario !== 'missing-identity') {
    env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = 'Canopy Fixture';
    env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = 'fixture@example.invalid';
  }
  const config = [
    '[init]',
    '\tdefaultBranch = main',
    `\ttemplateDir = ${JSON.stringify(hooksPath)}`,
    '[core]',
    `\thooksPath = ${JSON.stringify(hooksPath)}`,
    '[user]',
    '\tuseConfigOnly = true',
    ...(scenario === 'missing-identity'
      ? []
      : ['\tname = Canopy Fixture', '\temail = fixture@example.invalid']),
  ];
  const helperPath = path.join(root, 'policy-helper.cjs');
  writeFileSync(
    helperPath,
    `const fs = require('node:fs');\n` +
      `const kind = process.argv[2];\n` +
      `fs.appendFileSync(${JSON.stringify(invocationPath)}, JSON.stringify({kind, args: process.argv.slice(3)}) + '\\n');\n` +
      `if (kind.endsWith('-hanging')) setInterval(() => {}, 1000);\n` +
      `else { console.error('fixture ' + kind + ': no usable key / prompt refused / hook blocked'); process.exit(1); }\n`,
  );
  function executable(name, kind) {
    const file = path.join(root, name);
    writeFileSync(
      file,
      `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(helperPath)} ${shellQuote(kind)} "$@"\n`,
      { mode: 0o755 },
    );
    return file;
  }
  if (
    scenario.startsWith('pre-commit-') ||
    scenario.startsWith('commit-msg-')
  ) {
    const hook = scenario.startsWith('pre-commit-')
      ? 'pre-commit'
      : 'commit-msg';
    // Shell builtins record entry before any slow Node startup; the control
    // timeout measures a genuinely held hook, not helper-launch contention.
    const marker = JSON.stringify({ kind: scenario, args: [] });
    writeFileSync(
      path.join(hooksPath, hook),
      `#!/bin/sh\nprintf '%s\\n' ${shellQuote(marker)} >> ${shellQuote(invocationPath)}\n${scenario.endsWith('-hanging') ? 'exec sleep 60' : 'exit 1'}\n`,
      { mode: 0o755 },
    );
  }
  if (scenario === 'gpg-no-key') {
    const signer = executable('gpg-without-key', scenario);
    config.push(
      '[commit]',
      '\tgpgSign = true',
      '[user]',
      '\tsigningKey = fixture-without-secret-key',
      '[gpg]',
      `\tprogram = ${JSON.stringify(signer)}`,
    );
  }
  if (scenario.startsWith('ssh-agent-')) {
    // Public-only synthetic key forces ssh-keygen signing to ask the agent.
    // The private half is removed before either app launch or user commit.
    const keyPath = path.join(root, 'synthetic-signing-identity');
    const generated = spawnSync(
      process.platform === 'win32' ? 'ssh-keygen' : '/usr/bin/ssh-keygen',
      ['-q', '-t', 'ed25519', '-N', '', '-f', keyPath],
      { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 3000 },
    );
    assert.equal(generated.status, 0, generated.stderr);
    unlinkSync(keyPath);
    const transport = executable('ssh-transport', `${scenario}-transport`);
    env.GIT_SSH_COMMAND = shellQuote(transport);
    env.GIT_SSH_VARIANT = 'ssh';
    config.push(
      '[commit]',
      '\tgpgSign = true',
      '[gpg]',
      '\tformat = ssh',
      '[user]',
      `\tsigningKey = ${JSON.stringify(`${keyPath}.pub`)}`,
    );
  }
  if (scenario === 'credential-helper-prompt') {
    const helper = executable('credential-helper', scenario);
    const askpass = executable('askpass', 'askpass-prompt');
    config.push(
      '[credential]',
      `\thelper = ${JSON.stringify('!' + shellQuote(helper))}`,
    );
    env.GIT_ASKPASS = askpass;
    env.SSH_ASKPASS = askpass;
  }
  writeFileSync(configPath, `${config.join('\n')}\n`);
  const originalConfig = readFileSync(configPath, 'utf8');
  const readInvocations = () =>
    readFileSync(invocationPath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  const runGit = (args, options = {}) =>
    runFixtureCommand(
      process.platform === 'win32' ? 'git' : '/usr/bin/git',
      args,
      {
        cwd: root,
        ...options,
        env: { ...process.env, ...env },
      },
    );

  async function runControl(repo = path.join(root, 'user-repository')) {
    mkdirSync(repo, { recursive: true });
    const initialized = await runGit(['init', '-q', repo]);
    assert.equal(initialized.status, 0, initialized.stderr);
    // No per-command hook/signing bypass: this is an ordinary user commit.
    const result = await runGit(
      ['commit', '--allow-empty', '-m', 'user commit'],
      {
        cwd: repo,
        timeoutMs: scenario.endsWith('-hanging') ? 1500 : 3000,
      },
    );
    if (scenario === 'credential-helper-prompt') {
      assert.equal(result.status, 0, result.stderr);
      // A real Git HTTP request must receive an authentication challenge before
      // consulting the isolated helper. No external service or credential store.
      const server = createServer((request, response) => {
        appendFileSync(
          invocationPath,
          JSON.stringify({
            kind: 'http-auth-challenge',
            args: [request.method, request.url],
          }) + '\n',
        );
        response.writeHead(401, {
          'WWW-Authenticate': 'Basic realm="can-3233-fixture"',
          Connection: 'close',
        });
        response.end('Fixture requires credentials\n');
      });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      try {
        const address = server.address();
        assert.ok(address && typeof address === 'object');
        // Disable inherited proxies for this loopback-only remote, without
        // changing the user's Git configuration or commit policy.
        const credentials = await runGit(
          [
            '-c',
            'http.proxy=',
            'ls-remote',
            `http://127.0.0.1:${address.port}/repo.git`,
          ],
          { cwd: repo },
        );
        assert.notEqual(credentials.status, 0);
        assert.equal(credentials.timedOut, false);
        assert.match(
          credentials.stderr,
          /could not read Username|Authentication failed/i,
        );
        const calls = readInvocations();
        const challenge = calls.findIndex(
          ({ kind, args }) =>
            kind === 'http-auth-challenge' &&
            args[0] === 'GET' &&
            args[1].startsWith('/repo.git/info/refs?'),
        );
        const helper = calls.findIndex(
          ({ kind, args }) => kind === scenario && args.includes('get'),
        );
        assert.ok(
          challenge >= 0,
          'Git must reach the HTTP authentication challenge',
        );
        assert.ok(
          helper > challenge,
          'HTTP challenge must invoke credential.helper get',
        );
        assert.ok(calls.some(({ kind }) => kind === 'askpass-prompt'));
        return credentials;
      } finally {
        server.closeAllConnections();
        await new Promise((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    }
    assert.notEqual(result.status, 0, result.stderr);
    assert.equal(result.timedOut, scenario.endsWith('-hanging'));
    if (scenario.startsWith('ssh-agent-')) {
      assert.match(result.stderr, /agent|sign|private key/i);
      const remote = await runGit(['ls-remote', 'ssh://fixture.invalid/repo']);
      assert.notEqual(remote.status, 0);
      assert.equal(remote.timedOut, false);
      assert.ok(
        readInvocations().some(({ kind }) => kind === `${scenario}-transport`),
      );
    } else if (scenario === 'missing-identity') {
      assert.match(result.stderr, /identity|empty ident|name|email/i);
    } else {
      assert.ok(readInvocations().some(({ kind }) => kind === scenario));
    }
    return result;
  }
  return {
    env,
    configPath,
    tracePath,
    readInvocations,
    runGit,
    runControl,
    assertPolicyUnchanged() {
      assert.equal(readFileSync(configPath, 'utf8'), originalConfig);
      assert.deepEqual(snapshotHostPolicy(), originalHostPolicy);
      assert.ok(!existsSync(path.join(gnupg, 'private-keys-v1.d')));
    },
    // Snapshot after startup to ignore unrelated app Git tool detection.
    readTrace: () => readFileSync(tracePath, 'utf8'),
  };
}
