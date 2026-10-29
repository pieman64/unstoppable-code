#!/usr/bin/env node
// Opt-in check of the delegated Codex sandbox profiles against the bundled
// Codex binary (macOS Seatbelt). Not part of any default npm script.
//
// Run: node --import tsx apps/desktop-app/tests/electron/verify-delegation-codex-sandbox.mjs
//
// Builds `delegated_read_only` and `delegated_write` with the production
// profile builder, writes them to a temporary CODEX_HOME (never the user's),
// and runs shell probes through `codex sandbox -P <profile>`. It checks that a
// whole-worktree (`.`) grant and a single-file grant are writable only under
// `delegated_write`, and that private names, nested repositories and the
// repository's Git metadata stay denied or read-only under both profiles.
//
// It also starts the bundled app-server (temporary CODEX_HOME, an unreachable
// loopback provider) to check that a thread selects either profile from its
// thread config, which is how the runner chooses one per run. It reports
// whether `turn/start` accepts a profile: the pinned runtime rejects it
// because it reloads the configuration stack without the thread's profiles.
// No model call, network access or real credential is involved.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import readline from 'node:readline';
import { existsSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import profileModule from '../../src/main/agents/delegation/codex-sandbox-profile.ts';

const { buildCodexDelegationPermissionProfiles } = profileModule;
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);

if (process.platform !== 'darwin') {
  process.stdout.write(
    'Skipped: the Seatbelt sandbox check runs on macOS only.\n',
  );
  process.exit(0);
}
const codex = path.join(root, '.cache/bin', `darwin-${process.arch}`, 'codex');
if (!existsSync(codex)) {
  process.stderr.write(`Missing bundled Codex binary: ${codex}\n`);
  process.exit(1);
}

/** TOML basic strings accept JSON string escapes for these paths. */
const tomlKey = (value) => JSON.stringify(value);

function profileToml(name, profile) {
  const lines = [`[permissions.${name}.filesystem]`];
  for (const [entry, access] of Object.entries(profile.filesystem))
    lines.push(`${tomlKey(entry)} = ${tomlKey(access)}`);
  lines.push(`[permissions.${name}.network]`, 'enabled = false', '');
  return lines.join('\n');
}

