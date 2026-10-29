import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { promisify } from 'node:util';
import { parseNativeResourceOutput } from './process-resources.mjs';

const exec = promisify(execFile);
const live = 'p\t42\t1\t123.000456\tlive\t1\t2\t3\t4\t5\t6\t7\t8\tfixture';
const zombie = 'p\t42\t1\t123.000456\tzombie\t-\t-\t-\t-\t-\t-\t-\t-\tfixture';
const q = (
  name,
  status = 'ok',
  value = '0',
  domain = 'errno',
  code = '0',
  stage = domain === 'errno'
    ? 'proc_pidlistfds'
    : domain === 'process'
      ? 'zombie'
      : 'mach_port_space_basic_info',
  cleanupCode = '0',
) =>
  `q\t42\t123.000456\t${name}\t${status}\t${value}\t${domain}\t${code}\t${stage}\t${cleanupCode}`;
const fd = q('openFileDescriptors');
const mach = q('machIpcInUseNameEntries', 'error', '-', 'mach', '5');
const frame = (...rows) => ['proc-resources\t2', ...rows, 'end\n'].join('\n');

test('v2 quantities preserve measured zero, Mach codes and unsupported independently', () => {
  const row = parseNativeResourceOutput(frame(live, fd, mach)).processes[0];
  assert.deepEqual(row.quantities.openFileDescriptors, {
    status: 'ok',
    value: '0',
    domain: 'errno',
    code: 0,
    stage: 'proc_pidlistfds',
  });
  assert.deepEqual(row.quantities.machIpcInUseNameEntries, {
    status: 'error',
    value: null,
    domain: 'mach',
    code: 5,
    stage: 'mach_port_space_basic_info',
  });
  assert.equal(
    parseNativeResourceOutput(
      frame(
        live,
        q('openFileDescriptors', 'unsupported', '-', 'errno', '45'),
        mach,
      ),
    ).processes[0].quantities.openFileDescriptors.status,
    'unsupported',
  );
  const unavailableFd = q('openFileDescriptors', 'unavailable', '-', 'process');
  const unavailableMach = q(
    'machIpcInUseNameEntries',
    'unavailable',
    '-',
    'process',
  );
  assert.equal(
    parseNativeResourceOutput(frame(zombie, unavailableFd, unavailableMach))
      .processes[0].quantities.openFileDescriptors.value,
    null,
  );
  for (const rows of [
    [live, fd],
    [live, fd, mach, mach],
    [fd, mach],
    [zombie, fd, unavailableMach],
    [live, fd, mach.replace('\tmach\t', '\terrno\t')],
    [live, fd, mach.replace('mach_port_space_basic_info', 'bad-stage')],
    [live, fd, mach.replace('123.000456', '124.000456')],
    [live, fd, mach.replace('error', 'ok')],
    [live, fd, mach.slice(0, -2)],
    [live, fd, mach.replace(/0$/, '-1')],
    [live, fd, mach.replace(/0$/, '2147483648')],
    [live, fd.replace(/0$/, '5'), mach],
    [live, fd, mach.replace('\tmach\t5', '\tmach\t0')],
    [live, fd, mach.replace('\t-\t', '\t1\t')],
    [live, fd, mach.replace('machIpcInUseNameEntries', 'handles')],
    [live, fd, q('machIpcInUseNameEntries', 'unavailable', '-', 'process')],
  ])
    assert.throws(() => parseNativeResourceOutput(frame(...rows)));
});

test('Mach inspection and cleanup failures both survive the protocol', () => {
  const row = parseNativeResourceOutput(
    frame(live, fd, mach.replace(/0$/, '5')),
  ).processes[0];
  assert.equal(row.quantities.machIpcInUseNameEntries.code, 5);
  assert.equal(
    row.quantities.machIpcInUseNameEntries.stage,
    'mach_port_space_basic_info',
  );
  assert.deepEqual(row.quantities.machIpcInUseNameEntries.cleanupError, {
    domain: 'mach',
    code: 5,
    stage: 'mach_port_deallocate',
  });
});

