import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DISK_IO_SOURCE,
  classifyDiskIoProcess,
  diffDiskIoSamples,
  ensureMacDiskIoHelper,
  mergeDiskIoWork,
  parseMacDiskIoOutput,
  parseWindowsDiskIoOutput,
  prepareDiskIoSampler,
  selectProcessTree,
  startDiskIoSampler,
  windowsDiskIoQuery,
} from './disk-io.mjs';

// Captured from `proc-disk-bytes` against an E2E Electron tree, trimmed and
// with the numbers rounded. `e` rows retain root or sampled-tree failures,
// not unreadable host PIDs whose tree membership is unknown.
const MAC_FIXTURE = [
  'proc-disk-bytes\t1',
  'p\t500\t1\t1790712000.000100\t66100000\t36800000000\tElectron',
  'p\t501\t500\t1790712001.000200\t1200000\t14900000\tElectron Helper (Renderer)',
  'p\t502\t500\t1790712001.000300\t0\t2048\tElectron Helper (GPU)',
  'p\t503\t500\t1790712002.000400\t66800000\t970000000\tElectron Helper',
  'p\t610\t503\t1790712010.000500\t4096\t8192\tclaude',
  'p\t611\t500\t1790712011.000600\t0\t512\tcodex',
  'p\t612\t500\t1790712012.000700\t0\t0\tspawn-helper',
  'p\t613\t612\t1790712012.000800\t12\t34\tzsh',
  'p\t614\t500\t1790712013.000900\t4000\t0\tgit',
  'e\t615\t3',
  'garbage line',
  'p\tnot-a-pid\t500\t0.0\t1\t1\tbad',
  '',
].join('\n');

test('parses the macOS helper output, keeping unreadable pids as errors', () => {
  const parsed = parseMacDiskIoOutput(MAC_FIXTURE);

  assert.equal(parsed.processes.length, 9);
  assert.deepEqual(parsed.processes[0], {
    pid: 500,
    ppid: 1,
    startId: '1790712000.000100',
    name: 'Electron',
    commandLine: null,
    readBytes: 66_100_000,
    writtenBytes: 36_800_000_000,
  });
  assert.deepEqual(parsed.processes[4].name, 'claude');
  assert.deepEqual(parsed.errors, [{ pid: 615, errno: 3 }]);
});

test('rejects output without the helper header', () => {
  assert.throws(
    () => parseMacDiskIoOutput('p\t1\t0\t0.0\t0\t0\tlaunchd\n'),
    /proc-disk-bytes/,
  );
});

// `Get-CimInstance Win32_Process | ConvertTo-Json` output, trimmed.
const WINDOWS_FIXTURE = JSON.stringify([
  {
    ProcessId: 4,
    ParentProcessId: 0,
    Name: 'System',
    CommandLine: null,
    CreationDate: '/Date(1790700000000)/',
    ReadTransferCount: 1,
    WriteTransferCount: 1,
  },
  {
    ProcessId: 700,
    ParentProcessId: 12,
    Name: 'electron.exe',
    CommandLine: '"C:\\app\\electron.exe" .',
    CreationDate: '/Date(1790712000000)/',
    ReadTransferCount: 9000,
    WriteTransferCount: 120000,
  },
  {
    ProcessId: 701,
    ParentProcessId: 700,
    Name: 'electron.exe',
    CommandLine: '"C:\\app\\electron.exe" --type=renderer --lang=en-US',
    CreationDate: '/Date(1790712001000)/',
    ReadTransferCount: 10,
    WriteTransferCount: 20,
  },
  {
    ProcessId: 702,
    ParentProcessId: 700,
    Name: 'electron.exe',
    CommandLine: '"C:\\app\\electron.exe" --type=gpu-process',
    CreationDate: '/Date(1790712001000)/',
    ReadTransferCount: 0,
    WriteTransferCount: 0,
  },
  {
    ProcessId: 703,
    ParentProcessId: 700,
    Name: 'electron.exe',
    CommandLine:
      '"C:\\app\\electron.exe" --type=utility --utility-sub-type=node.mojom.NodeService',
    CreationDate: '/Date(1790712002000)/',
    ReadTransferCount: 5,
    WriteTransferCount: 50,
  },
  {
    ProcessId: 710,
    ParentProcessId: 703,
    Name: 'codex.exe',
    CommandLine: 'codex.exe app-server',
    CreationDate: '/Date(1790712003000)/',
    ReadTransferCount: 7,
    WriteTransferCount: 70,
  },
  {
    ProcessId: 711,
    ParentProcessId: 700,
    Name: 'pwsh.exe',
    CommandLine: 'pwsh.exe -NoLogo',
    CreationDate: '/Date(1790712004000)/',
    ReadTransferCount: 1,
    WriteTransferCount: 2,
  },
]);

