import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, chmod, mkdir, readFile, rename, rm } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

/**
 * Per-process disk bytes for the app's whole process tree: Electron main and
 * its renderer, GPU and utility processes, and every native descendant (the
 * `claude` and `codex` CLIs, PTY shells, `git`). `app.getAppMetrics()` covers
 * only Electron's own processes and has no disk counters, so this reads the
 * kernel's per-process counters instead:
 *
 * - macOS: `proc_pid_rusage(RUSAGE_INFO_V2)` through a small C helper
 *   (`native/proc-disk-bytes.c`) the harness compiles on first use into a
 *   temporary cache. It is never part of the app.
 * - Windows: the `Win32_Process` read and write transfer counts, through a
 *   PowerShell CIM query. They include all I/O the process issued, not only
 *   disk, so compare Windows runs only with Windows runs.
 *
 * The sampler reads the tree when the measured window opens, every
 * `intervalMs` during it, and when it closes. A process's window bytes are its
 * last reading minus its reading at the open (zero for a process born during
 * the window), so a process that exits mid-window still counts up to its last
 * sample. A process living shorter than one interval can be missed. Nothing
 * here throws into a run: an unbuildable helper or a failed read is reported
 * as the result's `error`.
 */

const execFileAsync = promisify(execFile);

export const DISK_IO_SOURCE = 'disk';
export const DEFAULT_DISK_IO_INTERVAL_MS = 2_000;
const HELPER_HEADER = 'proc-disk-bytes\t1';
const HELPER_SOURCE_URL = new URL(
  './native/proc-disk-bytes.c',
  import.meta.url,
);
const DEFAULT_HELPER_CACHE_DIR = path.join(tmpdir(), 'canopy-perf-disk-io');
const READ_TIMEOUT_MS = 10_000;

function toCount(value) {
  const number = typeof value === 'string' ? Number(value) : value;
  return Number.isFinite(number) && number > 0 ? number : 0;
}

/** Parses the macOS helper's tab-separated output. */
export function parseMacDiskIoOutput(stdout) {
  const lines = String(stdout).split('\n');
  if (lines[0] !== HELPER_HEADER) {
    throw new Error(`Unexpected proc-disk-bytes output: ${lines[0] ?? ''}`);
  }
  const processes = [];
  const errors = [];
  let truncated = false;
  for (const line of lines.slice(1)) {
    const fields = line.split('\t');
    if (fields[0] === 'p' && fields.length >= 7) {
      const pid = Number(fields[1]);
      const ppid = Number(fields[2]);
      if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid)) continue;
      processes.push({
        pid,
        ppid,
        startId: fields[3],
        name: fields.slice(6).join('\t'),
        commandLine: null,
        readBytes: toCount(fields[4]),
        writtenBytes: toCount(fields[5]),
      });
    } else if (fields[0] === 't') {
      truncated = true;
    } else if (fields[0] === 'e' && fields.length >= 3) {
      const pid = Number(fields[1]);
      if (Number.isSafeInteger(pid))
        errors.push({ pid, errno: Number(fields[2]) });
    }
  }
  return { processes, errors, truncated };
}

/** The PowerShell CIM query the Windows sampler runs. */
export function windowsDiskIoQuery() {
  return [
    'Get-CimInstance -ClassName Win32_Process',
    '| Select-Object ProcessId,ParentProcessId,Name,CommandLine,CreationDate,ReadTransferCount,WriteTransferCount',
    '| ConvertTo-Json -Compress',
  ].join(' ');
}

/** Parses `Win32_Process` rows serialized by `ConvertTo-Json`. */
export function parseWindowsDiskIoOutput(stdout) {
  const parsed = JSON.parse(String(stdout));
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const processes = [];
  for (const row of rows) {
    const pid = Number(row?.ProcessId);
    const ppid = Number(row?.ParentProcessId);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid)) continue;
    processes.push({
      pid,
      ppid,
      startId: typeof row.CreationDate === 'string' ? row.CreationDate : '',
      name: typeof row.Name === 'string' ? row.Name : '',
      commandLine: typeof row.CommandLine === 'string' ? row.CommandLine : null,
      readBytes: toCount(row.ReadTransferCount),
      writtenBytes: toCount(row.WriteTransferCount),
    });
  }
  return { processes, errors: [] };
}

/** The root and all of its descendants, in input order. */
export function selectProcessTree(processes, rootPid) {
  const included = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of processes) {
      if (!included.has(row.pid) && included.has(row.ppid)) {
        included.add(row.pid);
        changed = true;
      }
    }
  }
  return processes.filter((row) => included.has(row.pid));
}

