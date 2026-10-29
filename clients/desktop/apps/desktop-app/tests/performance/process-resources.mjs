import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { ensureMacDiskIoHelper } from './disk-io.mjs';

const execute = promisify(execFile);
const MAX_IDENTITIES = 1024;
const METRICS = [
  'residentBytes',
  'physicalFootprintBytes',
  'userCpuNs',
  'systemCpuNs',
  'packageIdleWakeups',
  'interruptWakeups',
  'readBytes',
  'writtenBytes',
];
const NATIVE_QUANTITIES = ['openFileDescriptors', 'machIpcInUseNameEntries'];
const START_ID = /^(0|[1-9]\d*)\.\d{6}$/;
const UINT64_MAX = 18446744073709551615n;

function isStartId(value) {
  return (
    typeof value === 'string' &&
    START_ID.test(value) &&
    BigInt(value.split('.')[0]) <= UINT64_MAX
  );
}

function counter(text) {
  if (text === '-') return null;
  if (!/^(0|[1-9]\d*)$/.test(text) || BigInt(text) > UINT64_MAX) {
    throw new Error('Invalid native resource counter');
  }
  // Decimal strings preserve uint64 precision in JSON artifacts.
  return text;
}

function pid(text, allowZero = false) {
  const value = Number(text);
  if (
    !/^\d+$/.test(String(text)) ||
    !Number.isSafeInteger(value) ||
    value < (allowZero ? 0 : 1) ||
    value > 2147483647
  ) {
    throw new Error('Invalid process pid');
  }
  return value;
}

function parseNativeProcessRow(f) {
  if (f.length !== 14 || !isStartId(f[3]) || !['live', 'zombie'].includes(f[4]))
    throw new Error(`Invalid native resource row: ${f.join('\t')}`);
  const counters = f.slice(5, 13).map(counter);
  if (f[4] === 'zombie' && counters.some((value) => value !== null)) {
    throw new Error('Zombie counters must be unknown');
  }
  return {
    pid: pid(f[1]),
    ppid: pid(f[2], true),
    startId: f[3],
    state: f[4],
    ...Object.fromEntries(METRICS.map((key, i) => [key, counters[i]])),
    name: f[13],
  };
}

function parseNativeErrorRow(f) {
  if (
    f.length !== 5 ||
    !(f[2] === '-' || isStartId(f[2])) ||
    !/^[a-z_]+$/.test(f[3])
  )
    throw new Error(`Invalid native resource row: ${f.join('\t')}`);
  return {
    pid: pid(f[1]),
    startId: f[2] === '-' ? null : f[2],
    stage: f[3],
    errno: pid(f[4]),
  };
}

function validateNativeCounters(processes, errors) {
  for (const row of processes) {
    if (
      row.state === 'live' &&
      METRICS.some((key) => row[key] === null) &&
      !errors.some(
        (error) => error.pid === row.pid && error.startId === row.startId,
      )
    ) {
      throw new Error('Unknown native counters without an error');
    }
  }
}

function validQuantityDiagnostics(f) {
  const [, , , name, status, , domain, code, stage, cleanupCode] = f;
  if (status === 'unavailable') return stage === 'zombie';
  const isFd = name === 'openFileDescriptors';
  // Protocol v2 is macOS-native, regardless of the parser host's errno values.
  const unsupportedCode = isFd ? '45' : '46'; // ENOTSUP / KERN_NOT_SUPPORTED.
  if (
    (status === 'unsupported') !== (code === unsupportedCode) ||
    (isFd && stage !== 'proc_pidlistfds') ||
    (!isFd &&
      ![
        'task_for_pid',
        'mach_port_space_basic_info',
        'mach_port_deallocate',
      ].includes(stage))
  )
    return false;
  if (status === 'ok' && !isFd && stage !== 'mach_port_space_basic_info')
    return false;
  // Only an inspection failure can carry a separate task-right cleanup failure.
  return (
    cleanupCode === '0' ||
    (domain === 'mach' && stage === 'mach_port_space_basic_info')
  );
}

function parseQuantityRow(f) {
  const value = counter(f[5] ?? 'invalid');
  if (
    f.length !== 10 ||
    !/^(0|[1-9]\d*)$/.test(f[9]) ||
    Number(f[9]) > 2147483647 ||
    (f[9] !== '0' &&
      (f[6] !== 'mach' || !['error', 'unsupported'].includes(f[4]))) ||
    !/^[a-z_]+$/.test(f[8]) ||
    !isStartId(f[2]) ||
    !NATIVE_QUANTITIES.includes(f[3]) ||
    !['ok', 'error', 'unsupported', 'unavailable'].includes(f[4]) ||
    (f[4] !== 'unavailable' &&
      f[6] !== (f[3] === 'openFileDescriptors' ? 'errno' : 'mach')) ||
    !/^(0|[1-9]\d*)$/.test(f[7]) ||
    Number(f[7]) > 2147483647 ||
    (f[4] === 'ok' ? value === null || f[7] !== '0' : value !== null) ||
    (['error', 'unsupported'].includes(f[4]) && f[7] === '0') ||
    (f[4] === 'unavailable' && (f[6] !== 'process' || f[7] !== '0')) ||
    !validQuantityDiagnostics(f)
  )
    throw new Error('Invalid native quantity');
  return {
    pid: pid(f[1]),
    startId: f[2],
    name: f[3],
    result: {
      status: f[4],
      value,
      domain: f[6],
      code: Number(f[7]),
      stage: f[8],
      ...(f[9] === '0'
        ? {}
        : {
            cleanupError: {
              domain: 'mach',
              code: Number(f[9]),
              stage: 'mach_port_deallocate',
            },
          }),
    },
  };
}

