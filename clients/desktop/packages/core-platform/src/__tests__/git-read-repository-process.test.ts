import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createGitReadRunner } from '../git-read/runner';
import type { GitReadCommand } from '../git-read/commands';

// CAN-5138: `ls-remote` contacts origin through ssh or a credential helper.
// The runner kills the whole process group at the deadline or on cancel, so
// a helper Git starts cannot outlive the request.
const HOST =
  process.platform === 'darwin' || process.platform === 'linux'
    ? process.platform
    : undefined;
const posix = HOST ? describe : describe.skip;

let dir = '';
let repo = '';
const pids = new Set<number>();
/** Ends every read a test leaves running, so none outlives its test. */
let teardown = new AbortController();
const inflight: Array<Promise<unknown>> = [];

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Reflect.get(Object(error), 'code') === 'EPERM';
  }
}

// Both polls end with their test's teardown, even after a test timeout.
async function gone(pid: number, ms = 5000): Promise<boolean> {
  const { signal } = teardown;
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!alive(pid)) return true;
    await delay(20, undefined, { signal });
  }
  return !alive(pid);
}

async function until(condition: () => boolean, ms = 10_000): Promise<void> {
  const { signal } = teardown;
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error('Timed out waiting.');
    await delay(20, undefined, { signal });
  }
}

/** This process's environment without Git's own, and no user or system config. */
function environment(): Record<string, string> {
  const kept = Object.entries(process.env).filter(
    (entry): entry is [string, string] =>
      !entry[0].startsWith('GIT_') && typeof entry[1] === 'string',
  );
  return {
    ...Object.fromEntries(kept),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
  };
}

function git(...args: string[]): void {
  execFileSync('git', args, { cwd: repo, env: environment() });
}

/**
 * A helper that records its PID and the non-interactive switches it
 * inherited, ignores SIGTERM and blocks: only a forced group kill ends it.
 */
function blockingHelper(name: string): {
  readonly file: string;
  readonly record: string;
} {
  const file = join(dir, `${name}.sh`);
  const record = join(dir, `${name}.record`);
  writeFileSync(
    file,
    [
      '#!/bin/sh',
      `printf '%s %s %s\\n' "$$" "$GIT_TERMINAL_PROMPT" "$GCM_INTERACTIVE" > "${record}"`,
      "trap '' TERM",
      'while :; do sleep 1; done',
      '',
    ].join('\n'),
  );
  chmodSync(file, 0o755);
  return { file, record };
}

/**
 * Whether the helper finished its record: `>` creates the file before
 * printf fills it, and an empty record would parse as PID 0.
 */
function written(record: string): boolean {
  try {
    return readFileSync(record, 'utf8').endsWith('\n');
  } catch {
    return false;
  }
}

function recorded(record: string): {
  readonly pid: number;
  readonly prompt: string;
  readonly interactive: string;
} {
  const [pid = '', prompt = '', interactive = ''] = readFileSync(record, 'utf8')
    .trim()
    .split(' ');
  const parsed = helperPid(pid);
  if (parsed === undefined)
    throw new Error(`Not a helper PID: ${JSON.stringify(pid)}`);
  pids.add(parsed);
  return { pid: parsed, prompt, interactive };
}

/**
 * Rejects 0, 1 and negatives: signalling those reaches this process group
 * (or every process), not the helper.
 */
function helperPid(text: string): number | undefined {
  const pid = Number(text);
  return Number.isSafeInteger(pid) && pid > 1 ? pid : undefined;
}

const remoteHead: GitReadCommand = {
  kind: 'git-remote-head',
  executable: 'git',
};
// Stopping starts 1 s before this: a loaded macOS can take seconds to start a fresh script.
const DEADLINE_MS = 6_000;
const runner = (): ReturnType<typeof createGitReadRunner> =>
  createGitReadRunner({
    os: HOST ?? 'linux',
    timing: { cleanupReserveMs: 1_000, escalateMs: 200, drainMs: 100 },
  });

/** Runs a read expected to fail, and settles with its error. */
function failedRead(
  command: GitReadCommand,
  request: {
    readonly deadlineMs: number;
    readonly signal?: AbortSignal;
    readonly environment?: Record<string, string>;
  },
): Promise<unknown> {
  const settled = runner()
    .run(command, {
      cwd: repo,
      environment: request.environment ?? environment(),
      deadlineAt: performance.now() + request.deadlineMs,
      signal: request.signal
        ? AbortSignal.any([request.signal, teardown.signal])
        : teardown.signal,
    })
    .then(
      () => new Error(`${command.kind} unexpectedly succeeded`),
      (error: unknown) => error,
    );
  inflight.push(settled);
  return settled;
}

