import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { promisify } from 'node:util';
import {
  createNativeResourceReader,
  parseNativeResourceOutput,
  validateProcessIdentities,
} from './process-resources.mjs';
import {
  ensureMacDiskIoHelper,
  parseMacDiskIoOutput,
  startDiskIoSampler,
} from './disk-io.mjs';

const exec = promisify(execFile);
const frame = (...lines) => ['proc-resources\t1', ...lines, 'end\n'].join('\n');
const live =
  'p\t42\t1\t123.000456\tlive\t4096\t8192\t9007199254740993\t0\t2\t3\t4\t5\tworker';
const zombie = 'p\t42\t1\t123.000456\tzombie\t-\t-\t-\t-\t-\t-\t-\t-\tworker';

test('shared identity validation rejects holes instead of forwarding missing identities', () => {
  const identity = { pid: 42, startId: '123.000456' };
  for (const [identities, missingIndex] of [
    [Array(1), 0],
    [Object.assign(Array(2), { 1: identity }), 0],
    [Object.assign(Array(2), { 0: identity }), 1],
  ]) {
    assert.ok(missingIndex < identities.length);
    assert.equal(Object.hasOwn(identities, missingIndex), false);
    assert.throws(() => validateProcessIdentities(identities), /process pid/);
  }
  const input = [identity];
  const snapshot = validateProcessIdentities(input);
  assert.deepEqual(snapshot, input);
  assert.notEqual(snapshot[0], identity);
  identity.startId = '124.000456';
  assert.equal(snapshot[0].startId, '123.000456');
});

test('resource parser keeps named diagnostics exact, zero distinct from unknown', () => {
  const row = parseNativeResourceOutput(frame(live)).processes[0];
  assert.equal(row.residentBytes, '4096');
  assert.equal(row.physicalFootprintBytes, '8192');
  assert.equal(row.userCpuNs, '9007199254740993');
  assert.equal(row.systemCpuNs, '0');
  assert.equal(row.packageIdleWakeups, '2');
  assert.equal(row.interruptWakeups, '3');
  assert.equal(
    parseNativeResourceOutput(
      frame(live.replace('123.000456', '18446744073709551615.999999')),
    ).processes[0].startId,
    '18446744073709551615.999999',
  );
  assert.equal(
    parseNativeResourceOutput(frame(zombie)).processes[0].residentBytes,
    null,
  );
  assert.deepEqual(parseNativeResourceOutput(frame()), {
    processes: [],
    errors: [],
    truncated: false,
  });
  const failed = parseNativeResourceOutput(
    frame('e\t42\t123.000456\tidentity_changed\t70', 't\t16384\t16384'),
  );
  assert.equal(failed.truncated, true);
  assert.equal(failed.errors[0].stage, 'identity_changed');
  assert.equal(failed.processes.length, 0);
});

test('malformed, partial, duplicate and unsafe resource output fails closed', () => {
  for (const output of [
    '',
    live,
    'proc-resources\t1\n',
    frame(live, live),
    frame(live.slice(0, live.lastIndexOf('\t'))),
    frame(`${live}\textra`),
    frame(live.replace('live', 'dead')),
    frame(live.replace('p\t42\t1', 'p\t42\t-1')),
    frame(live.replace('p\t42\t1', 'p\t42\t2147483648')),
    frame(live.replace('4096', '-'), 'e\t42\t124.000456\trusage\t1'),
    frame(live.replace('4096', '-'), 'e\t43\t123.000456\trusage\t1'),
    frame('e\t42\t123.000456\tbad-stage\t1'),
    frame('e\t42\t123.000456\trusage'),
    frame('e\t42\t123.000456\trusage\t1\textra'),
    frame('e\t42\t123.000456\trusage\t0'),
    frame('t\t2'),
    frame(live.replace('4096', '-1')),
    frame(live.replace('4096', '18446744073709551616')),
    frame(live.replace('4096', '-')),
    frame(live.replace('live', 'zombie')),
    frame(live.replace('123.000456', '18446744073709551616.000456')),
    frame('e\t42\tbad\trusage\t3'),
    frame('e\t42\t18446744073709551616.000456\tbsd_info\t3'),
    frame('garbage'),
    frame('t\t1\t2'),
  ]) {
    assert.throws(() => parseNativeResourceOutput(output));
  }
  assert.equal(
    parseNativeResourceOutput(
      frame(live.replace('4096', '-'), 'e\t42\t123.000456\trusage\t1'),
    ).errors[0].errno,
    1,
  );
});