test('parses Win32_Process transfer counts, including a single-object result', () => {
  const parsed = parseWindowsDiskIoOutput(WINDOWS_FIXTURE);
  assert.equal(parsed.processes.length, 7);
  assert.deepEqual(parsed.processes[1], {
    pid: 700,
    ppid: 12,
    startId: '/Date(1790712000000)/',
    name: 'electron.exe',
    commandLine: '"C:\\app\\electron.exe" .',
    readBytes: 9000,
    writtenBytes: 120000,
  });
  const single = parseWindowsDiskIoOutput(
    JSON.stringify({
      ProcessId: 9,
      ParentProcessId: 1,
      Name: 'electron.exe',
      CommandLine: null,
      CreationDate: null,
      ReadTransferCount: null,
      WriteTransferCount: 3,
    }),
  );
  assert.deepEqual(single.processes, [
    {
      pid: 9,
      ppid: 1,
      startId: '',
      name: 'electron.exe',
      commandLine: null,
      readBytes: 0,
      writtenBytes: 3,
    },
  ]);
  assert.match(windowsDiskIoQuery(), /Win32_Process/);
  assert.match(windowsDiskIoQuery(), /WriteTransferCount/);
});

test('selects the root and every native descendant, and nothing else', () => {
  const { processes } = parseMacDiskIoOutput(
    `${MAC_FIXTURE}p\t900\t1\t1.0\t0\t0\tFinder\np\t901\t900\t1.0\t0\t0\tclaude\n`,
  );
  const tree = selectProcessTree(processes, 500);
  assert.deepEqual(
    tree.map((row) => row.pid),
    [500, 501, 502, 503, 610, 611, 612, 613, 614],
  );
  // A parent cycle cannot loop forever or pull unrelated processes in.
  const cyclic = selectProcessTree(
    [
      {
        pid: 1,
        ppid: 2,
        startId: 'a',
        name: 'x',
        commandLine: null,
        readBytes: 0,
        writtenBytes: 0,
      },
      {
        pid: 2,
        ppid: 1,
        startId: 'b',
        name: 'y',
        commandLine: null,
        readBytes: 0,
        writtenBytes: 0,
      },
    ],
    1,
  );
  assert.deepEqual(
    cyclic.map((row) => row.pid),
    [1, 2],
  );
});

test('classifies Electron roles and native descendants by name or command line', () => {
  const mac = parseMacDiskIoOutput(MAC_FIXTURE).processes;
  assert.deepEqual(
    mac.map((row) => classifyDiskIoProcess(row, 500)),
    [
      'main',
      'renderer',
      'gpu',
      'utility',
      'claude',
      'codex',
      'shell',
      'shell',
      'git',
    ],
  );
  const windows = parseWindowsDiskIoOutput(WINDOWS_FIXTURE).processes.slice(1);
  assert.deepEqual(
    windows.map((row) => classifyDiskIoProcess(row, 700)),
    ['main', 'renderer', 'gpu', 'utility', 'codex', 'shell'],
  );
});

function row(pid, startId, name, readBytes, writtenBytes, ppid = 500) {
  return {
    pid,
    ppid: pid === 500 ? 1 : ppid,
    startId,
    name,
    commandLine: null,
    readBytes,
    writtenBytes,
  };
}

test('diffs window samples per class, counting births, exits and pid reuse', () => {
  const start = [
    row(500, 's500', 'Electron', 1_000, 10_000),
    row(501, 's501', 'Electron Helper (Renderer)', 50, 60),
    row(610, 's610', 'claude', 5, 5),
  ];
  const middle = [
    row(500, 's500', 'Electron', 1_500, 30_000),
    row(501, 's501', 'Electron Helper (Renderer)', 50, 70),
    // claude exits after this sample: its last reading still counts.
    row(610, 's610', 'claude', 25, 405),
    // Born during the window: counted from zero.
    row(614, 's614', 'git', 800, 0),
  ];
  const end = [
    row(500, 's500', 'Electron', 2_000, 90_000),
    row(501, 's501', 'Electron Helper (Renderer)', 40, 65),
    // The pid of the exited claude was reused by a different process.
    row(610, 's610-b', 'codex', 3, 9),
  ];

  const counters = diffDiskIoSamples([start, middle, end], 500);

  assert.deepEqual(counters, {
    'main.processes': 1,
    'main.readBytes': 1_000,
    'main.writtenBytes': 80_000,
    // Counters never run backwards; a lower reading is clamped to zero.
    'renderer.processes': 1,
    'renderer.readBytes': 0,
    'renderer.writtenBytes': 5,
    'claude.processes': 1,
    'claude.readBytes': 20,
    'claude.writtenBytes': 400,
    'codex.processes': 1,
    'codex.readBytes': 3,
    'codex.writtenBytes': 9,
    'git.processes': 1,
    'git.readBytes': 800,
    'git.writtenBytes': 0,
    'total.processes': 5,
    'total.readBytes': 1_823,
    'total.writtenBytes': 80_414,
  });
});

