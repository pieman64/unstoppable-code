// Real processes on a temporary root: registration and maintenance race
// through the filesystem with real PIDs, `ps` start times and SIGKILL.
import { spawn, type ChildProcess } from 'node:child_process';
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
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  createPlatformEndpointServices,
  hostPlatformOperatingSystem,
  hostPlatformServices,
} from '@canopy/core-platform';
import { acquireW5MaintenanceExclusion, type W5MaintenanceExclusion } from '..';

jest.setTimeout(120_000);

const FIXTURE = join(__dirname, 'fixtures', 'cohort-child.ts');
const REPOSITORY = resolve(__dirname, '../../../../../..');
const platform = hostPlatformServices(
  createPlatformEndpointServices(hostPlatformOperatingSystem()),
);
const posix = process.platform === 'win32' ? describe.skip : describe;

interface Child {
  readonly process: ChildProcess;
  /** Resolves with the first stdout line. */
  readonly line: Promise<string>;
  readonly exited: Promise<number | null>;
}

let root: string;
let runtime: string;
let hosts: string;
const children: Child[] = [];

function start(...args: string[]): Child {
  const child = spawn(process.execPath, ['--import', 'tsx', FIXTURE, ...args], {
    cwd: REPOSITORY,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let errors = '';
  child.stderr.on('data', (chunk) => {
    errors += String(chunk);
  });
  const line = new Promise<string>((done, fail) => {
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
      const end = output.indexOf('\n');
      if (end >= 0) done(output.slice(0, end));
    });
    child.once('exit', (code) => {
      if (!output.includes('\n'))
        fail(new Error(`child exited ${String(code)}: ${errors}`));
    });
  });
  const exited = new Promise<number | null>((done) =>
    child.once('exit', (code) => done(code)),
  );
  const started = { process: child, line, exited };
  children.push(started);
  return started;
}

async function kill(child: Child): Promise<void> {
  child.process.kill('SIGKILL');
  await child.exited;
}

async function killPid(pid: number): Promise<void> {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    return;
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((done) => setTimeout(done, 20));
  }
}

function members(): string[] {
  return existsSync(hosts)
    ? readdirSync(hosts).filter((name) => !name.startsWith('.'))
    : [];
}

function memberPids(): number[] {
  return members()
    .map((name): unknown => JSON.parse(readFileSync(join(hosts, name), 'utf8')))
    .map((record) =>
      typeof record === 'object' && record !== null
        ? Number(Reflect.get(record, 'pid'))
        : 0,
    );
}

async function acquire(): Promise<W5MaintenanceExclusion> {
  const self = await platform.supervision.inspectProcess({ pid: process.pid });
  if (self.state !== 'running') throw new Error('identity unprovable');
  return acquireW5MaintenanceExclusion({
    dataRoot: root,
    owner: { pid: process.pid, startIdentity: self.startIdentity },
    inspect: (pid, signal) =>
      platform.supervision.inspectProcess({ pid, signal }),
    secureFiles: platform.secureFiles,
  });
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'w5-cohort-proc-')));
  runtime = join(root, 'runtime');
  hosts = join(runtime, 'hosts');
  mkdirSync(runtime, { mode: 0o700 });
});

afterEach(async () => {
  await Promise.all(
    children.splice(0).map(async (child) => {
      child.process.kill('SIGKILL');
      await child.exited;
    }),
  );
  rmSync(root, { recursive: true, force: true });
});