const SHELL_NAMES = new Set([
  'bash',
  'cmd',
  'dash',
  'fish',
  'login',
  'powershell',
  'pwsh',
  'sh',
  'spawn-helper',
  'tcsh',
  'zsh',
]);

/**
 * The role a process plays: `main`, `renderer`, `gpu`, `utility`, `claude`,
 * `codex`, `git`, `shell`, or `other`.
 */
export function classifyDiskIoProcess(row, rootPid) {
  if (row.pid === rootPid) return 'main';
  const commandLine = row.commandLine ?? '';
  const type = /--type=([\w-]+)/.exec(commandLine)?.[1];
  if (type === 'renderer' || /Helper \(Renderer\)/.test(row.name)) {
    return 'renderer';
  }
  if (type === 'gpu-process' || /Helper \(GPU\)/.test(row.name)) return 'gpu';
  if (type !== undefined || /Helper( \(Plugin\))?$/.test(row.name)) {
    return 'utility';
  }
  const base = path
    .basename(row.name.replaceAll('\\', '/'))
    .replace(/\.exe$/i, '')
    .toLowerCase();
  if (base === 'claude') return 'claude';
  if (base === 'codex' || base.startsWith('codex-')) return 'codex';
  if (base === 'git' || base.startsWith('git-')) return 'git';
  if (SHELL_NAMES.has(base)) return 'shell';
  return 'other';
}

function processKey(row) {
  return `${row.pid}:${row.startId}`;
}

/**
 * Window counters from ordered tree samples: per class, the processes seen and
 * the bytes read and written since the first sample.
 */
export function diffDiskIoSamples(samples, rootPid) {
  const [first = []] = samples;
  const baseline = new Map(first.map((row) => [processKey(row), row]));
  const latest = new Map();
  for (const sample of samples) {
    for (const row of sample) latest.set(processKey(row), row);
  }
  const counters = {};
  const add = (key, value) => {
    counters[key] = (counters[key] ?? 0) + value;
  };
  for (const [key, row] of latest) {
    const start = baseline.get(key);
    const readBytes = Math.max(0, row.readBytes - (start?.readBytes ?? 0));
    const writtenBytes = Math.max(
      0,
      row.writtenBytes - (start?.writtenBytes ?? 0),
    );
    for (const scope of [classifyDiskIoProcess(row, rootPid), 'total']) {
      add(`${scope}.processes`, 1);
      add(`${scope}.readBytes`, readBytes);
      add(`${scope}.writtenBytes`, writtenBytes);
    }
  }
  return counters;
}