test('samples a window through an injected reader and reports counters', async () => {
  const samples = [
    [row(500, 's', 'Electron', 0, 100)],
    [row(500, 's', 'Electron', 0, 150)],
    [row(500, 's', 'Electron', 10, 400)],
  ];
  const sampler = await startDiskIoSampler({
    rootPid: 500,
    intervalMs: 5,
    reader: {
      read: async () => samples.shift() ?? [row(500, 's', 'Electron', 10, 400)],
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const result = await sampler.stop();

  assert.equal(result.error, undefined);
  assert.equal(result.counters['main.writtenBytes'], 300);
  assert.equal(result.counters['main.readBytes'], 10);
  assert.ok(result.sampleCount >= 2);
});

test('prepares the reader outside the window and samples only once started', async () => {
  const calls = [];
  const prepared = await prepareDiskIoSampler({
    rootPid: 500,
    intervalMs: 60_000,
    createReader: async () => {
      // A cold macOS helper cache compiles here, before any window opens.
      calls.push('create');
      return {
        read: async () => {
          calls.push('read');
          return [row(500, 's', 'Electron', 0, 100)];
        },
      };
    },
  });
  assert.deepEqual(calls, ['create']);

  const sampler = await prepared.start();
  // The baseline is taken when the window starts, not while preparing.
  assert.deepEqual(calls, ['create', 'read']);
  const result = await sampler.stop();
  assert.deepEqual(calls, ['create', 'read', 'read']);
  assert.equal(result.sampleCount, 2);
});

test('degrades to an unavailable result instead of failing the run', async () => {
  const unavailable = await startDiskIoSampler({
    rootPid: 500,
    reader: { unavailable: 'cc: command not found' },
  });
  assert.deepEqual(await unavailable.stop(), {
    error: 'unavailable: cc: command not found',
  });

  const failing = await startDiskIoSampler({
    rootPid: 500,
    reader: {
      read: async () => {
        throw new Error('helper crashed');
      },
    },
  });
  assert.deepEqual(await failing.stop(), {
    error: 'start sample failed: helper crashed',
  });

  // A missing root process is an error, not an empty window.
  const vanished = await startDiskIoSampler({
    rootPid: 500,
    reader: { read: async () => [row(900, 'x', 'Finder', 0, 0, 1)] },
  });
  assert.deepEqual(await vanished.stop(), {
    error: 'start sample failed: root process 500 was not found',
  });
});

test('reports an unbuildable macOS helper as unavailable', async () => {
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'disk-io-helper-'));
  try {
    const result = await ensureMacDiskIoHelper({
      cacheDir,
      compile: async () => {
        throw new Error('xcrun: error: invalid active developer path');
      },
    });
    assert.deepEqual(result, {
      unavailable:
        'helper build failed: xcrun: error: invalid active developer path',
    });
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test('builds the macOS helper once per source revision and reuses it', async () => {
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'disk-io-helper-'));
  try {
    let compiles = 0;
    const compile = async ({ outputPath }) => {
      compiles += 1;
      await writeFile(outputPath, '#!/bin/sh\n', { mode: 0o755 });
    };
    const first = await ensureMacDiskIoHelper({ cacheDir, compile });
    const second = await ensureMacDiskIoHelper({ cacheDir, compile });
    assert.equal(compiles, 1);
    assert.equal(first.path, second.path);
    assert.match(path.basename(first.path), /^proc-disk-bytes-[0-9a-f]{16}$/);
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test('merges disk counters into scenario work, or records why they are missing', () => {
  const work = {
    transcript: {},
    errors: [{ source: 'chromium', message: 'x' }],
  };
  assert.deepEqual(
    mergeDiskIoWork(work, { counters: { 'main.readBytes': 1 } }),
    {
      transcript: {},
      errors: [{ source: 'chromium', message: 'x' }],
      [DISK_IO_SOURCE]: { 'main.readBytes': 1 },
    },
  );
  assert.deepEqual(mergeDiskIoWork({}, { error: 'unavailable: no helper' }), {
    errors: [{ source: DISK_IO_SOURCE, message: 'unavailable: no helper' }],
  });
});

test('keeps bounded native enumeration truncation visible', () => {
  const parsed = parseMacDiskIoOutput('proc-disk-bytes\t1\nt\t16384\t16384\n');
  assert.equal(parsed.truncated, true);
});