test('v2 attachment preserves identity, ordering and validation precedence', () => {
  const fd =
    'q\t42\t123.000456\topenFileDescriptors\tok\t4\terrno\t0\tproc_pidlistfds\t0';
  const mach =
    'q\t42\t123.000456\tmachIpcInUseNameEntries\tok\t7\tmach\t0\tmach_port_space_basic_info\t0';
  const v2 = (...rows) => ['proc-resources\t2', ...rows, 'end\n'].join('\n');
  const second = live.replace('42\t1\t123.000456', '43\t42\t124.000456');
  const otherQuantities = [fd, mach].map((row) =>
    row
      .replace('42\t123.000456', '43\t124.000456')
      .replace('\tok\t4\t', '\tok\t9\t'),
  );
  const result = parseNativeResourceOutput(
    v2(otherQuantities[0], live, otherQuantities[1], mach, second, fd),
  );
  assert.deepEqual(
    result.processes.map((row) => [
      row.pid,
      row.startId,
      row.quantities.openFileDescriptors.value,
      row.quantities.machIpcInUseNameEntries.value,
    ]),
    [
      [42, '123.000456', '4', '7'],
      [43, '124.000456', '9', '7'],
    ],
  );
  const unknown = live.replace('4096', '-');
  const orphan = fd.replace('123.000456', '124.000456');
  const attachmentError = 'Orphan, duplicate or inconsistent native quantity';
  for (const [rows, message] of [
    [[live, orphan], attachmentError],
    [[live, fd, mach, mach], attachmentError],
    [[unknown, fd], 'Missing native quantity'],
    [[unknown, fd, mach], 'Unknown native counters without an error'],
    [[unknown, fd, mach, mach], attachmentError],
    [[orphan, 'garbage'], 'Invalid native resource row: garbage'],
    [[orphan, fd.replace('\tok\t4\t', '\tok\t-\t')], 'Invalid native quantity'],
  ]) {
    assert.throws(() => parseNativeResourceOutput(v2(...rows)), {
      name: 'Error',
      message,
    });
  }
});

test('reader retains identities, raw evidence, helper hashes and sample skew', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'resources-reader-'));
  try {
    const helperPath = path.join(dir, 'helper');
    await writeFile(helperPath, 'fixture');
    let output = frame(live);
    const calls = [];
    const reader = await createNativeResourceReader({
      platform: 'darwin',
      prepareHelper: async () => ({ path: helperPath, sourceSha256: 'source' }),
      run: async (file, args, options) => {
        calls.push({ file, args, options });
        return { stdout: output };
      },
    });
    const identity = { pid: 42, startId: '123.000456' };
    const result = await reader.read([identity]);
    assert.deepEqual(calls[0].args, ['--identities', '42:123.000456']);
    assert.equal(result.sourceSha256, 'source');
    assert.match(result.helperSha256, /^[a-f0-9]{64}$/);
    assert.equal(result.rawOutput, output);
    assert.ok(result.monotonicEndMs >= result.monotonicStartMs);
    assert.ok(Date.parse(result.startedAt));
    await reader.readTree(42);
    assert.deepEqual(calls[1].args, ['--resources', '42']);
    output = frame(live, 'e\t43\t123.000456\tbsd_info\t3');
    await assert.rejects(reader.read([identity]), /cover requested/);
    output = frame();
    await assert.rejects(reader.read([identity]), /cover requested/);
    await assert.rejects(reader.readTree(42), /cover requested root/);
    output = frame(live.replace('p\t42\t1', 'p\t43\t42'));
    await assert.rejects(reader.readTree(42), /cover requested root/);
    output = frame('e\t42\t-\troot_missing\t3');
    assert.equal((await reader.readTree(42)).errors[0].stage, 'root_missing');
    output = frame();
    assert.equal((await reader.read([])).processes.length, 0);
    output = frame('e\t42\t123.000456\tbsd_info\t3');
    assert.equal((await reader.read([identity])).errors[0].errno, 3);
    output = frame(live.replace('123.000456', '124.000456'));
    await assert.rejects(reader.read([identity]), /cover requested/);
    for (const input of [
      null,
      Array(1),
      Object.assign(Array(2), { 1: identity }),
      Object.assign(Array(2), { 0: identity }),
      [{}],
      [{ pid: -1, startId: '123.000456' }],
      [{ ...identity, startId: '123.1' }],
      [{ ...identity, startId: '18446744073709551616.000456' }],
      [identity, identity],
      Array(1025).fill(identity),
    ]) {
      assert.throws(() => reader.read(input));
    }
    assert.throws(() => reader.readTree(0));
    const boundary = Array.from({ length: 1024 }, (_, i) => ({
      pid: i + 1,
      startId: '0.000000',
    }));
    output = frame(
      ...boundary.map((row) => `e\t${row.pid}\t${row.startId}\tbsd_info\t3`),
    );
    assert.equal((await reader.read(boundary)).errors.length, 1024);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  assert.match(
    (await createNativeResourceReader({ platform: 'win32' })).unavailable,
    /unsupported/,
  );
  assert.deepEqual(
    await createNativeResourceReader({
      platform: 'darwin',
      prepareHelper: async () => ({ unavailable: 'compiler failed' }),
    }),
    { unavailable: 'compiler failed' },
  );
});