async function isExecutable(file) {
  try {
    await access(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function compileWithHostCompiler({ sourcePath, outputPath }) {
  const flags = ['-O2', '-Wall', '-o', outputPath, sourcePath];
  try {
    await execFileAsync('xcrun', ['--sdk', 'macosx', 'clang', ...flags], {
      timeout: 60_000,
    });
  } catch {
    await execFileAsync('cc', flags, { timeout: 60_000 });
  }
}

/**
 * Builds the macOS helper once per source revision into `cacheDir`. Returns
 * `{ path }`, or `{ unavailable }` with the reason it cannot be built.
 */
export async function ensureMacDiskIoHelper({
  cacheDir = DEFAULT_HELPER_CACHE_DIR,
  compile = compileWithHostCompiler,
  sourcePath = fileURLToPath(HELPER_SOURCE_URL),
} = {}) {
  try {
    const source = await readFile(sourcePath);
    const digest = createHash('sha256').update(source).digest('hex');
    const helperPath = path.join(
      cacheDir,
      `proc-disk-bytes-${digest.slice(0, 16)}`,
    );
    if (await isExecutable(helperPath))
      return { path: helperPath, sourceSha256: digest };
    await mkdir(cacheDir, { recursive: true });
    const outputPath = `${helperPath}.${process.pid}.tmp`;
    try {
      await compile({ sourcePath, outputPath });
      await chmod(outputPath, 0o755);
      await rename(outputPath, helperPath);
    } finally {
      await rm(outputPath, { force: true });
    }
    return { path: helperPath, sourceSha256: digest };
  } catch (error) {
    return {
      unavailable: `helper build failed: ${
        error instanceof Error ? error.message.split('\n')[0] : String(error)
      }`,
    };
  }
}

/** The platform reader: `{ read(rootPid) }` or `{ unavailable }`. */
export async function createDiskIoReader(platform = process.platform) {
  if (platform === 'darwin') {
    const helper = await ensureMacDiskIoHelper();
    if (helper.unavailable) return { unavailable: helper.unavailable };
    return {
      async read(rootPid) {
        const { stdout } = await execFileAsync(helper.path, [String(rootPid)], {
          encoding: 'utf8',
          timeout: READ_TIMEOUT_MS,
          maxBuffer: 8 * 1024 * 1024,
        });
        const result = parseMacDiskIoOutput(stdout);
        if (result.truncated || result.errors.length) {
          throw new Error(
            `incomplete native disk sample: ${JSON.stringify(result)}`,
          );
        }
        return result.processes;
      },
    };
  }
  if (platform === 'win32') {
    return {
      async read() {
        const { stdout } = await execFileAsync(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', windowsDiskIoQuery()],
          {
            encoding: 'utf8',
            timeout: READ_TIMEOUT_MS,
            maxBuffer: 16 * 1024 * 1024,
            windowsHide: true,
          },
        );
        return parseWindowsDiskIoOutput(stdout).processes;
      },
    };
  }
  return { unavailable: `no per-process disk counters on ${platform}` };
}

function errorText(error) {
  return error instanceof Error ? error.message.split('\n')[0] : String(error);
}

/**
 * Prepares sampling of the tree rooted at `rootPid` without reading it. The
 * platform reader, a native helper build on macOS, is created here, outside
 * any measured window. `start()` takes the baseline sample at the window
 * boundary and returns the running sampler, whose `stop()` takes the closing
 * sample and resolves to `{ counters, sampleCount }` or `{ error }`; it never
 * rejects. `reader` and `createReader` are injectable for tests.
 */
export async function prepareDiskIoSampler({
  rootPid,
  intervalMs = DEFAULT_DISK_IO_INTERVAL_MS,
  reader,
  platform = process.platform,
  createReader = createDiskIoReader,
} = {}) {
  const resolved = reader ?? (await createReader(platform));
  return { start: () => startWithReader(resolved, rootPid, intervalMs) };
}

async function startWithReader(resolved, rootPid, intervalMs) {
  if (resolved.unavailable) {
    const error = `unavailable: ${resolved.unavailable}`;
    return { stop: async () => ({ error }) };
  }
  const readTree = async () => {
    const tree = selectProcessTree(await resolved.read(rootPid), rootPid);
    if (!tree.some((row) => row.pid === rootPid)) {
      throw new Error(`root process ${rootPid} was not found`);
    }
    return tree;
  };
  let first;
  try {
    first = await readTree();
  } catch (error) {
    const failure = { error: `start sample failed: ${errorText(error)}` };
    return { stop: async () => failure };
  }
  const samples = [first];
  const intervalErrors = [];
  const abort = new AbortController();
  const loop = (async () => {
    while (!abort.signal.aborted) {
      try {
        await delay(intervalMs, undefined, { signal: abort.signal });
      } catch {
        return;
      }
      try {
        samples.push(await readTree());
      } catch (error) {
        intervalErrors.push(errorText(error));
      }
    }
  })();
  let result;
  return {
    async stop() {
      if (result) return result;
      abort.abort();
      await loop;
      try {
        samples.push(await readTree());
        if (intervalErrors.length) {
          throw new Error(
            `interval samples failed: ${intervalErrors.join('; ')}`,
          );
        }
        result = {
          counters: diffDiskIoSamples(samples, rootPid),
          sampleCount: samples.length,
        };
      } catch (error) {
        result = { error: `stop sample failed: ${errorText(error)}` };
      }
      return result;
    },
  };
}

/** Prepares and starts sampling in one step. */
export async function startDiskIoSampler(options = {}) {
  return (await prepareDiskIoSampler(options)).start();
}

/** Prepares sampling of the tree rooted at the app's Electron main process. */
export async function prepareAppDiskIoSampler(electronApp, options = {}) {
  let rootPid;
  try {
    rootPid = await electronApp.evaluate(() => process.pid);
  } catch (error) {
    const failure = { error: `main pid unavailable: ${errorText(error)}` };
    return { start: async () => ({ stop: async () => failure }) };
  }
  return prepareDiskIoSampler({ ...options, rootPid });
}

/** Adds a sampler result to a scenario's work, or records why it is missing. */
export function mergeDiskIoWork(work, result) {
  if (result?.counters) return { ...work, [DISK_IO_SOURCE]: result.counters };
  return {
    ...work,
    errors: [
      ...(work.errors ?? []),
      {
        source: DISK_IO_SOURCE,
        message: result?.error ?? 'not sampled',
      },
    ],
  };
}
