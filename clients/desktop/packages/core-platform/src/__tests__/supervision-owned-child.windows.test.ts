import { execFile, spawn } from 'node:child_process';
import {
  copyFileSync,
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
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import type * as Runtime from '@canopy/core-runtime';
import { createChildServices } from '../supervision/child';
import {
  createOwnedChildServices,
  OWNED_CHILD_FILE,
} from '../supervision/owned-child';
import {
  WINDOWS_PROCESS_FILE,
  windowsPrincipalObserver,
  windowsProcessObserver,
  windowsStartIdentity,
} from '../supervision/windows-process';

// Native Windows evidence for the owned-child backend (CAN-4929). Off Windows
// nothing runs. On Windows the suite builds the addon, its job probe and the
// identity helper when they are missing. CANOPY_OWNED_CHILD_ACCEPTANCE=1 (the
// PlatformServices job) requires the prebuilt CANOPY_OWNED_CHILD_ADDON and
// CANOPY_OWNED_CHILD_PROBE instead. The Electron and real-daemon cases need
// their binaries (`--perf-smoke`, `build:core-daemon`); without them they log
// a skip and pass, unless CANOPY_OWNED_CHILD_REQUIRE_ELECTRON=1 or
// CANOPY_OWNED_CHILD_REQUIRE_DAEMON=1 makes the absence a failure. Every case
// writes `[owned-child evidence]` lines to stderr.

const windows = process.platform === 'win32';
const windowsDescribe = windows ? describe : describe.skip;
const acceptance = process.env.CANOPY_OWNED_CHILD_ACCEPTANCE === '1';
const requireElectron = process.env.CANOPY_OWNED_CHILD_REQUIRE_ELECTRON === '1';
const requireDaemon = process.env.CANOPY_OWNED_CHILD_REQUIRE_DAEMON === '1';
const ROOT = path.resolve(__dirname, '../../../..');
const BUILD = path.join(ROOT, 'scripts', 'build-owned-child.mjs');
const MODULE = path.resolve(__dirname, '../supervision/owned-child.ts');
const HELPER = path.join(
  ROOT,
  '.cache',
  'bin',
  'win32-x64',
  WINDOWS_PROCESS_FILE,
);
// Loaded addons stay mapped on Windows, so they live outside the deleted `dir`.
const NATIVE = path.join(ROOT, '.cache', 'native-owned-child');
const KILL_ON_JOB_CLOSE = 0x2000;
const DIE_ON_UNHANDLED_EXCEPTION = 0x400;
const BREAKAWAY_OK = 0x800;
const SILENT_BREAKAWAY_OK = 0x1000;
const run = promisify(execFile);

let dir = '';
let addon = '';
let probeFile = '';
let scratch = '';
let gitPath = '';
let systemRoot = '';
let probe: Record<string, unknown> = {};
const children = new Set<Runtime.PlatformOwnedChild>();
/** Every fixture process seen: pid -> creation ticks, for leak checks. */
const tracked = new Map<number, string>();
const stopFiles = new Set<string>();
let launches = 0;

const field = (value: unknown, key: string): unknown =>
  Reflect.get(Object(value), key);
const text = (value: unknown): string =>
  typeof value === 'string' ? value : '';
const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function evidence(name: string, detail: unknown): void {
  process.stderr.write(
    `[owned-child evidence] ${name}: ${JSON.stringify(detail)}\n`,
  );
}

async function until<T>(
  read: () => T | undefined | Promise<T | undefined>,
  label: string,
  ms = 20_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${label}`);
    await delay(25);
  }
}

function callProbe(name: string, ...args: unknown[]): unknown {
  const method = field(probe, name);
  if (typeof method !== 'function') throw new Error(`probe lacks ${name}`);
  return Reflect.apply(method, probe, args);
}

/** The Jest process's own immediate job, as the probe reports it. */
const jobInfo = (): unknown => callProbe('jobInfo');

/** Creation ticks of a live or held process; null once no process has the PID. */
function created(pid: number): string | null {
  const found = callProbe('inspect', pid);
  return found === null ? null : text(field(found, 'created')) || null;
}

const identity = (pid: number, ticks: string): string | null =>
  windowsStartIdentity(`canopy-process-v1 ${pid} ${ticks}\n`, pid);

/**
 * The shipped identity helper, independent of the backend under test:
 * `absent`, a start identity, or `unobservable` (for example a process that
 * exited while someone still holds its handle).
 */
async function oracle(pid: number): Promise<string> {
  try {
    const receipt = await windowsProcessObserver(HELPER)(pid);
    if (/^canopy-process-v1 absent\r?\n$/.test(receipt)) return 'absent';
    return windowsStartIdentity(receipt, pid) ?? 'malformed';
  } catch {
    return 'unobservable';
  }
}

/** Gone once the helper reports no process, or another one, under the PID. */
async function gone(pid: number, ticks: string): Promise<boolean> {
  const seen = await oracle(pid);
  return (
    seen === 'absent' ||
    (seen.startsWith('win32:') && seen !== identity(pid, ticks))
  );
}

async function goneWithin(
  processes: readonly { pid: number; created: string }[],
  ms = 5_000,
): Promise<{ pid: number; state: string }[]> {
  const deadline = Date.now() + ms;
  for (;;) {
    const states: { pid: number; state: string }[] = [];
    for (const { pid, created: ticks } of processes)
      states.push({
        pid,
        state: (await gone(pid, ticks)) ? 'gone' : await oracle(pid),
      });
    if (states.every(({ state }) => state === 'gone') || Date.now() > deadline)
      return states;
    await delay(100);
  }
}

const FIXTURE = `'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const [, , out, encoded] = process.argv;
const options = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
const file = (suffix) => out + '.' + options.role + suffix;
let probe = null;
if (options.probe) {
  const loaded = { exports: {} };
  process.dlopen(loaded, options.probe);
  probe = loaded.exports;
}
// A reader holding the previous report can fail the rename; the next one retries.
const report = () => {
  if (!probe) return;
  try {
    const info = probe.jobInfo();
    info.self = Object.assign({ pid: process.pid }, probe.inspect(process.pid));
    info.members = (info.pids || []).map((pid) => Object.assign({ pid }, probe.inspect(pid) || { absent: true }));
    fs.writeFileSync(file('.job.tmp'), JSON.stringify(info));
    fs.renameSync(file('.job.tmp'), file('.job'));
  } catch {}
};
const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64');
// On its first spawn libuv creates a job (silent breakaway allowed) and puts
// this process and every attached child in it, so their probes see that job.
// A detached child gets no libuv job: it breaks away from this one silently
// and stops in the owned job. A witness is such a leaf; it spawns nothing, so
// its immediate job stays the owned job.
if (options.witness) spawn(process.execPath, [__filename, out, encode({ role: 'job', probe: options.probe })], { stdio: 'ignore', windowsHide: true, detached: true });
if (options.next) spawn(process.execPath, [__filename, out, encode(options.next)], { stdio: 'ignore', windowsHide: true, detached: !!options.next.detached });
if (options.git) spawn(options.git, ['-c', 'alias.canopy-hold=!sleep 30', 'canopy-hold'], { stdio: 'ignore', windowsHide: true, cwd: options.cwd });
report();
fs.writeFileSync(file('.pid'), String(process.pid));
const ready = () => (options.ready || []).every((role) => fs.existsSync(out + '.' + role + '.pid'));
const started = Date.now();
setInterval(() => {
  report();
  if (fs.existsSync(out + '.stop')) process.exit(0);
  if (options.exit !== undefined && ready() && Date.now() - started >= (options.settleMs || 0)) process.exit(options.exit);
}, 100);
// Nothing reaps a stranded fixture, so it ends itself.
setTimeout(() => process.exit(70), options.lifetimeMs || 60000);
`;

const ECHO = `'use strict';
const fs = require('node:fs');
const out = process.argv[2];
const stdin = fs.readFileSync(0);
const env = Object.fromEntries(Object.entries(process.env));
fs.writeFileSync(out, JSON.stringify({ argv: process.argv.slice(3), env, cwd: process.cwd(), stdin: stdin.length }));
// NUL accepts everything; a missing handle would fail these writes.
const block = 'x'.repeat(256 * 1024);
process.stdout.write(block);
process.stderr.write(block);
console.log('done');
`;

// Loads the addon in a foreign host (renamed node.exe or electron.exe) and
// exercises spawn, observe, release and rollback there.
const LOADER = `'use strict';
const [, , addon, cmd, ping] = process.argv;
const loaded = { exports: {} };
process.dlopen(loaded, addon);
const native = loaded.exports;
const env = ['SystemRoot=' + process.env.SystemRoot];
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const quick = native.spawn(cmd, [cmd, '/d', '/c', 'exit 7'], env, null);
let observed = native.observe(quick.handle);
for (let n = 0; observed.state === 'running' && n < 500; n++) { pause(20); observed = native.observe(quick.handle); }
let released = false;
for (let n = 0; !released && n < 150; n++) { released = native.release(quick.handle); if (!released) pause(20); }
const held = native.spawn(ping, [ping, '-n', '30', '127.0.0.1'], env, null);
const rolledBack = native.rollbackSync(held.handle);
process.stdout.write(JSON.stringify({ execPath: process.execPath, electron: process.versions.electron || null, observed, released, rolledBack, heldPid: held.pid }));
`;

const HOST = `
const [, , module, nativePath, fixture, out, encoded, readyRole, mode, probePath] = process.argv;
const { createOwnedChildServices } = await import(module);
const { existsSync, readFileSync, writeFileSync } = await import('node:fs');
const { spawnSync } = await import('node:child_process');
// Like Electron main or the CLI, a launcher that has started any child sits
// in its own libuv job, which kills on close when the launcher exits.
spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true });
const loaded = { exports: {} };
process.dlopen(loaded, probePath);
const environment = JSON.parse(readFileSync(out + '.env.json', 'utf8'));
const child = await createOwnedChildServices({ os: 'win32', nativePath })
  .spawn({ executable: process.execPath, args: [fixture, out, encoded], environment });