const temporary = await realpath(
  await mkdtemp(path.join(tmpdir(), 'codex-delegation-sandbox-')),
);
const failures = [];
let checks = 0;
try {
  const cwd = path.join(temporary, 'worktree');
  const outside = path.join(temporary, 'outside');
  const scratch = path.join(temporary, 'tmpdir');
  const codexHome = path.join(temporary, 'codex-home');
  await Promise.all(
    [cwd, outside, scratch, codexHome].map((dir) =>
      mkdir(dir, { recursive: true }),
    ),
  );
  execFileSync('git', ['init', '--quiet', cwd]);
  execFileSync('git', ['init', '--quiet', path.join(cwd, 'nested')]);
  const files = {
    'notes.txt': 'notes\n',
    'src/file.ts': 'source\n',
    '.env': 'SECRET=1\n',
    '.npmrc': 'token\n',
    'sub/.env.local': 'SECRET=2\n',
    'certs/key.pem': 'pem\n',
    '.claude/settings.json': '{}\n',
  };
  for (const [relative, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(cwd, relative)), { recursive: true });
    await writeFile(path.join(cwd, relative), content);
  }
  await writeFile(path.join(outside, 'file.txt'), 'outside\n');

  const run = (profile, script) =>
    spawnSync(
      codex,
      ['sandbox', '-P', profile, '-C', cwd, '--', '/bin/sh', '-c', script],
      {
        cwd,
        encoding: 'utf8',
        env: {
          PATH: '/usr/bin:/bin',
          HOME: process.env.HOME,
          CODEX_HOME: codexHome,
          TMPDIR: scratch,
        },
      },
    );
  const expectResult = (label, profile, script, allowed) => {
    checks += 1;
    const result = run(profile, script);
    const succeeded = result.status === 0;
    if (succeeded !== allowed)
      failures.push(
        `${label} [${profile}]: expected ${allowed ? 'allowed' : 'denied'}, exit ${result.status}: ${(result.stderr || result.stdout || '').trim().slice(0, 300)}`,
      );
  };

  const scenarios = [
    { name: 'whole-worktree grant', writePaths: [cwd] },
    { name: 'single-file grant', writePaths: [path.join(cwd, 'notes.txt')] },
  ];
  for (const scenario of scenarios) {
    const profiles = buildCodexDelegationPermissionProfiles({
      cwd,
      writePaths: scenario.writePaths,
      gitRoots: [path.join(cwd, '.git')],
      gitPrivateRoots: [],
      temporaryDirectory: scratch,
    });
    await writeFile(
      path.join(codexHome, 'config.toml'),
      Object.entries(profiles)
        .map(([name, profile]) => profileToml(name, profile))
        .join('\n'),
    );
    const label = (text) => `${scenario.name}: ${text}`;
    const whole = scenario.name === 'whole-worktree grant';
    // The grant: writable under the write profile only.
    expectResult(
      label('append to notes.txt'),
      'delegated_write',
      'echo x >> notes.txt',
      true,
    );
    expectResult(
      label('append to notes.txt'),
      'delegated_read_only',
      'echo x >> notes.txt',
      false,
    );
    expectResult(
      label('create src/new.ts'),
      'delegated_write',
      'echo x > src/new.ts',
      whole,
    );
    expectResult(
      label('create src/new.ts'),
      'delegated_read_only',
      'echo x > src/new.ts',
      false,
    );
    // The private TMPDIR is writable under both.
    for (const profile of ['delegated_write', 'delegated_read_only'])
      expectResult(
        label('write TMPDIR'),
        profile,
        `echo x > "${scratch}/t.txt"`,
        true,
      );
    // Denied or read-only under both profiles, whatever the grant.
    for (const profile of ['delegated_write', 'delegated_read_only']) {
      expectResult(label('read .env'), profile, 'cat .env', false);
      expectResult(label('write .env'), profile, 'echo x >> .env', false);
      expectResult(label('write .npmrc'), profile, 'echo x >> .npmrc', false);
      expectResult(
        label('write sub/.env.local'),
        profile,
        'echo x >> sub/.env.local',
        false,
      );
      expectResult(
        label('read certs/key.pem'),
        profile,
        'cat certs/key.pem',
        false,
      );
      expectResult(
        label('write certs/key.pem'),
        profile,
        'echo x >> certs/key.pem',
        false,
      );
      expectResult(
        label('write .claude/settings.json'),
        profile,
        'echo x >> .claude/settings.json',
        false,
      );
      expectResult(label('read .git/HEAD'), profile, 'cat .git/HEAD', true);
      expectResult(
        label('write .git/config'),
        profile,
        'echo x >> .git/config',
        false,
      );
      expectResult(
        label('create .git/new'),
        profile,
        'echo x > .git/new',
        false,
      );
      expectResult(
        label('read nested/.git/HEAD'),
        profile,
        'cat nested/.git/HEAD',
        false,
      );
      expectResult(
        label('write nested/.git/config'),
        profile,
        'echo x >> nested/.git/config',
        false,
      );
      expectResult(
        label('write outside the worktree'),
        profile,
        `echo x >> "${outside}/file.txt"`,
        false,
      );
    }
  }
  const env = await readFile(path.join(cwd, '.env'), 'utf8');
  if (env !== files['.env']) failures.push('.env changed on disk');

  // Profile selection through the app-server thread config.
  await writeFile(
    path.join(codexHome, 'config.toml'),
    [
      'model_provider = "unreachable"',
      '[model_providers.unreachable]',
      'name = "unreachable"',
      'base_url = "http://127.0.0.1:9/v1"',
      'wire_api = "responses"',
      'request_max_retries = 0',
      'stream_max_retries = 0',
      '',
    ].join('\n'),
  );
  const server = spawn(codex, ['app-server'], {
    cwd,
    env: {
      PATH: '/usr/bin:/bin',
      HOME: process.env.HOME,
      CODEX_HOME: codexHome,
      TMPDIR: scratch,
    },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  try {
    let nextId = 0;
    const pending = new Map();
    readline.createInterface({ input: server.stdout }).on('line', (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      const settle = pending.get(message.id);
      if (message.method === undefined && settle) {
        pending.delete(message.id);
        settle(message);
      }
    });
    const request = (method, params) =>
      new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(
          () => reject(new Error(`${method} timed out`)),
          20_000,
        );
        pending.set(id, (message) => {
          clearTimeout(timer);
          resolve(message);
        });
        server.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      });
    await request('initialize', {
      clientInfo: { name: 'verify-codex-delegation-sandbox', version: '1' },
      capabilities: { experimentalApi: true },
    });
    server.stdin.write(
      `${JSON.stringify({ method: 'initialized', params: {} })}\n`,
    );
    const profiles = buildCodexDelegationPermissionProfiles({
      cwd,
      writePaths: [path.join(cwd, 'notes.txt')],
      gitRoots: [path.join(cwd, '.git')],
      temporaryDirectory: scratch,
    });
    let threadId;
    for (const selected of ['delegated_write', 'delegated_read_only']) {
      checks += 1;
      const started = await request('thread/start', {
        cwd,
        model: 'unreachable-model',
        approvalPolicy: 'untrusted',
        permissions: selected,
        experimentalRawEvents: false,
        config: { permissions: profiles },
      });
      const active = started.result?.activePermissionProfile?.id;
      if (active !== selected)
        failures.push(
          `thread/start ${selected}: active profile ${active ?? JSON.stringify(started.error)}`,
        );
      threadId = started.result?.thread?.id;
    }
    const turn = await request('turn/start', {
      threadId,
      input: [{ type: 'text', text: 'probe', text_elements: [] }],
      permissions: 'delegated_write',
    });
    process.stdout.write(
      turn.error
        ? `turn/start profile selection is rejected by this runtime (${turn.error.message}); the runner selects the profile per thread.\n`
        : 'Note: turn/start now accepts a profile; per-turn selection may be possible.\n',
    );
  } finally {
    // Wait for the app-server to exit before its CODEX_HOME is removed.
    const exited = new Promise((resolve) => server.once('exit', resolve));
    server.kill();
    await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
  }
} finally {
  await rm(temporary, { recursive: true, force: true, maxRetries: 3 });
}

if (failures.length) {
  process.stderr.write(
    `Delegated Codex sandbox: ${failures.length} of ${checks} checks failed\n${failures.map((line) => `- ${line}`).join('\n')}\n`,
  );
  process.exit(1);
}
process.stdout.write(`Delegated Codex sandbox: all ${checks} checks passed\n`);