posix('cohort processes', () => {
  it('lets concurrent hosts coexist and refuses maintenance until SIGKILL proves them gone', async () => {
    const hostsStarted = [
      start('register', root),
      start('register', root),
      start('register', root),
    ];
    expect(await Promise.all(hostsStarted.map((child) => child.line))).toEqual([
      'admitted',
      'admitted',
      'admitted',
    ]);
    expect(memberPids().sort()).toEqual(
      hostsStarted.map((child) => child.process.pid).sort(),
    );
    await expect(acquire()).rejects.toMatchObject({ reason: 'host-active' });
    expect(existsSync(join(runtime, 'w5-maintenance.json'))).toBe(false);
    await Promise.all(hostsStarted.map(kill));
    const exclusion = await acquire();
    expect(members()).toEqual([]);
    await exclusion.release();
  });

  it('never admits a host while maintenance holds, across concurrent races', async () => {
    let held = 0;
    for (let round = 0; round < 6; round += 1) {
      const racers = Array.from({ length: 4 }, () => start('register', root));
      // Stagger the acquisition across the racers' startup.
      await new Promise((done) => setTimeout(done, round * 250));
      const exclusion = await acquire().catch(() => null);
      const outcomes = await Promise.all(racers.map((child) => child.line));
      if (exclusion) {
        held += 1;
        expect(outcomes).toEqual(Array(4).fill('refused:maintenance-held'));
        expect(members()).toEqual([]);
        await exclusion.release();
      }
      // Either side may back off; neither waits for the other.
      for (const outcome of outcomes)
        expect(['admitted', 'refused:maintenance-held']).toContain(outcome);
      await Promise.all(racers.map(kill));
    }
    process.stdout.write(`maintenance held in ${held} of 6 rounds\n`);
  });

  it('prunes a host killed mid-registration and ignores its staging files', async () => {
    // A record forces the check; the child hangs inside it.
    writeFileSync(
      join(runtime, 'w5-maintenance.json'),
      JSON.stringify({
        version: 1,
        pid: process.pid,
        startIdentity: 'fixture-check',
        token: '12345678-1234-4234-8234-123456789abc',
      }),
    );
    const hanging = start('register-hang', root);
    expect(await hanging.line).toBe('checking');
    expect(memberPids()).toEqual([hanging.process.pid]);
    await kill(hanging);
    writeFileSync(
      join(
        hosts,
        `.12345678-1234-4234-8234-123456789abd.${hanging.process.pid ?? 0}.tmp`,
      ),
      '{"version":1,"pid":',
    );
    rmSync(join(runtime, 'w5-maintenance.json'));
    const exclusion = await acquire();
    expect(members()).toEqual([]);
    await exclusion.release();
  });

  it('refuses hosts while a maintenance process lives, and admits them once SIGKILL ends it', async () => {
    const maintenance = start('acquire', root);
    expect(await maintenance.line).toBe('held');
    const refused = start('register', root);
    expect(await refused.line).toBe('refused:maintenance-held');
    expect(await refused.exited).toBe(3);
    expect(members()).toEqual([]);
    await kill(maintenance);
    // The departed record stays until the next maintenance replaces it.
    expect(existsSync(join(runtime, 'w5-maintenance.json'))).toBe(true);
    const admitted = start('register', root);
    expect(await admitted.line).toBe('admitted');
    await expect(acquire()).rejects.toMatchObject({ reason: 'host-active' });
    await kill(admitted);
    const exclusion = await acquire();
    await expect(exclusion.isHeld()).resolves.toBe(true);
    await exclusion.release();
    expect(existsSync(join(runtime, 'w5-maintenance.json'))).toBe(false);
  });

  it('keeps a detached create-worktree child a member after its parent exits', async () => {
    const parent = start('spawn-detached', root);
    const pid = Number(await parent.line);
    expect(await parent.exited).toBe(0);
    try {
      expect(memberPids()).toEqual([pid]);
      const record: unknown = JSON.parse(
        readFileSync(join(hosts, members()[0] ?? ''), 'utf8'),
      );
      expect(record).toMatchObject({ hostKind: 'create-worktree' });
      await expect(acquire()).rejects.toMatchObject({ reason: 'host-active' });
    } finally {
      await killPid(pid);
    }
    const exclusion = await acquire();
    expect(members()).toEqual([]);
    await exclusion.release();
  });
});
