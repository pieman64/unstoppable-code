import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

/**
 * A Node fixture's connection to the suite. The kernel closes it when the
 * fixture's process ends, so an open lifeline proves that the process first
 * seen as `pid` still runs, without any process query.
 */
export interface Lifeline {
  readonly role: string;
  readonly fixture: string;
  readonly pid: number;
  readonly openedAt: number;
  closedAt: number | null;
  readonly events: { readonly event: string; readonly at: number; readonly detail: unknown }[]; // prettier-ignore
  readonly socket: Socket;
  stranded: boolean;
}

/** A non-Node process, identified by its .NET start time (GetProcessTimes), not CIM. */
export interface NativeProcess {
  readonly label: string;
  readonly pid: number;
  /** FILETIME UTC; null when the snapshot failed or found no process. */
  readonly start: string | null;
  readonly absentAtSnapshot: boolean;
  readonly snapshotFailure: unknown;
  stranded: boolean;
}

export type Liveness =
  | { readonly state: 'alive' | 'gone'; readonly how: string }
  | { readonly state: 'unknown'; readonly how: string; readonly failure: unknown }; // prettier-ignore

export interface ProcessRow {
  readonly pid: number;
  readonly ppid: number;
  readonly name: string;
  /** CIM CreationDate as FILETIME UTC digits, for ordering only. */
  readonly created: string;
  readonly commandLine: string;
}

export interface CleanupResult {
  readonly tracked: { readonly lifelines: number; readonly natives: number };
  readonly actions: unknown[];
  readonly survivors: unknown[];
}