test('disk sampler does not silently certify a missed interval', async () => {
  let notify;
  const interval = new Promise((resolve) => {
    notify = resolve;
  });
  let reads = 0;
  const sampler = await startDiskIoSampler({
    rootPid: 42,
    intervalMs: 1,
    reader: {
      read: async () => {
        if (++reads === 2) {
          notify();
          throw new Error('permission denied');
        }
        return [
          {
            pid: 42,
            ppid: 1,
            startId: 's',
            name: 'main',
            readBytes: 1,
            writtenBytes: 2,
          },
        ];
      },
    },
  });
  await interval;
  assert.match(
    (await sampler.stop()).error,
    /interval samples failed: permission denied/,
  );
});

// Exercise the actual C control flow with deterministic libproc failure/race fixtures.
const fixture = `
#include <errno.h>
#include <libproc.h>
#include <mach/mach.h>
#include <mach_debug/ipc_info.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc.h>
#include <sys/proc_info.h>
#include <sys/resource.h>
kern_return_t task_for_pid(mach_port_name_t target, int pid, mach_port_name_t *task) {
  if (getenv("MACH_TASK_ERROR")) return KERN_FAILURE;
  *task = 123; return KERN_SUCCESS;
}
kern_return_t mach_port_space_basic_info(ipc_space_inspect_t task, ipc_info_space_basic_t *info) {
  if (getenv("MACH_UNSUPPORTED")) return KERN_NOT_SUPPORTED;
  if (getenv("MACH_ERROR")) return KERN_INVALID_TASK;
  info->iisb_table_inuse = 7; return KERN_SUCCESS;
}
kern_return_t mach_port_deallocate(ipc_space_t task, mach_port_name_t name) {
  return getenv("MACH_CLEANUP_ERROR") ? KERN_FAILURE : KERN_SUCCESS;
}
static int calls[100];
int proc_listallpids(void *buffer, int size) {
  if (getenv("LIST_ERROR")) { errno = EPERM; return -1; }
  int *pids = buffer;
  for (int i = 0; i < size / sizeof(int); i++) pids[i] = 42 + i;
  if (getenv("PROTECTED_PID")) { pids[2] = 1; return 3; }
  return getenv("FULL") ? size / sizeof(int) : 2;
}
int proc_pidinfo(int pid, int flavor, uint64_t arg, void *buffer, int size) {
  if (flavor == PROC_PIDLISTFDS) {
    if (getenv("FD_ERROR") && (!getenv("CHILD_ONLY") || pid == 43)) { errno = EPERM; return 0; }
    if (getenv("FD_UNSUPPORTED")) { errno = ENOTSUP; return -1; }
    if (getenv("FD_SHORT")) return 1;
    if (getenv("FD_FULL")) return size;
    return getenv("FD_EMPTY") ? 0 : 4 * sizeof(struct proc_fdinfo);
  }
  int affected = !getenv("CHILD_ONLY") || pid == 43;
  if ((pid == 1 && getenv("PROTECTED_PID")) ||
      (pid == 42 && getenv("ROOT_ERROR"))) { errno = EPERM; return 0; }
  if (pid < 1 || pid >= 100 || getenv("BSD_ERROR")) { errno = ESRCH; return 0; }
  if (getenv("SHORT")) return 1;
  if (affected && getenv("EXIT") && calls[pid]) { errno = ESRCH; return 0; }
  struct proc_bsdinfo *info = buffer;
  memset(info, 0, sizeof(*info));
  info->pbi_ppid = pid == 42 ? 1 : 42;
  info->pbi_start_tvsec = affected && getenv("REUSE") && calls[pid] ? 124 : 123;
  info->pbi_start_tvusec = 456;
  info->pbi_status = affected && getenv("ZOMBIE") ? SZOMB : SRUN;
  strcpy(info->pbi_name, "worker"); calls[pid]++;
  return sizeof(*info);
}
int proc_pid_rusage(int pid, int flavor, rusage_info_t *buffer) {
  if (getenv("USAGE_ERROR") && (!getenv("CHILD_ONLY") || pid == 43)) { errno = EPERM; return -1; }
  struct rusage_info_v2 *u = (void *)buffer;
  memset(u, 0, sizeof(*u));
  u->ri_resident_size = 4096; u->ri_phys_footprint = 8192;
  u->ri_user_time = 9007199254740993ULL; u->ri_system_time = 0;
  u->ri_pkg_idle_wkups = 2; u->ri_interrupt_wkups = 3;
  u->ri_diskio_bytesread = 4; u->ri_diskio_byteswritten = 5;
  return 0;
}`;