let server: Server | undefined;
/** An HTTP origin that asks for credentials on every request. */
async function challengingOrigin(): Promise<string> {
  server = createServer((_request, response) => {
    response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="canopy"' });
    response.end();
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (typeof address !== 'object' || address === null)
    throw new Error('The origin is not listening.');
  return `http://127.0.0.1:${address.port}/repo.git`;
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'c5138-')));
  repo = join(dir, 'repo');
  execFileSync('git', ['init', '--quiet', repo], { env: environment() });
});
afterEach(async () => {
  // A failed or timed-out test can leave a read, and its helpers, running.
  teardown.abort(new Error('The test ended.'));
  await Promise.all(inflight.splice(0));
  teardown = new AbortController();
  for (const name of readdirSync(dir)) {
    const record = join(dir, name);
    // A partial record could hold a truncated, unrelated PID.
    if (!name.endsWith('.record') || !written(record)) continue;
    const [text = ''] = readFileSync(record, 'utf8').split(' ');
    const pid = helperPid(text);
    if (pid !== undefined) pids.add(pid);
  }
  pids.forEach((pid) => {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone, as the test expects.
    }
  });
  pids.clear();
  server?.closeAllConnections();
  await new Promise<void>((resolve) =>
    server ? server.close(() => resolve()) : resolve(),
  );
  server = undefined;
  rmSync(dir, { recursive: true, force: true });
});

posix('ls-remote helpers end with the request', () => {
  function sshOrigin(): { readonly record: string } {
    const ssh = blockingHelper('ssh');
    git('remote', 'add', 'origin', 'ssh://git@example.invalid/repo.git');
    git('config', 'core.sshCommand', ssh.file);
    git('config', 'ssh.variant', 'simple');
    return ssh;
  }

  async function credentialOrigin(): Promise<{ readonly record: string }> {
    const helper = blockingHelper('credential');
    git('remote', 'add', 'origin', await challengingOrigin());
    git('config', 'credential.helper', `!${helper.file}`);
    return helper;
  }

  it.each([
    ['an ssh transport', sshOrigin],
    ['a credential helper', credentialOrigin],
  ])(
    'kills %s that blocks past the deadline',
    async (_, origin) => {
      const helper = await origin();
      const settled = failedRead(remoteHead, { deadlineMs: DEADLINE_MS });
      await until(() => written(helper.record));
      const { pid, prompt, interactive } = recorded(helper.record);
      expect(alive(pid)).toBe(true);
      // The helper inherited the non-interactive switches (D8).
      expect([prompt, interactive]).toEqual(['0', 'never']);
      await expect(settled).resolves.toMatchObject({
        code: 'deadline_exceeded',
      });
      expect(await gone(pid)).toBe(true);
    },
    20_000,
  );

  // CAN-5496: a forwarded environment cannot re-enable prompts.
  it.each([
    ['an ssh transport', sshOrigin],
    ['a credential helper', credentialOrigin],
  ])(
    'gives %s the switches over a forwarded environment that asks for prompts',
    async (_, origin) => {
      const helper = await origin();
      const controller = new AbortController();
      const settled = failedRead(remoteHead, {
        deadlineMs: 60_000,
        signal: controller.signal,
        environment: {
          ...environment(),
          GIT_TERMINAL_PROMPT: '1',
          GCM_INTERACTIVE: 'always',
        },
      });
      await until(() => written(helper.record));
      const { prompt, interactive } = recorded(helper.record);
      expect([prompt, interactive]).toEqual(['0', 'never']);
      controller.abort(new Error('done'));
      await settled;
    },
    20_000,
  );

  it.each([
    ['an ssh transport', sshOrigin],
    ['a credential helper', credentialOrigin],
  ])(
    'kills %s when the request is cancelled',
    async (_, origin) => {
      const helper = await origin();
      const controller = new AbortController();
      const reason = new Error('cancelled');
      const settled = failedRead(remoteHead, {
        deadlineMs: 60_000,
        signal: controller.signal,
      });
      await until(() => written(helper.record));
      const { pid } = recorded(helper.record);
      expect(alive(pid)).toBe(true);
      controller.abort(reason);
      await expect(settled).resolves.toBe(reason);
      expect(await gone(pid)).toBe(true);
    },
    20_000,
  );
});

/**
 * A Git stand-in that starts a SIGTERM-ignoring helper and blocks, but exits
 * on SIGTERM itself: a graceful stop would end it first and leave the helper.
 */
function gitStartingHelper(): {
  readonly file: string;
  readonly record: string;
} {
  const helper = blockingHelper('helper');
  const file = join(dir, 'git.sh');
  writeFileSync(
    file,
    ['#!/bin/sh', `"${helper.file}" &`, 'while :; do sleep 1; done', ''].join(
      '\n',
    ),
  );
  chmodSync(file, 0o755);
  return { file, record: helper.record };
}

posix('origin HEAD reads end every process they start with the request', () => {
  it.each(['git-remote-head', 'git-origin-head'] as const)(
    'kills a helper %s starts, at the deadline and on cancel',
    async (kind) => {
      for (const cancel of [false, true]) {
        const fake = gitStartingHelper();
        const command: GitReadCommand = { kind, executable: fake.file };
        const controller = new AbortController();
        const reason = new Error('cancelled');
        const settled = failedRead(command, {
          deadlineMs: cancel ? 60_000 : DEADLINE_MS,
          signal: controller.signal,
        });
        await until(() => written(fake.record));
        const { pid } = recorded(fake.record);
        expect(alive(pid)).toBe(true);
        if (cancel) {
          controller.abort(reason);
          await expect(settled).resolves.toBe(reason);
        } else {
          await expect(settled).resolves.toMatchObject({
            code: 'deadline_exceeded',
          });
        }
        expect(await gone(pid)).toBe(true);
        rmSync(fake.record);
      }
    },
    30_000,
  );
});