export interface FixtureProcesses {
  /** JS that joins the lifeline as `role`; `fixture` is a JS expression. */
  join(role: string, fixture: string): string;
  lifeline(fixtureDir: string, role: string, ms?: number): Promise<Lifeline>;
  find(fixtureDir: string, role: string): Lifeline | undefined;
  closedWithin(line: Lifeline, ms: number): Promise<boolean>;
  trackNatives(entries: readonly { label: string; pid: number }[]): NativeProcess[]; // prettier-ignore
  nativeStates(list: readonly NativeProcess[]): Liveness[];
  /** .NET identities by PID, as recorded evidence. */
  identities(pids: readonly number[]): unknown;
  processTable(): { rows: ProcessRow[] } | { failure: unknown };
  /** Ends what remains; `all` includes earlier tests' survivors. */
  reap(scope: 'test' | 'all'): Promise<CleanupResult>;
  close(): Promise<void>;
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
const field = (value: unknown, key: string): unknown =>
  Reflect.get(Object(value), key);
const text = (value: unknown, key: string): string => {
  const found = field(value, key);
  return typeof found === 'string' ? found : '';
};
const fixtureKey = (dir: string): string => basename(dir).toLowerCase();
const filetimeOrder = (digits: string): string => digits.padStart(24, '0');

/** A PID is present; the process it names may be another one. */
export function present(pid: number): boolean {
  if (pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return field(error, 'code') === 'EPERM';
  }
}

function lifelineModule(address: string): string {
  return [
    "'use strict';",
    "const { connect } = require('node:net');",
    'module.exports = (role, fixture) => {',
    `  const socket = connect(${JSON.stringify(address)});`,
    "  const line = (message) => JSON.stringify(message) + '\\n';",
    '  socket.write(line({ role, fixture, pid: process.pid }));',
    "  socket.on('data', (data) => { if (String(data).includes('exit')) process.exit(0); });", // prettier-ignore
    '  // Nothing can reap this fixture once the suite is gone, so it ends itself.',
    "  socket.on('close', () => process.exit(70));",
    "  socket.on('error', () => undefined);",
    '  return {',
    '    report: (event, detail = null) => socket.write(line({ event, detail })),', // prettier-ignore
    '    finish: (event, detail, code) => socket.end(line({ event, detail }), () => process.exit(code)),', // prettier-ignore
    '  };',
    '};',
  ].join('\n');
}

/** Each fixture-started process, tracked so cleanup can end it and confirm it gone. */
export async function createFixtureProcesses(options: {
  readonly dir: string;
  readonly systemRoot: string;
}): Promise<FixtureProcesses> {
  const { dir, systemRoot } = options;
  const address =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\canopy-git-read-${process.pid}-${randomUUID()}`
      : join(tmpdir(), `cgr-${process.pid}.sock`);
  const modulePath = join(dir, 'lifeline.js');
  writeFileSync(modulePath, lifelineModule(address));
  const lifelines: Lifeline[] = [];
  const natives: NativeProcess[] = [];
  const confirmedGone = new Set<NativeProcess>();
  let reapedLifelines = 0;
  let reapedNatives = 0;

  const server = createServer((socket) => {
    let buffered = '';
    let line: Lifeline | undefined;
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffered += chunk;
      for (
        let end = buffered.indexOf('\n');
        end >= 0;
        end = buffered.indexOf('\n')
      ) {
        const raw = buffered.slice(0, end);
        buffered = buffered.slice(end + 1);
        let message: unknown;
        try {
          message = JSON.parse(raw);
        } catch {
          continue;
        }
        const pid = field(message, 'pid');
        if (line === undefined && typeof pid === 'number') {
          line = {
            role: text(message, 'role'),
            fixture: text(message, 'fixture').toLowerCase(),
            pid,
            openedAt: performance.now(),
            closedAt: null,
            events: [],
            socket,
            stranded: false,
          };
          lifelines.push(line);
        } else if (line !== undefined) {
          const event = text(message, 'event');
          line.events.push({ event, at: performance.now(), detail: field(message, 'detail') }); // prettier-ignore
        }
      }
    });
    socket.on('error', () => undefined);
    socket.on('close', () => {
      if (line !== undefined) line.closedAt = performance.now();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(address, () => resolve());
  });

  const powershell = (
    script: string,
  ): { lines: string[] } | { failure: Record<string, unknown> } => {
    const file = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'); // prettier-ignore
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const result = spawnSync(
      file,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { encoding: 'utf8', windowsHide: true, timeout: 30_000 },
    );
    const stdout = result.stdout ?? '';
    if (result.error !== undefined || result.status !== 0)
      return {
        failure: {
          status: result.status,
          signal: result.signal,
          error: result.error === undefined ? null : String(result.error),
          stderr: (result.stderr ?? '').slice(0, 800),
          stdout: stdout.slice(0, 400),
        },
      };
    return { lines: stdout.split(/\r?\n/).filter(Boolean) };
  };

  type Observed =
    | {
        readonly kind: 'running';
        readonly start: string;
        readonly name: string;
      }
    | { readonly kind: 'absent' | 'other' | 'killed' }
    | { readonly kind: 'failed'; readonly failure: unknown };

  /** One result per PID; a failed query fails every PID with its output. */
  const parse = (
    pids: readonly number[],
    output: ReturnType<typeof powershell>,
  ): Map<number, Observed> => {
    const results = new Map<number, Observed>();
    if ('failure' in output) {
      for (const pid of pids)
        results.set(pid, { kind: 'failed', failure: output.failure });
      return results;
    }
    for (const row of output.lines) {
      const match = /^(\d+) (running|absent|other|killed|failed)(?: (.*))?$/.exec(row.trim()); // prettier-ignore
      if (!match) continue;
      const [, id = '', kind = '', rest = ''] = match;
      const pid = Number(id);
      if (kind === 'running') {
        const [start = '', ...name] = rest.split(' ');
        results.set(pid, { kind, start, name: name.join(' ') });
      } else if (kind === 'failed') {
        results.set(pid, { kind, failure: rest });
      } else if (kind === 'absent' || kind === 'other' || kind === 'killed') {
        results.set(pid, { kind });
      }
    }
    for (const pid of pids)
      if (!results.has(pid))
        results.set(pid, { kind: 'failed', failure: { noRow: output.lines.slice(0, 5) } }); // prettier-ignore
    return results;
  };

  // Get-Process reads the start time through OpenProcess and GetProcessTimes.
  const IDENTITY_LOOP = [
    "$ErrorActionPreference = 'Stop'",
    'foreach ($e in $entries) {',
    "  $id, $start = $e -split ':'",
    '  $p = Get-Process -Id ([int]$id) -ErrorAction SilentlyContinue',
    '  if ($null -eq $p) { "$id absent"; continue }',
    '  try { $now = [string]$p.StartTime.ToFileTimeUtc() } catch { "$id failed $($_.Exception.Message -replace \'\\s+\', \' \')"; continue }', // prettier-ignore
    '  if ($start -eq \'\') { "$id running $now $($p.ProcessName)"; continue }',
    '  if ($now -ne $start) { "$id other"; continue }',
    '  try { $p.Kill(); [void]$p.WaitForExit(5000); "$id killed" } catch { "$id failed $($_.Exception.Message -replace \'\\s+\', \' \')" }', // prettier-ignore
    '}',
  ].join('\n');
  /** Reads identities; with a start, kills the process only if it still has that start. */
  const identityScript = (entries: readonly string[]): string =>
    `$entries = @(${entries.map((entry) => `'${entry}'`).join(', ')})\n${IDENTITY_LOOP}`; // prettier-ignore
  const observe = (pids: readonly number[]): Map<number, Observed> =>
    pids.length === 0
      ? new Map<number, Observed>()
      : parse(pids, powershell(identityScript(pids.map((pid) => `${pid}:`))));
  const killMatching = (
    list: readonly NativeProcess[],
  ): Map<number, Observed> => {
    const entries = list.map(({ pid, start }) => `${pid}:${start ?? ''}`);
    return parse(
      list.map(({ pid }) => pid),
      powershell(identityScript(entries)),
    );
  };

  const nativeStates = (
    list: readonly NativeProcess[],
  ): Map<NativeProcess, Liveness> => {
    const states = new Map<NativeProcess, Liveness>();
    const query: NativeProcess[] = [];
    for (const native of list) {
      if (native.absentAtSnapshot)
        states.set(native, { state: 'gone', how: 'absent at snapshot' });
      else if (!present(native.pid))
        states.set(native, { state: 'gone', how: 'pid absent' });
      else if (native.start === null)
        states.set(native, { state: 'unknown', how: 'no start identity', failure: native.snapshotFailure }); // prettier-ignore
      else query.push(native);
    }
    const observed = observe(query.map(({ pid }) => pid));
    for (const native of query) {
      const now = observed.get(native.pid);
      if (now === undefined || now.kind === 'failed')
        states.set(native, { state: 'unknown', how: 'identity query failed', failure: now?.kind === 'failed' ? now.failure : null }); // prettier-ignore
      else if (now.kind === 'running')
        states.set(native, now.start === native.start ? { state: 'alive', how: 'same start time' } : { state: 'gone', how: 'pid reused' }); // prettier-ignore
      else states.set(native, { state: 'gone', how: `query: ${now.kind}` });
    }
    return states;
  };

  const label = (line: Lifeline): string => `${line.role} (${line.fixture})`;
  const find = (fixtureDir: string, role: string): Lifeline | undefined =>
    lifelines.find(
      (line) => line.fixture === fixtureKey(fixtureDir) && line.role === role,
    );

  return {
    join: (role, fixture) =>
      `require(${JSON.stringify(modulePath)})(${JSON.stringify(role)}, ${fixture})`,

    async lifeline(fixtureDir, role, ms = 20_000): Promise<Lifeline> {
      const end = performance.now() + ms;
      for (;;) {
        const found = find(fixtureDir, role);
        if (found !== undefined) return found;
        if (performance.now() >= end)
          throw new Error(`No ${role} lifeline from ${basename(fixtureDir)} within ${ms} ms`); // prettier-ignore
        await delay(25);
      }
    },

    find,

    async closedWithin(line, ms): Promise<boolean> {
      const end = performance.now() + ms;
      while (line.closedAt === null && performance.now() < end) await delay(25);
      return line.closedAt !== null;
    },

    trackNatives(entries): NativeProcess[] {
      const pids = entries.map(({ pid }) => pid);
      const output = powershell(identityScript(pids.map((pid) => `${pid}:`)));
      const observed = parse(pids, output);
      const tracked = entries.map(({ label: name, pid }): NativeProcess => {
        const first = observed.get(pid);
        return {
          label: name,
          pid,
          start: first?.kind === 'running' ? first.start : null,
          absentAtSnapshot: first?.kind === 'absent',
          snapshotFailure: first?.kind === 'failed' ? first.failure : null,
          stranded: false,
        };
      });
      natives.push(...tracked);
      return tracked;
    },

    nativeStates(list): Liveness[] {
      const states = nativeStates(list);
      return list.map((native) => states.get(native) ?? { state: 'unknown', how: 'no result', failure: null }); // prettier-ignore
    },

    identities(pids): unknown {
      return Object.fromEntries(observe(pids));
    },

    processTable(): { rows: ProcessRow[] } | { failure: unknown } {
      const output = powershell(
        [
          "$ErrorActionPreference = 'Stop'",
          'Get-CimInstance -ClassName Win32_Process | ForEach-Object {',
          "  $c = if ($null -eq $_.CreationDate) { '0' } else { [string]$_.CreationDate.ToUniversalTime().ToFileTimeUtc() }", // prettier-ignore
          "  '{0}|{1}|{2}|{3}|{4}' -f $_.ProcessId, $_.ParentProcessId, $c, $_.Name, ([string]$_.CommandLine -replace '[\\r\\n|]', ' ')", // prettier-ignore
          '}',
        ].join('\n'),
      );
      if ('failure' in output) return { failure: output.failure };
      const rows = output.lines.map((row): ProcessRow => {
        const [pid = '', ppid = '', created = '', name = '', ...command] = row.split('|'); // prettier-ignore
        const commandLine = command.join('|');
        return { pid: Number(pid), ppid: Number(ppid), created, name, commandLine }; // prettier-ignore
      });
      return { rows };
    },

    async reap(scope): Promise<CleanupResult> {
      const inScope = <T extends { stranded: boolean }>(list: T[]): T[] =>
        list.filter((item) => scope === 'all' || !item.stranded);
      const pending = (): NativeProcess[] =>
        inScope(natives).filter((native) => !confirmedGone.has(native));
      const tracked = {
        lifelines: lifelines.length - reapedLifelines,
        natives: natives.length - reapedNatives,
      };
      reapedLifelines = lifelines.length;
      reapedNatives = natives.length;
      const actions: unknown[] = [];
      const survivors = (): {
        open: Lifeline[];
        live: [NativeProcess, Liveness][];
      } => ({
        open: inScope(lifelines).filter((line) => line.closedAt === null),
        live: Array.from(nativeStates(pending())).filter(
          ([, liveness]) => liveness.state !== 'gone',
        ),
      });
      // Bounded: ask, then terminate; a native is killed only at its start time.
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const { open, live } = survivors();
        if (open.length === 0 && live.length === 0) break;
        for (const line of open) {
          if (attempt === 1) {
            line.socket.write('exit\n');
            actions.push({ attempt, process: label(line), pid: line.pid, via: 'exit request' }); // prettier-ignore
            continue;
          }
          // The open lifeline shows the PID still names this fixture.
          let error: unknown = null;
          try {
            process.kill(line.pid);
          } catch (caught) {
            error = String(caught);
          }
          actions.push({ attempt, process: label(line), pid: line.pid, via: 'terminate', error }); // prettier-ignore
        }
        const killable = live
          .filter(([, liveness]) => liveness.state === 'alive')
          .map(([native]) => native);
        if (killable.length > 0) {
          const killed = killMatching(killable);
          for (const native of killable)
            actions.push({ attempt, process: native.label, pid: native.pid, via: 'kill at start time', result: killed.get(native.pid) }); // prettier-ignore
        }
        const end = performance.now() + 3000;
        while (
          performance.now() < end &&
          open.some((line) => line.closedAt === null)
        )
          await delay(25);
      }
      const { open, live } = survivors();
      for (const line of open) line.stranded = true;
      for (const native of pending()) confirmedGone.add(native);
      for (const [native] of live) {
        native.stranded = true;
        confirmedGone.delete(native);
      }
      return {
        tracked,
        actions,
        survivors: [
          ...open.map((line) => ({ process: label(line), pid: line.pid, how: 'lifeline open' })), // prettier-ignore
          ...live.map(([native, liveness]) => ({ process: native.label, pid: native.pid, ...liveness })), // prettier-ignore
        ],
      };
    },

    async close(): Promise<void> {
      for (const line of lifelines) line.socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Descendants of `root` in the table, each created no earlier than its parent. */
export function descendantsOf(
  rows: readonly ProcessRow[],
  root: number,
): ProcessRow[] {
  const found: ProcessRow[] = [];
  const first = rows.find((row) => row.pid === root);
  const queue = first === undefined ? [] : [first];
  for (
    let parent = queue.shift();
    parent !== undefined;
    parent = queue.shift()
  ) {
    const { pid, created } = parent;
    for (const row of rows)
      if (
        row.ppid === pid &&
        row.pid !== pid &&
        filetimeOrder(row.created) >= filetimeOrder(created) &&
        !found.includes(row)
      ) {
        found.push(row);
        queue.push(row);
      }
  }
  return found;
}

/**
 * Rows created since `since` that run under one of `names` or in `dir`,
 * except the PowerShell `self` started for this table and what it started.
 */
export function startedSince(
  rows: readonly ProcessRow[],
  options: {
    readonly self: number;
    readonly since: string;
    readonly dir: string;
    readonly names: ReadonlySet<string>;
  },
): ProcessRow[] {
  const query = rows.filter(
    ({ ppid, name }) =>
      ppid === options.self && name.toLowerCase() === 'powershell.exe',
  );
  const excluded = new Set(
    [...query, ...query.flatMap(({ pid }) => descendantsOf(rows, pid))].map(({ pid }) => pid), // prettier-ignore
  );
  const inDir = options.dir.toLowerCase();
  return rows.filter(
    (row) =>
      !excluded.has(row.pid) &&
      createdSince(row, options.since) &&
      (options.names.has(row.name.toLowerCase()) ||
        row.commandLine.toLowerCase().includes(inDir)),
  );
}

/** `Date.now()` as FILETIME UTC digits. */
export function filetimeAt(epochMs: number): string {
  return `${Math.floor(epochMs) + 11_644_473_600_000}0000`;
}

export function createdSince(row: ProcessRow, filetime: string): boolean {
  return filetimeOrder(row.created) >= filetimeOrder(filetime);
}