async function assertNativeQuantityFailures(read) {
  for (const kind of [
    'FD_ERROR',
    'FD_SHORT',
    'FD_FULL',
    'FD_UNSUPPORTED',
    'MACH_TASK_ERROR',
    'MACH_ERROR',
    'MACH_CLEANUP_ERROR',
    'MACH_UNSUPPORTED',
  ]) {
    const row = (await read({ [kind]: '1' })).processes[0];
    const name = kind.startsWith('FD_')
      ? 'openFileDescriptors'
      : 'machIpcInUseNameEntries';
    assert.equal(
      row.quantities[name].status,
      kind.endsWith('UNSUPPORTED') ? 'unsupported' : 'error',
      kind,
    );
    assert.equal(row.quantities[name].value, null, kind);
    assert.ok(row.quantities[name].code > 0, kind);
    assert.equal(
      row.quantities[name].stage,
      kind.startsWith('FD_')
        ? 'proc_pidlistfds'
        : kind === 'MACH_TASK_ERROR'
          ? 'task_for_pid'
          : kind === 'MACH_CLEANUP_ERROR'
            ? 'mach_port_deallocate'
            : 'mach_port_space_basic_info',
      kind,
    );
    assert.equal(row.userCpuNs, '9007199254740993', kind);
  }
  for (const primary of ['MACH_ERROR', 'MACH_UNSUPPORTED']) {
    const original = (await read({ [primary]: '1' })).processes[0].quantities
      .machIpcInUseNameEntries;
    const combined = (await read({ [primary]: '1', MACH_CLEANUP_ERROR: '1' }))
      .processes[0].quantities.machIpcInUseNameEntries;
    assert.equal(combined.status, original.status);
    assert.equal(combined.code, original.code);
    assert.equal(combined.stage, original.stage);
    assert.deepEqual(combined.cleanupError, {
      domain: 'mach',
      code: 5,
      stage: 'mach_port_deallocate',
    });
  }
}