function attachNativeQuantities(processes, quantities, version) {
  for (const q of quantities) {
    const row = processes.find(
      (row) => row.pid === q.pid && row.startId === q.startId,
    );
    if (
      !row ||
      row.quantities?.[q.name] ||
      (row.state === 'zombie') !== (q.result.status === 'unavailable')
    ) {
      throw new Error('Orphan, duplicate or inconsistent native quantity');
    }
    row.quantities ??= {};
    row.quantities[q.name] = q.result;
  }
  if (
    version === 'proc-resources\t2' &&
    processes.some((row) =>
      NATIVE_QUANTITIES.some((key) => !row.quantities?.[key]),
    )
  ) {
    throw new Error('Missing native quantity');
  }
}

/** Strict framed protocol; partial output must never look like an empty sample. */
export function parseNativeResourceOutput(stdout) {
  const lines = String(stdout).trimEnd().split('\n');
  const version = lines.shift();
  if (
    !['proc-resources\t1', 'proc-resources\t2'].includes(version) ||
    lines.pop() !== 'end'
  ) {
    throw new Error('Incomplete or unsupported native resource output');
  }
  const processes = [];
  const errors = [];
  const seen = new Set();
  const quantities = [];
  let truncated = false;
  for (const line of lines) {
    const f = line.split('\t');
    if (f[0] === 'p') {
      const row = parseNativeProcessRow(f);
      if (seen.has(row.pid)) throw new Error('Duplicate native process');
      seen.add(row.pid);
      processes.push(row);
    } else if (f[0] === 'q' && version === 'proc-resources\t2') {
      quantities.push(parseQuantityRow(f));
    } else if (f[0] === 'e') {
      errors.push(parseNativeErrorRow(f));
    } else if (f[0] === 't' && f.length === 3 && pid(f[1]) >= pid(f[2])) {
      truncated = true;
    } else throw new Error(`Invalid native resource row: ${line}`);
  }
  attachNativeQuantities(processes, quantities, version);
  validateNativeCounters(processes, errors);
  return { processes, errors, truncated };
}

/** Validate and snapshot the shared explicit process identity contract. */
export function validateProcessIdentities(identities) {
  if (!Array.isArray(identities) || identities.length > MAX_IDENTITIES) {
    throw new Error(`Expected at most ${MAX_IDENTITIES} identities`);
  }
  const seen = new Set();
  return Array.from(identities, (row) => {
    const processId = pid(row?.pid);
    if (!isStartId(row?.startId) || seen.has(processId)) {
      throw new Error('Invalid or duplicate process identity');
    }
    seen.add(processId);
    return { pid: processId, startId: row.startId };
  });
}

/** Harness-only macOS reader. No private-memory semantics or aggregate peaks. */
export async function createNativeResourceReader({
  platform = process.platform,
  prepareHelper = ensureMacDiskIoHelper,
  run = execute,
} = {}) {
  if (platform !== 'darwin')
    return { unavailable: `native resources unsupported on ${platform}` };
  const helper = await prepareHelper();
  if (helper.unavailable) return helper;
  const helperSha256 = createHash('sha256')
    .update(await readFile(helper.path))
    .digest('hex');
  const read = async (args, identities, rootPid) => {
    const startedAt = new Date().toISOString();
    const monotonicStartMs = performance.now();
    const { stdout } = await run(helper.path, args, {
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const monotonicEndMs = performance.now();
    const result = parseNativeResourceOutput(stdout);
    const observed = [...result.processes, ...result.errors];
    if (rootPid && !observed.some((row) => row.pid === rootPid)) {
      throw new Error('Native response does not cover requested root');
    }
    if (identities) {
      const keys = new Set(observed.map((row) => `${row.pid}:${row.startId}`));
      if (
        keys.size !== identities.length ||
        identities.some((key) => !keys.has(key))
      ) {
        throw new Error('Native response does not cover requested identities');
      }
    }
    return {
      ...result,
      startedAt,
      monotonicStartMs,
      monotonicEndMs,
      sourceSha256: helper.sourceSha256,
      helperSha256,
      rawOutput: stdout,
    };
  };
  return {
    readTree(rootPid) {
      const processId = pid(rootPid);
      return read(['--resources', String(processId)], undefined, processId);
    },
    read(identities) {
      const args = validateProcessIdentities(identities).map(
        ({ pid, startId }) => `${pid}:${startId}`,
      );
      return read(['--identities', ...args], args);
    },
  };
}