const launcherJob = loaded.exports.jobInfo();
writeFileSync(out + '.host.json', JSON.stringify({ launcherJob, rootInLauncherJob: (launcherJob.pids || []).includes(child.pid) }));
process.stdout.write(String(child.pid) + '\\n');
while (!existsSync(out + '.' + readyRole + '.pid')) await new Promise((r) => setTimeout(r, 20));
if (mode.startsWith('commit')) child.commit();
process.stdout.write('ready\\n');
if (mode.endsWith('exit')) process.exit(3);
if (mode === 'owned-throw') throw new Error('host failed');
if (mode === 'owned') await child.exited;
if (mode === 'crash') setInterval(() => undefined, 1000);
`;

interface FixtureOptions {
  readonly role?: string;
  readonly probe?: string;
  readonly next?: FixtureOptions;
  readonly git?: string;
  readonly cwd?: string;
  readonly ready?: readonly string[];
  readonly exit?: number;
  readonly settleMs?: number;
  readonly detached?: boolean;
  /** Also start a detached leaf (role `job`) that reports the owned job. */
  readonly witness?: boolean;
}

const encode = (options: FixtureOptions): string =>
  Buffer.from(JSON.stringify({ role: 'root', ...options })).toString('base64');

/** The launcher's own minimal child environment (child.ts), as the daemon gets it. */
const minimalEnvironment = (): Readonly<Record<string, string>> =>
  createChildServices('win32').childEnvironment({ source: process.env });

const services = (): ReturnType<typeof createOwnedChildServices> =>
  createOwnedChildServices({ os: 'win32', nativePath: addon });

function fixturePath(name: string): string {
  const out = path.join(dir, `${name}-${launches++}`);
  stopFiles.add(`${out}.stop`);
  return out;
}

async function launch(
  name: string,
  options: FixtureOptions,
): Promise<{ child: Runtime.PlatformOwnedChild; out: string }> {
  const out = fixturePath(name);
  const child = await services().spawn({
    executable: process.execPath,
    args: [path.join(dir, 'fixture.js'), out, encode(options)],
    environment: minimalEnvironment(),
  });
  children.add(child);
  return { child, out };
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/** A fixture's latest job report, once written; records its processes. */
function report(out: string, role: string): unknown {
  const info = readJson(`${out}.${role}.job`);
  if (info === undefined) return undefined;
  for (const member of [field(info, 'self'), ...membersOf(info)]) {
    const pid = field(member, 'pid');
    const ticks = text(field(member, 'created'));
    if (typeof pid === 'number' && ticks !== '') tracked.set(pid, ticks);
  }
  return info;
}

function membersOf(info: unknown): unknown[] {
  const members = field(info, 'members');
  return Array.isArray(members) ? members : [];
}

/** Whether a job report lists the PID; nested jobs' processes are listed too. */
function listed(info: unknown, pid: number): boolean {
  const pids = field(info, 'pids');
  return Array.isArray(pids) && pids.includes(pid);
}

function self(info: unknown): { pid: number; created: string } {
  const me = field(info, 'self');
  const pid = field(me, 'pid');
  const ticks = text(field(me, 'created'));
  if (typeof pid !== 'number' || ticks === '')
    throw new Error('fixture reported no identity');
  return { pid, created: ticks };
}

const flagsOf = (info: unknown): number => {
  const flags = field(info, 'limitFlags');
  return typeof flags === 'number' ? flags : -1;
};

const describeFlags = (flags: number): unknown =>
  flags < 0
    ? null
    : {
        hex: `0x${flags.toString(16)}`,
        killOnJobClose: (flags & KILL_ON_JOB_CLOSE) !== 0,
        dieOnUnhandledException: (flags & DIE_ON_UNHANDLED_EXCEPTION) !== 0,
        breakawayOk: (flags & BREAKAWAY_OK) !== 0,
        silentBreakawayOk: (flags & SILENT_BREAKAWAY_OK) !== 0,
      };

const summary = (info: unknown): unknown => ({
  inJob: field(info, 'inJob'),
  flags: describeFlags(flagsOf(info)),
  activeProcesses: field(info, 'activeProcesses'),
  assignedProcesses: field(info, 'assignedProcesses'),
  members: membersOf(info).map((member) => ({
    pid: field(member, 'pid'),
    name: field(member, 'name') ?? null,
  })),
  console: field(info, 'console'),
});

/** The backend's job: kills on close, dies on unhandled exceptions, no breakaway. */
function expectOwnedJob(info: unknown, killOnClose = true): void {
  const flags = flagsOf(info);
  expect(field(info, 'inJob')).toBe(true);
  expect(flags & (BREAKAWAY_OK | SILENT_BREAKAWAY_OK)).toBe(0);
  expect(flags & DIE_ON_UNHANDLED_EXCEPTION).toBe(DIE_ON_UNHANDLED_EXCEPTION);
  expect(flags & KILL_ON_JOB_CLOSE).toBe(killOnClose ? KILL_ON_JOB_CLOSE : 0);
}

async function rejection(work: () => unknown): Promise<unknown> {
  try {
    await work();
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

function nativeCode(run: () => unknown): unknown {
  try {
    return run();
  } catch (error) {
    return field(error, 'code');
  }
}

function locateGit(): string {
  const standard = path.join(
    process.env.ProgramFiles ?? 'C:\\Program Files',
    'Git',
    'cmd',
    'git.exe',
  );
  if (existsSync(standard)) return standard;
  for (const entry of (process.env.PATH ?? '').split(';')) {
    const candidate = path.join(entry, 'git.exe');
    if (entry !== '' && existsSync(candidate)) return candidate;
  }
  throw new Error('Git for Windows is required for the native suite');
}

function electronExecutable(): string | null {
  const override = process.env.CANOPY_OWNED_CHILD_ELECTRON;
  if (override) return existsSync(override) ? override : null;
  const pkg = path.join(ROOT, 'node_modules', 'electron');
  const pathFile = path.join(pkg, 'path.txt');
  if (!existsSync(pathFile)) return null;
  const binary = path.join(pkg, 'dist', readFileSync(pathFile, 'utf8').trim());
  return existsSync(binary) ? binary : null;
}

function builtDaemon(): string | null {
  const daemonDir = path.join(ROOT, 'dist', 'core-daemon');
  if (!existsSync(daemonDir)) return null;
  const name = readdirSync(daemonDir).find(
    (entry) =>
      entry.toLowerCase().endsWith('.exe') &&
      entry.toLowerCase() !== WINDOWS_PROCESS_FILE,
  );
  return name === undefined ? null : path.join(daemonDir, name);
}

/** Earlier runs' scratch addons are no longer loaded; a locked one is skipped. */
function removeStaleScratch(): void {
  for (const entry of readdirSync(NATIVE)) {
    if (!entry.startsWith('jest-') || entry === `jest-${process.pid}`) continue;
    try {
      rmSync(path.join(NATIVE, entry), { recursive: true, force: true });
    } catch {
      /* still loaded by another run */
    }
  }
}

const prebuilt = (name: string): string | undefined => {
  const value = process.env[name];
  const file = value ? path.resolve(ROOT, value) : undefined;
  return file !== undefined && existsSync(file) ? file : undefined;
};

/** The addon and probe: prebuilt (required in acceptance) or built here. */
async function resolveAddons(): Promise<{
  addon: string;
  probe: string;
  prebuilt: boolean;
}> {
  const prebuiltAddon = prebuilt('CANOPY_OWNED_CHILD_ADDON');
  const prebuiltProbe = prebuilt('CANOPY_OWNED_CHILD_PROBE');
  if (prebuiltAddon && prebuiltProbe)
    return { addon: prebuiltAddon, probe: prebuiltProbe, prebuilt: true };
  if (acceptance)
    throw new Error(
      'Owned-child acceptance requires CANOPY_OWNED_CHILD_ADDON and CANOPY_OWNED_CHILD_PROBE',
    );
  const built = path.join(scratch, OWNED_CHILD_FILE);
  const builtProbe = path.join(scratch, 'owned-child-probe.node');
  await run(
    process.execPath,
    [BUILD, '--out', built, '--probe-out', builtProbe],
    { cwd: ROOT, windowsHide: true, timeout: 540_000, maxBuffer: 1 << 24 },
  );
  return { addon: built, probe: builtProbe, prebuilt: false };
}

beforeAll(async () => {
  if (!windows) return;
  systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  dir = mkdtempSync(
    path.join(realpathSync.native(tmpdir()), 'owned-child-win-'),
  );
  scratch = path.join(NATIVE, `jest-${process.pid}`);
  mkdirSync(scratch, { recursive: true });
  removeStaleScratch();
  const addons = await resolveAddons();
  addon = addons.addon;
  probeFile = addons.probe;
  if (!existsSync(HELPER)) {
    if (acceptance) throw new Error(`Missing identity helper ${HELPER}`);
    await run(
      process.execPath,
      [path.join(ROOT, 'scripts', 'build-windows-process-identity.mjs')],
      { cwd: ROOT, windowsHide: true, timeout: 240_000, maxBuffer: 1 << 22 },
    );
  }
  const loaded = { exports: {} };
  process.dlopen(loaded, probeFile);
  probe = loaded.exports;
  gitPath = locateGit();
  writeFileSync(path.join(dir, 'fixture.js'), FIXTURE);
  writeFileSync(path.join(dir, 'echo.js'), ECHO);
  writeFileSync(path.join(dir, 'loader.js'), LOADER);
  writeFileSync(path.join(dir, 'host.mjs'), HOST);
  evidence('suite', {
    node: process.version,
    addon,
    prebuilt: addons.prebuilt,
    acceptance,
    git: gitPath,
    jest: summary(jobInfo()),
  });
}, 600_000);

afterEach(async () => {
  if (!windows) return;
  for (const child of Array.from(children))
    await child.terminate().catch(() => undefined);
  children.clear();
  stopFiles.forEach((file) => writeFileSync(file, ''));
  stopFiles.clear();
  const remaining = Array.from(tracked, ([pid, ticks]) => ({
    pid,
    created: ticks,
  }));
  tracked.clear();
  const states = await goneWithin(remaining, 5_000);
  // Last resort, only at the recorded creation time; a survivor fails the case.
  const survivors = states.filter(({ state }) => state !== 'gone');
  for (const { pid } of survivors) {
    const ticks = remaining.find((entry) => entry.pid === pid)?.created ?? '';
    callProbe('terminate', pid, ticks);
  }
  if (survivors.length > 0) {
    evidence('survivors', survivors);
    throw new Error(`fixture processes survived: ${JSON.stringify(survivors)}`);
  }
}, 30_000);

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

windowsDescribe('windows owned child', () => {
  it('records the Jest process job (Q4) and owns a probe root and its nested libuv child in one job', async () => {
    const { child, out } = await launch('context', {
      probe: probeFile,
      witness: true,
      next: { role: 'child', probe: probeFile },
    });
    const helper = self(
      await until(() => report(out, 'child'), 'child report'),
    );
    const rootInfo = await until(() => report(out, 'root'), 'root report');
    const root = self(rootInfo);
    // Rollback and release trust the owned job's accounting to include the
    // root and the child, which sit in the root's nested libuv job.
    const info = await until(() => {
      const latest = report(out, 'job');
      return listed(latest, root.pid) && listed(latest, helper.pid)
        ? latest
        : undefined;
    }, 'the owned job to list the root and its nested child').catch(
      (error: unknown) => {
        evidence('context (nested not listed)', summary(report(out, 'job')));
        throw error;
      },
    );
    const witness = self(info);
    // Taken while the root runs: a nested root would be listed here.
    const jestJob = jobInfo();
    const rootInJestJob = listed(jestJob, child.pid);
    evidence('context', {
      jest: summary(jestJob),
      rootImmediate: summary(rootInfo),
      owned: summary(info),
      rootInJestJob,
      conhostMember: membersOf(info).some(
        (member) => text(field(member, 'name')).toLowerCase() === 'conhost.exe',
      ),
    });
    expect(root.pid).toBe(child.pid);
    expectOwnedJob(info);
    // Q4 (a): a launcher job that permits breakaway does not keep the root.
    if ((flagsOf(jestJob) & BREAKAWAY_OK) !== 0)
      expect(rootInJestJob).toBe(false);
    expect(field(field(rootInfo, 'console'), 'visible')).toBe(false);
    await child.terminate();
    await expect(child.exited).resolves.toEqual({
      code: null,
      signal: 'SIGKILL',
    });
    expect(await goneWithin([root, helper, witness])).toEqual(
      [root, helper, witness].map(({ pid }) => ({ pid, state: 'gone' })),
    );
  }, 60_000);

  it('rolls back a failed start with a silent-breakaway Node grandchild', async () => {
    const { child, out } = await launch('failed-start', {
      probe: probeFile,
      next: {
        role: 'child',
        probe: probeFile,
        next: { role: 'grandchild', probe: probeFile, detached: true },
      },
      ready: ['grandchild'],
      exit: 17,
    });
    await expect(child.exited).resolves.toEqual({ code: 17, signal: null });
    const middle = await until(() => report(out, 'child'), 'child report');
    const leaf = await until(
      () => report(out, 'grandchild'),
      'grandchild report',
    );
    const root = self(await until(() => report(out, 'root'), 'root report'));
    evidence('failed-start', {
      child: summary(middle),
      grandchild: summary(leaf),
    });
    // libuv put the child in the root's own job; the child's detached child
    // got no job of its own, broke away from that one silently and stopped in
    // the owned job.
    expect(flagsOf(middle) & SILENT_BREAKAWAY_OK).toBe(SILENT_BREAKAWAY_OK);
    expectOwnedJob(leaf);
    expect(await gone(self(leaf).pid, self(leaf).created)).toBe(false);
    await child.terminate();
    expect(await goneWithin([root, self(middle), self(leaf)], 1_000)).toEqual(
      [root, self(middle), self(leaf)].map(({ pid }) => ({
        pid,
        state: 'gone',
      })),
    );
  }, 60_000);

  it('contains git.exe and the sh.exe its alias starts, and rolls them back', async () => {
    const { child, out } = await launch('git-alias', {
      probe: probeFile,
      witness: true,
      git: gitPath,
      cwd: dir,
    });
    // git.exe sits in the root's libuv job; what it starts breaks away from
    // that job silently, so only the owned job lists sh.exe.
    const info = await until(
      () => {
        const latest = report(out, 'job');
        return membersOf(latest).some(
          (member) => text(field(member, 'name')).toLowerCase() === 'sh.exe',
        )
          ? latest
          : undefined;
      },
      'sh.exe in the owned job',
      20_000,
    ).catch((error: unknown) => {
      evidence('git-alias (no sh.exe)', {
        owned: summary(report(out, 'job')),
        rootImmediate: summary(report(out, 'root')),
      });
      throw error;
    });
    expectOwnedJob(info);
    const members = membersOf(info).flatMap((member) => {
      const pid = field(member, 'pid');
      const ticks = text(field(member, 'created'));
      return typeof pid === 'number' && ticks !== ''
        ? [{ pid, created: ticks, name: text(field(member, 'name')) }]
        : [];
    });
    evidence('git-alias', { git: gitPath, root: summary(info) });
    await child.terminate();
    const states = await goneWithin(members, 1_000);
    evidence('git-alias after rollback', states);
    expect(states.filter(({ state }) => state !== 'gone')).toEqual([]);
  }, 60_000);

  describe('host exit', () => {
    async function host(
      mode: string,
      options: FixtureOptions,
      readyRole: string,
    ): Promise<{ code: number | null; out: string }> {
      const out = fixturePath(`host-${mode}`);
      writeFileSync(`${out}.env.json`, JSON.stringify(minimalEnvironment()));
      const args = [
        path.join(dir, 'host.mjs'),
        pathToFileURL(MODULE).href,
        addon,
        path.join(dir, 'fixture.js'),
        out,
        encode(options),
        readyRole,
        mode,
        probeFile,
      ];
      const code = await new Promise<number | null>((resolve, reject) => {
        const hosted = spawn(process.execPath, args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
        let stdout = '';
        let stderr = '';
        hosted.stdout.setEncoding('utf8');
        hosted.stderr.setEncoding('utf8');
        hosted.stderr.on('data', (chunk: string) => (stderr += chunk));
        hosted.stdout.on('data', (chunk: string) => {
          stdout += chunk;
          // A host crash: the kernel closes its job handle.
          if (mode === 'crash' && stdout.includes('ready')) hosted.kill();
        });
        const timer = setTimeout(() => hosted.kill(), 30_000);
        hosted.on('error', reject);
        hosted.on('close', (exit) => {
          clearTimeout(timer);
          if (!stdout.includes('ready'))
            evidence(`host ${mode} output`, { stdout, stderr });
          resolve(exit);
        });
      });
      return { code, out };
    }

    const chain: FixtureOptions = {
      next: { role: 'child', next: { role: 'grandchild', detached: true } },
      ready: ['grandchild'],
    };

    it.each([
      ['process.exit', 'owned-exit', 3],
      ['an uncaught error', 'owned-throw', 1],
      ['a natural end after root exit', 'owned', 0],
      ['a host crash (kill-on-close)', 'crash', 1],
    ])(
      'rolls back an uncommitted tree on %s',
      async (_, mode, exit) => {
        const withProbe = (options: FixtureOptions): FixtureOptions => ({
          ...options,
          probe: probeFile,
          ...(options.next ? { next: withProbe(options.next) } : {}),
        });
        const { code, out } = await host(
          mode,
          withProbe(mode === 'owned' ? { ...chain, exit: 17 } : chain),
          'grandchild',
        );
        const processes = ['root', 'child', 'grandchild'].map((role) => {
          const info = report(out, role);
          if (info === undefined) throw new Error(`no ${role} report`);
          return self(info);
        });
        const states = await goneWithin(processes);
        evidence(`host ${mode}`, {
          code,
          states,
          rootInLauncherJob: field(
            readJson(`${out}.host.json`),
            'rootInLauncherJob',
          ),
        });
        if (mode !== 'crash') expect(code).toBe(exit);
        expect(states.filter(({ state }) => state !== 'gone')).toEqual([]);
      },
      60_000,
    );

    it.each(['commit', 'commit-exit'])(
      'leaves a committed daemon and its helpers running after %s, in a job that no longer kills on close',
      async (mode) => {
        const { code, out } = await host(
          mode,
          {
            probe: probeFile,
            witness: true,
            next: { role: 'child', probe: probeFile },
          },
          'child',
        );
        expect(code).toBe(mode === 'commit' ? 0 : 3);
        const root = self(
          await until(() => report(out, 'root'), 'root report'),
        );
        const helper = self(
          await until(() => report(out, 'child'), 'child report'),
        );
        // Reports refresh every 100 ms; wait for one taken after the commit.
        const after = await until(() => {
          const latest = report(out, 'job');
          return latest !== undefined &&
            (flagsOf(latest) & KILL_ON_JOB_CLOSE) === 0
            ? latest
            : undefined;
        }, 'an owned-job report without kill-on-close').catch(
          (error: unknown) => {
            evidence(`host ${mode} (kill-on-close kept)`, {
              owned: summary(report(out, 'job')),
            });
            throw error;
          },
        );
        const witness = self(after);
        const launcher = readJson(`${out}.host.json`);
        const launcherJob = field(launcher, 'launcherJob');
        evidence(`host ${mode}`, {
          code,
          owned: summary(after),
          launcherJob: summary(launcherJob),
          rootInLauncherJob: field(launcher, 'rootInLauncherJob'),
        });
        expectOwnedJob(after, false);
        // Q4 (a): the root broke away from the launcher's own libuv job, whose
        // close at launcher exit would otherwise end the daemon.
        expect(flagsOf(launcherJob) & BREAKAWAY_OK).toBe(BREAKAWAY_OK);
        expect(field(launcher, 'rootInLauncherJob')).toBe(false);
        await delay(500);
        for (const each of [root, helper, witness])
          expect(await gone(each.pid, each.created)).toBe(false);
        // The daemon's own later exit, simulated through fixture control.
        writeFileSync(`${out}.stop`, '');
        expect(await goneWithin([root, helper, witness])).toEqual(
          [root, helper, witness].map(({ pid }) => ({ pid, state: 'gone' })),
        );
      },
      60_000,
    );
  });

  it('holds an exited root so its PID cannot name another process until release', async () => {
    const { child, out } = await launch('pid-reuse', {
      probe: probeFile,
      exit: 0,
      settleMs: 1_000,
    });
    const root = self(await until(() => report(out, 'root'), 'root report'));
    expect(await oracle(root.pid)).toBe(identity(root.pid, root.created));
    await expect(child.exited).resolves.toEqual({ code: 0, signal: null });
    // Exited, yet the same process object (same creation time) still owns the
    // PID: the helper sees a held, exited process, not absence or another one.
    const held = await oracle(root.pid);
    expect(created(root.pid)).toBe(root.created);
    expect(held).toBe('unobservable');
    await child.terminate();
    const released = await goneWithin([root]);
    evidence('pid-reuse', { held, released });
    expect(released).toEqual([{ pid: root.pid, state: 'gone' }]);
  }, 60_000);

  it('round-trips argv and the exact environment, starts in the Windows directory, and gives NUL stdio', async () => {
    const out = fixturePath('echo');
    const args = [
      'plain',
      'two words',
      'quote"inside',
      'trailing\\',
      'trailing space\\ ',
      'space then backslash \\',
      '',
      '\\\\server\\share\\',
      'tab\there',
      'a\\\\"b',
      '"',
      '\\"',
      'ünï 日本 🚀',
      '--flag=value with = signs',
      '%PATH%',
      '^&|<>',
    ];
    const environment = {
      ...minimalEnvironment(),
      MARKER: 'ünï 日本 🚀',
      lower_case: 'x',
      Mixed_Case: 'y',
      EMPTY: '',
    };
    const child = await services().spawn({
      executable: process.execPath,
      args: [path.join(dir, 'echo.js'), out, ...args],
      environment,
    });
    children.add(child);
    await expect(child.exited).resolves.toEqual({ code: 0, signal: null });
    const echoed = readJson(out);
    const echoedEnv = field(echoed, 'env');
    evidence('echo', {
      cwd: field(echoed, 'cwd'),
      envKeys:
        typeof echoedEnv === 'object' && echoedEnv !== null
          ? Object.keys(echoedEnv).sort()
          : null,
    });
    expect(field(echoed, 'argv')).toEqual(args);
    expect(field(echoed, 'env')).toEqual(environment);
    expect(text(field(echoed, 'cwd')).toLowerCase()).toBe(
      systemRoot.toLowerCase(),
    );
    expect(field(echoed, 'stdin')).toBe(0);
  }, 60_000);

  it('binds native handles to their load, reports conhost membership, and refuses invalid requests', async () => {
    const load = (file: string): Record<string, unknown> => {
      const module = { exports: {} };
      process.dlopen(module, file);
      return module.exports;
    };
    const invoke = (
      native: Record<string, unknown>,
      name: string,
      ...args: unknown[]
    ): unknown => {
      const method = field(native, name);
      if (typeof method !== 'function') throw new Error(`addon lacks ${name}`);
      return Reflect.apply(method, native, args);
    };
    const copy = path.join(scratch, 'second.node');
    copyFileSync(addon, copy);
    const loads = [load(addon), load(addon), load(copy)];
    const node = process.execPath;
    const pairs = Object.entries(minimalEnvironment()).map(
      ([key, value]) => `${key}=${value}`,
    );
    const handles = loads.map((native) => {
      const spawned = invoke(
        native,
        'spawn',
        node,
        [node, '-e', 'setTimeout(() => {}, 30000)'],
        pairs,
        null,
      );
      const pid = field(spawned, 'pid');
      const handle = field(spawned, 'handle');
      if (typeof pid !== 'number' || typeof handle !== 'object' || !handle)
        throw new Error('no native handle');
      const ticks = created(pid);
      if (ticks) tracked.set(pid, ticks);
      return handle;
    });
    loads.forEach((native, n) => {
      expect(nativeCode(() => invoke(native, 'stopGroup', {}))).toBe(
        'ERR_OWNED_CHILD_HANDLE',
      );
      handles.forEach((handle, m) => {
        if (m !== n)
          expect(nativeCode(() => invoke(native, 'stopGroup', handle))).toBe(
            'ERR_OWNED_CHILD_HANDLE',
          );
      });
      expect(invoke(native, 'observe', handles[n])).toEqual({
        state: 'running',
      });
    });
    const [native] = loads;
    evidence('members while running', {
      members: invoke(native, 'members', handles[0]),
    });
    loads.forEach((each, n) => {
      expect(invoke(each, 'rollbackSync', handles[n])).toBe(true);
      expect(nativeCode(() => invoke(each, 'observe', handles[n]))).toBe(
        'ERR_OWNED_CHILD_HANDLE',
      );
    });

    // An exited root: commit is refused; its console host may leave late.
    const spawned = invoke(
      native,
      'spawn',
      node,
      [node, '-e', 'process.exit(5)'],
      pairs,
      null,
    );
    const handle = field(spawned, 'handle');
    await until(
      () =>
        field(invoke(native, 'observe', handle), 'state') === 'exited'
          ? true
          : undefined,
      'native exit',
    );
    expect(invoke(native, 'observe', handle)).toEqual({
      state: 'exited',
      code: 5,
      signal: null,
    });
    expect(nativeCode(() => invoke(native, 'commit', handle))).toBe(
      'ERR_OWNED_CHILD_EXITED',
    );
    const started = Date.now();
    const membersAfterExit = invoke(native, 'members', handle);
    await until(
      () => (invoke(native, 'release', handle) === true ? true : undefined),
      'release after the console host leaves',
      2_000,
    );
    evidence('exited root', {
      membersAfterExit,
      releasedAfterMs: Date.now() - started,
    });

    const refusals: [string, unknown[]][] = [
      ['relative', ['node.exe', ['node.exe'], pairs, null]],
      ['device', ['\\\\.\\pipe\\owned', ['x'], pairs, null]],
      ['drive-relative', ['C:node.exe', ['x'], pairs, null]],
      ['stdin', [node, [node], pairs, '{"claim":null}']],
      ['entry without =', [node, [node], [...pairs, 'NOEQUALS'], null]],
      ['empty name', [node, [node], [...pairs, '=C:=C:\\'], null]],
      ['case duplicate', [node, [node], [...pairs, 'Path=a', 'PATH=b'], null]],
      ['too long', [node, [node, 'x'.repeat(32_767)], pairs, null]],
      ['no argv', [node, [], pairs, null]],
    ];
    const codes = Object.fromEntries(
      refusals.map(([name, args]) => [
        name,
        nativeCode(() => invoke(native, 'spawn', ...args)),
      ]),
    );
    expect(codes).toEqual(
      Object.fromEntries(
        refusals.map(([name]) => [name, 'ERR_OWNED_CHILD_ARGUMENT']),
      ),
    );
    expect(
      nativeCode(() =>
        invoke(
          native,
          'spawn',
          path.join(dir, 'missing.exe'),
          ['missing.exe'],
          pairs,
          null,
        ),
      ),
    ).toBe('ERR_OWNED_CHILD_SPAWN');
    // UTF-16 input: a lone surrogate is passed through, not refused.
    const lone = invoke(
      native,
      'spawn',
      node,
      [node, '-e', 'process.exit(0)', '\uD800'],
      pairs,
      null,
    );
    expect(invoke(native, 'rollbackSync', field(lone, 'handle'))).toBe(true);
  }, 60_000);

  it('maps refusals through the adapter with fixed text', async () => {
    const relative = await rejection(() =>
      services().spawn({
        executable: 'node.exe',
        args: [],
        environment: minimalEnvironment(),
      }),
    );
    expect(relative).toMatchObject({
      code: 'invalid_argument',
      message: 'Owned child request is invalid.',
    });
    const missing = await rejection(() =>
      services().spawn({
        executable: path.join(dir, 'missing.exe'),
        args: [],
        environment: minimalEnvironment(),
      }),
    );
    expect(missing).toMatchObject({
      code: 'failed_precondition',
      message: 'Owned child could not be started.',
    });
    const { child } = await launch('exited-commit', { exit: 0 });
    await child.exited;
    expect(() => child.commit()).toThrow('Owned child exited before commit.');
  }, 60_000);

  it('loads the addon in a renamed node.exe, the stand-in for the SEA CLI', async () => {
    const standIn = path.join(dir, 'canopy-sea-standin.exe');
    copyFileSync(process.execPath, standIn);
    const { stdout } = await run(
      standIn,
      [
        path.join(dir, 'loader.js'),
        addon,
        path.join(systemRoot, 'System32', 'cmd.exe'),
        path.join(systemRoot, 'System32', 'PING.EXE'),
      ],
      { windowsHide: true, timeout: 30_000 },
    );
    const result: unknown = JSON.parse(stdout);
    evidence('sea stand-in', result);
    expect(result).toMatchObject({
      observed: { state: 'exited', code: 7, signal: null },
      released: true,
      rolledBack: true,
    });
    const heldPid = field(result, 'heldPid');
    if (typeof heldPid === 'number')
      expect(await oracle(heldPid)).toBe('absent');
  }, 60_000);

  it('loads the Node-built addon in electron.exe', async () => {
    const electron = electronExecutable();
    if (electron === null) {
      evidence('electron', { skipped: 'electron.exe is not installed' });
      if (requireElectron) throw new Error('electron.exe is required');
      return;
    }
    const { stdout } = await run(
      electron,
      [
        path.join(dir, 'loader.js'),
        addon,
        path.join(systemRoot, 'System32', 'cmd.exe'),
        path.join(systemRoot, 'System32', 'PING.EXE'),
      ],
      {
        windowsHide: true,
        timeout: 60_000,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      },
    );
    const result: unknown = JSON.parse(stdout);
    evidence('electron', result);
    expect(field(result, 'electron')).toEqual(expect.any(String));
    expect(result).toMatchObject({
      observed: { state: 'exited', code: 7, signal: null },
      released: true,
      rolledBack: true,
    });
  }, 90_000);

  it('boots the built daemon with the launcher minimal environment', async () => {
    const daemon = builtDaemon();
    if (daemon === null) {
      evidence('daemon', { skipped: 'dist/core-daemon has no executable' });
      if (requireDaemon) throw new Error('A built core daemon is required');
      return;
    }
    const dataRoot = realpathSync.native(
      mkdtempSync(path.join(dir, 'daemon-')),
    );
    const runtime = path.join(dataRoot, 'runtime');
    mkdirSync(runtime);
    // The daemon refuses a data root other principals can reach.
    const sid = await windowsPrincipalObserver(HELPER)();
    const icacls = path.join(systemRoot, 'System32', 'icacls.exe');
    for (const target of [dataRoot, runtime]) {
      await run(icacls, [target, '/setowner', `*${sid}`], {
        windowsHide: true,
      });
      await run(
        icacls,
        [target, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`],
        { windowsHide: true },
      );
    }
    const environment = minimalEnvironment();
    const child = await services().spawn({
      executable: daemon,
      args: ['--data-root', dataRoot, '--runtime-mode', 'dev'],
      environment,
    });
    children.add(child);
    let exit: unknown = null;
    void child.exited.then((value) => (exit = value));
    const descriptor = await until(
      () => {
        if (exit !== null) return { exited: exit };
        const found = readJson(path.join(runtime, 'core.json'));
        return found === undefined ? undefined : { descriptor: found };
      },
      'the daemon descriptor',
      45_000,
    );
    evidence('daemon', {
      daemon,
      environmentKeys: Object.keys(environment).sort(),
      ...descriptor,
    });
    expect(field(field(descriptor, 'descriptor'), 'pid')).toBe(child.pid);
    await child.terminate();
    await expect(child.exited).resolves.toEqual({
      code: null,
      signal: 'SIGKILL',
    });
  }, 120_000);
});