async function assertNativeDiscoveryFailures(run) {
  const discoveryEnv = { PROTECTED_PID: '1' };
  const disk = parseMacDiskIoOutput(await run(['42'], discoveryEnv));
  assert.deepEqual(
    disk.errors,
    [],
    'unrelated protected PID must not invalidate disk tree',
  );
  assert.deepEqual(
    disk.processes.map((row) => row.pid),
    [42, 43],
  );
  const detailed = parseNativeResourceOutput(
    await run(['--resources', '42'], discoveryEnv),
  );
  assert.deepEqual(
    detailed.processes.map((row) => row.pid),
    [42, 43],
  );
  assert.deepEqual(detailed.errors, [
    { pid: 1, startId: null, stage: 'bsd_info', errno: 1 },
  ]);
  assert.equal(
    parseNativeResourceOutput(
      await run(['--identities', '1:123.000456'], discoveryEnv),
    ).errors[0].stage,
    'bsd_info',
  );
  for (const kind of ['USAGE_ERROR', 'EXIT', 'REUSE', 'ZOMBIE']) {
    const env = { ...discoveryEnv, CHILD_ONLY: '1', [kind]: '1' };
    const failed = parseMacDiskIoOutput(await run(['42'], env));
    assert.deepEqual(
      failed.processes.map((row) => row.pid),
      [42],
      kind,
    );
    assert.deepEqual(
      failed.errors,
      [
        {
          pid: 43,
          errno: kind === 'USAGE_ERROR' ? 1 : kind === 'REUSE' ? 70 : 3,
        },
      ],
      `${kind}: tree failure must survive unrelated discovery suppression`,
    );
    const resource = parseNativeResourceOutput(
      await run(['--resources', '42'], env),
    );
    assert.deepEqual(
      resource.errors.find((row) => row.pid === 1),
      detailed.errors[0],
      kind,
    );
    assert.equal(resource.errors.length, kind === 'ZOMBIE' ? 1 : 2, kind);
  }
  assert.deepEqual(
    parseMacDiskIoOutput(await run(['42'], { ROOT_ERROR: '1' })).errors,
    [{ pid: 42, errno: 1 }],
  );
  assert.deepEqual(parseMacDiskIoOutput(await run(['44'])).errors, [
    { pid: 44, errno: 3 },
  ]);
  for (const env of [{ EXIT: '1' }, { REUSE: '1' }, { ZOMBIE: '1' }]) {
    const failed = parseMacDiskIoOutput(await run(['42'], env));
    assert.deepEqual(failed.processes, []);
    assert.deepEqual(
      failed.errors.map((row) => row.pid),
      [42, 43],
    );
  }
  assert.equal(
    parseMacDiskIoOutput(await run(['42'], { FULL: '1' })).truncated,
    true,
  );
  assert.equal(
    parseMacDiskIoOutput(await run(['42'], { USAGE_ERROR: '1' })).errors.length,
    2,
  );
}