test('v2 quantity diagnostics reject contradictory combinations', async (t) => {
  const invalid = [
    ['openFileDescriptors', 'error', '-', 'errno', '5', 'task_for_pid'],
    [
      'machIpcInUseNameEntries',
      'unsupported',
      '-',
      'mach',
      '123',
      'proc_pidlistfds',
    ],
    ['openFileDescriptors', 'ok', '0', 'errno', '0', 'task_for_pid'],
    ['openFileDescriptors', 'error', '-', 'errno', '5', 'unknown_stage'],
    ['openFileDescriptors', 'unsupported', '-', 'errno', '5'],
    ['openFileDescriptors', 'error', '-', 'errno', '45'],
    ['machIpcInUseNameEntries', 'error', '-', 'mach', '5', 'proc_pidlistfds'],
    ['machIpcInUseNameEntries', 'error', '-', 'mach', '5', 'unknown_stage'],
    ...[
      'task_for_pid',
      'mach_port_space_basic_info',
      'mach_port_deallocate',
    ].flatMap((stage) => [
      ['machIpcInUseNameEntries', 'unsupported', '-', 'mach', '5', stage],
      ['machIpcInUseNameEntries', 'error', '-', 'mach', '46', stage],
    ]),
    ...['task_for_pid', 'mach_port_deallocate'].flatMap((stage) => [
      ['machIpcInUseNameEntries', 'ok', '0', 'mach', '0', stage],
      ['machIpcInUseNameEntries', 'error', '-', 'mach', '5', stage, '5'],
      ['machIpcInUseNameEntries', 'unsupported', '-', 'mach', '46', stage, '5'],
    ]),
    ...['openFileDescriptors', 'machIpcInUseNameEntries'].map((name) => [
      name,
      'unavailable',
      '-',
      'process',
      '0',
      'unknown_stage',
    ]),
  ];
  for (const args of invalid) {
    await t.test(args.join('/'), () => {
      const row = q(...args);
      const unavailable = args[1] === 'unavailable';
      const output = frame(
        unavailable ? zombie : live,
        args[0] === 'openFileDescriptors'
          ? row
          : unavailable
            ? q('openFileDescriptors', 'unavailable', '-', 'process')
            : fd,
        args[0] === 'machIpcInUseNameEntries'
          ? row
          : unavailable
            ? q('machIpcInUseNameEntries', 'unavailable', '-', 'process')
            : mach,
      );
      assert.throws(
        () => parseNativeResourceOutput(output),
        /Invalid native quantity/,
      );
    });
  }
});

test('v2 quantity diagnostics accept every producer stage and failure combination', () => {
  const valid = [
    ['openFileDescriptors', 'ok', '0', 'errno', '0', 'proc_pidlistfds'],
    ['openFileDescriptors', 'error', '-', 'errno', '5', 'proc_pidlistfds'],
    [
      'openFileDescriptors',
      'unsupported',
      '-',
      'errno',
      '45',
      'proc_pidlistfds',
    ],
    [
      'machIpcInUseNameEntries',
      'ok',
      '0',
      'mach',
      '0',
      'mach_port_space_basic_info',
    ],
    ...[
      'task_for_pid',
      'mach_port_space_basic_info',
      'mach_port_deallocate',
    ].flatMap((stage) =>
      ['5', '46'].flatMap((code) =>
        (stage === 'mach_port_space_basic_info' ? ['0', '5', '46'] : ['0']).map(
          (cleanup) => [
            'machIpcInUseNameEntries',
            code === '46' ? 'unsupported' : 'error',
            '-',
            'mach',
            code,
            stage,
            cleanup,
          ],
        ),
      ),
    ),
  ];
  for (const args of valid) {
    const row = q(...args);
    const result = parseNativeResourceOutput(
      frame(
        live,
        args[0] === 'openFileDescriptors' ? row : fd,
        args[0] === 'machIpcInUseNameEntries' ? row : mach,
      ),
    ).processes[0].quantities[args[0]];
    assert.deepEqual(
      result,
      {
        status: args[1],
        value: args[2] === '-' ? null : args[2],
        domain: args[3],
        code: Number(args[4]),
        stage: args[5],
        ...(Number(args[6])
          ? {
              cleanupError: {
                domain: 'mach',
                code: Number(args[6]),
                stage: 'mach_port_deallocate',
              },
            }
          : {}),
      },
      args.join('/'),
    );
  }
});

const quantityNames = ['openFileDescriptors', 'machIpcInUseNameEntries'];
const diagnosticCodes = ['0', '5', '45', '46', '123'];

function fieldCombinations(dimensions) {
  let combinations = [[]];
  for (const values of dimensions) {
    combinations = combinations.flatMap((combination) =>
      values.map((value) => [...combination, value]),
    );
  }
  return combinations;
}

test('v2 state-space combinations preserve empty dimensions and field order', () => {
  assert.deepEqual(fieldCombinations([]), [[]]);
  assert.deepEqual(fieldCombinations([[]]), []);
  assert.deepEqual(fieldCombinations([['a'], [], ['b']]), []);
  const dimensions = Object.freeze([
    Object.freeze(['a', 'b']),
    Object.freeze(['0', '1']),
  ]);
  assert.deepEqual(fieldCombinations(dimensions), [
    ['a', '0'],
    ['a', '1'],
    ['b', '0'],
    ['b', '1'],
  ]);
});