test(
  'native helper validates identity before/after collection and preserves failures',
  { skip: process.platform !== 'darwin' },
  async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'native-resources-'));
    try {
      const source = fileURLToPath(
        new URL('./native/proc-disk-bytes.c', import.meta.url),
      );
      const stub = path.join(dir, 'fixture.c');
      const binary = path.join(dir, 'fixture');
      await writeFile(stub, fixture);
      await exec('xcrun', [
        '--sdk',
        'macosx',
        'clang',
        '-Wall',
        '-Werror',
        '-DMAX_PIDS=4',
        '-Dproc_pidinfo=fixture_pidinfo',
        '-Dproc_listallpids=fixture_listallpids',
        '-Dproc_pid_rusage=fixture_rusage',
        '-Dtask_for_pid=fixture_task_for_pid',
        '-Dmach_port_space_basic_info=fixture_space_info',
        '-Dmach_port_deallocate=fixture_deallocate',
        source,
        stub,
        '-o',
        binary,
      ]);
      const run = async (args, env = {}) =>
        (await exec(binary, args, { env })).stdout;
      const read = async (env) =>
        parseNativeResourceOutput(
          await run(['--identities', '42:123.000456'], env),
        );
      assert.equal((await read()).processes[0].userCpuNs, '9007199254740993');
      assert.equal(
        (await read()).processes[0].quantities.openFileDescriptors.value,
        '4',
      );
      assert.equal(
        (await read()).processes[0].quantities.machIpcInUseNameEntries.value,
        '7',
      );
      assert.equal(
        (await read({ FD_EMPTY: '1' })).processes[0].quantities
          .openFileDescriptors.value,
        '0',
      );
      await assertNativeQuantityFailures(read);
      const mixed = parseNativeResourceOutput(
        await run(['--identities', '42:123.000456', '43:123.000456'], {
          FD_ERROR: '1',
          CHILD_ONLY: '1',
        }),
      );
      assert.equal(
        mixed.processes[0].quantities.openFileDescriptors.value,
        '4',
      );
      assert.equal(
        mixed.processes[1].quantities.openFileDescriptors.status,
        'error',
      );
      assert.equal(
        mixed.processes[1].quantities.openFileDescriptors.value,
        null,
      );
      assert.equal(
        mixed.processes[1].quantities.machIpcInUseNameEntries.value,
        '7',
      );
      const dead = (await read({ ZOMBIE: '1' })).processes[0];
      for (const value of Object.values(dead.quantities)) {
        assert.equal(value.status, 'unavailable');
        assert.equal(value.value, null);
      }
      for (const [env, stage] of [
        [{ BSD_ERROR: '1' }, 'bsd_info'],
        [{ SHORT: '1' }, 'bsd_info'],
        [{ EXIT: '1' }, 'revalidate'],
        [{ REUSE: '1' }, 'identity_changed'],
      ]) {
        const result = await read(env);
        assert.equal(result.processes.length, 0);
        assert.equal(result.errors[0].stage, stage);
        assert.ok(result.errors[0].errno > 0);
      }
      assert.equal(
        (await read({ ZOMBIE: '1' })).processes[0].residentBytes,
        null,
      );
      const failedUsage = await read({ USAGE_ERROR: '1' });
      assert.equal(failedUsage.processes[0].residentBytes, null);
      assert.equal(failedUsage.errors[0].stage, 'rusage');
      for (const race of [{ EXIT: '1' }, { REUSE: '1' }]) {
        const failed = await read({ USAGE_ERROR: '1', ...race });
        assert.equal(failed.processes.length, 0);
        assert.deepEqual(
          failed.errors.map((error) => error.stage),
          ['rusage', race.EXIT ? 'revalidate' : 'identity_changed'],
        );
        assert.ok(failed.errors.every((error) => error.errno > 0));
      }
      assert.equal(
        parseNativeResourceOutput(await run(['--identities', '42:122.000456']))
          .errors[0].stage,
        'identity_mismatch',
      );
      assert.equal(
        parseNativeResourceOutput(await run(['--identities'])).processes.length,
        0,
      );
      assert.equal(
        parseNativeResourceOutput(
          await run(['--resources', '42'], { FULL: '1' }),
        ).truncated,
        true,
      );
      assert.equal(
        parseNativeResourceOutput(await run(['--resources', '44'])).errors[0]
          .stage,
        'root_missing',
      );
      await assert.rejects(run(['--resources', '42'], { LIST_ERROR: '1' }));
      assert.equal(parseMacDiskIoOutput(await run(['42'])).processes.length, 2);
      await assertNativeDiscoveryFailures(run);
      for (const args of [
        ['0'],
        ['2147483648'],
        ['--identities', '42:1.1'],
        ['--identities', '42:123.000456', '42:123.000456'],
      ])
        await assert.rejects(run(args));
      const actual = await ensureMacDiskIoHelper({ cacheDir: dir });
      assert.ok(actual.path, actual.unavailable);
      const real = parseNativeResourceOutput(
        (await exec(actual.path, ['--resources', String(process.pid)])).stdout,
      );
      const self = real.processes.find((row) => row.pid === process.pid);
      assert.ok(self);
      assert.ok(BigInt(self.residentBytes) > 0n);
      assert.equal(
        parseNativeResourceOutput(
          (
            await exec(actual.path, [
              '--identities',
              `${self.pid}:${self.startId}`,
            ])
          ).stdout,
        ).processes[0].startId,
        self.startId,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