function producerQuantityRows(name) {
  const allowed = new Set();
  const permit = (...args) => allowed.add(q(name, ...args));
  permit('unavailable', '-', 'process', '0', 'zombie');
  const domain = name === 'openFileDescriptors' ? 'errno' : 'mach';
  const successStage =
    domain === 'errno' ? 'proc_pidlistfds' : 'mach_port_space_basic_info';
  for (const value of ['0', '9'])
    permit('ok', value, domain, '0', successStage);
  const failureStages =
    domain === 'errno'
      ? ['proc_pidlistfds']
      : ['task_for_pid', 'mach_port_space_basic_info', 'mach_port_deallocate'];
  const unsupportedCode = domain === 'errno' ? '45' : '46';
  for (const [stage, code] of fieldCombinations([
    failureStages,
    diagnosticCodes.slice(1),
  ])) {
    const status = code === unsupportedCode ? 'unsupported' : 'error';
    const cleanupCodes =
      stage === 'mach_port_space_basic_info' ? ['0', '5', '46'] : ['0'];
    for (const cleanup of cleanupCodes)
      permit(status, '-', domain, code, stage, cleanup);
  }
  return allowed;
}

function quantityStateFrame(name, row, status) {
  const unavailable = status === 'unavailable';
  const rows = quantityNames.map((other) => {
    if (other === name) return row;
    if (unavailable) return q(other, 'unavailable', '-', 'process');
    return other === 'openFileDescriptors' ? fd : mach;
  });
  return frame(unavailable ? zombie : live, ...rows);
}

test('v2 quantity diagnostics match the producer state space across fields', () => {
  const stages = [
    'proc_pidlistfds',
    'task_for_pid',
    'mach_port_space_basic_info',
    'mach_port_deallocate',
    'zombie',
    'unknown_stage',
  ];
  const states = fieldCombinations([
    ['ok', 'error', 'unsupported', 'unavailable'],
    ['-', '0', '9'],
    ['errno', 'mach', 'process'],
    diagnosticCodes,
    stages,
    ['0', '5', '46'],
  ]);
  assert.equal(
    new Set(states.map((args) => args.join('\t'))).size,
    3240,
    'unique quantity field combinations',
  );
  for (const name of quantityNames) {
    const allowed = producerQuantityRows(name);
    let checked = 0;
    for (const args of states) {
      const row = q(name, ...args);
      const output = quantityStateFrame(name, row, args[0]);
      if (allowed.has(row)) {
        assert.doesNotThrow(() => parseNativeResourceOutput(output), row);
      } else {
        assert.throws(
          () => parseNativeResourceOutput(output),
          /Invalid native quantity/,
          row,
        );
      }
      checked++;
    }
    assert.equal(checked, 3240, name);
  }
});

test(
  'native descriptor and Mach name entries track controlled allocation and release',
  { skip: process.platform !== 'darwin' },
  async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'resource-dimensions-'));
    try {
      const source = fileURLToPath(
        new URL('./native/proc-disk-bytes.c', import.meta.url),
      );
      const fixture = path.join(dir, 'fixture.c');
      const binary = path.join(dir, 'fixture');
      await writeFile(
        fixture,
        `
#define main collector_main
#include ${JSON.stringify(source)}
#undef main
#include <fcntl.h>
#include <unistd.h>
static void snapshot(void) {
  struct proc_bsdinfo info;
  if (bsd_info(getpid(), &info)) exit(3);
  resources = 1;
  printf("proc-resources\\t2\\n"); sample(getpid(), &info, NULL); printf("end\\n");
}
int main(void) {
  int fds[4]; mach_port_t ports[3];
  snapshot();
  fds[0] = open("/dev/null", O_RDONLY);
  if (fds[0] < 0 || pipe(&fds[1]) || (fds[3] = dup(fds[0])) < 0) return 4;
  for (int i = 0; i < 3; i++) {
    if (mach_port_allocate(mach_task_self(), MACH_PORT_RIGHT_RECEIVE, &ports[i])) return 5;
    if (mach_port_insert_right(mach_task_self(), ports[i], ports[i], MACH_MSG_TYPE_MAKE_SEND)) return 6;
  }
  snapshot();
  for (int i = 0; i < 4; i++) close(fds[i]);
  for (int i = 0; i < 3; i++) {
    if (mach_port_mod_refs(mach_task_self(), ports[i], MACH_PORT_RIGHT_SEND, -1)) return 7;
    if (mach_port_mod_refs(mach_task_self(), ports[i], MACH_PORT_RIGHT_RECEIVE, -1)) return 8;
  }
  snapshot(); return 0;
}`,
      );
      await exec('xcrun', [
        '--sdk',
        'macosx',
        'clang',
        '-Wall',
        '-Werror',
        fixture,
        '-o',
        binary,
      ]);
      const { stdout } = await exec(binary);
      const rows = stdout
        .split('end\n')
        .filter(Boolean)
        .map((text) => parseNativeResourceOutput(`${text}end\n`).processes[0]);
      assert.equal(rows.length, 3);
      for (const [name, delta] of [
        ['openFileDescriptors', 4n],
        ['machIpcInUseNameEntries', 3n],
      ]) {
        const values = rows.map((row) => {
          assert.equal(row.quantities[name].status, 'ok');
          return BigInt(row.quantities[name].value);
        });
        assert.equal(values[1] - values[0], delta, name);
        assert.equal(values[2], values[0], name);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
