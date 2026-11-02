import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isFileBroker,
  isNativeDelegationProcess,
  parsePosixProcessTable,
  selectNativeDescendants,
} from '../native-delegation-processes.mjs';

const BROKER_EXE = '/opt/Canopy/resources/bin/canopy-file-broker';
const CLAUDE_EXE = '/home/user/.local/bin/claude';

function errno(code) {
  return Object.assign(new Error(`${code}: simulated`), { code });
}

// A reader that records every pid it is asked about, so tests can prove which
// processes were inspected.
function recordingReader(executables) {
  const reads = [];
  const readExecutable = (pid) => {
    reads.push(pid);
    const value = executables[pid];
    if (value instanceof Error) throw value;
    if (value === undefined) throw errno('ENOENT');
    return value;
  };
  return { reads, readExecutable };
}

// On Linux `ps comm` is the bare name truncated to 15 characters.
const linuxRows = [
  { pid: 100, parent: 1, command: 'electron' },
  { pid: 101, parent: 100, command: 'canopy-file-bro' },
  { pid: 102, parent: 101, command: 'claude' },
  { pid: 103, parent: 100, command: 'codex' },
  // Not owned by the Electron tree.
  { pid: 200, parent: 1, command: 'claude' },
  { pid: 201, parent: 200, command: 'canopy-file-bro' },
];

test('parses ps pid, ppid, and comm rows', () => {
  assert.deepEqual(
    parsePosixProcessTable(
      '  1     0 /sbin/launchd\n 42     1 /Applications/My App/Canopy\n\nnoise\n',
    ),
    [
      { pid: 1, parent: 0, command: '/sbin/launchd' },
      { pid: 42, parent: 1, command: '/Applications/My App/Canopy' },
    ],
  );
});

test('linux resolves truncated comm to the absolute executable of owned processes', () => {
  const { readExecutable } = recordingReader({
    100: '/opt/Canopy/canopy',
    101: BROKER_EXE,
    102: CLAUDE_EXE,
    103: '/usr/bin/node',
  });

  const selected = selectNativeDescendants({
    rows: linuxRows,
    rootPid: 100,
    platform: 'linux',
    readExecutable,
  });

  assert.deepEqual(selected, [
    { pid: 101, parent: 100, command: BROKER_EXE },
    { pid: 102, parent: 101, command: CLAUDE_EXE },
  ]);
  assert.deepEqual(
    selected.filter((entry) => isFileBroker(entry, 'linux')),
    [{ pid: 101, parent: 100, command: BROKER_EXE }],
  );
});

test('linux ignores owned processes that exited before their executable was read', () => {
  const { readExecutable } = recordingReader({
    100: '/opt/Canopy/canopy',
    101: BROKER_EXE,
    102: errno('ENOENT'),
    103: errno('ESRCH'),
  });

  assert.deepEqual(
    selectNativeDescendants({
      rows: linuxRows,
      rootPid: 100,
      platform: 'linux',
      readExecutable,
    }),
    [{ pid: 101, parent: 100, command: BROKER_EXE }],
  );
});

test('linux does not hide access failures for owned live processes', () => {
  for (const code of ['EACCES', 'EPERM']) {
    const { readExecutable } = recordingReader({
      100: '/opt/Canopy/canopy',
      101: errno(code),
      102: CLAUDE_EXE,
      103: '/usr/bin/node',
    });

    assert.throws(
      () =>
        selectNativeDescendants({
          rows: linuxRows,
          rootPid: 100,
          platform: 'linux',
          readExecutable,
        }),
      { code },
    );
  }
});

test('linux never reads executable links of unrelated processes', () => {
  const { reads, readExecutable } = recordingReader({
    100: '/opt/Canopy/canopy',
    101: BROKER_EXE,
    102: CLAUDE_EXE,
    103: '/usr/bin/node',
    200: CLAUDE_EXE,
    201: BROKER_EXE,
  });

  selectNativeDescendants({
    rows: linuxRows,
    rootPid: 100,
    platform: 'linux',
    readExecutable,
  });

  assert.ok(reads.length > 0);
  for (const pid of reads) assert.ok([100, 101, 102, 103].includes(pid), pid);
});

test('linux does not trust a bare comm that the executable contradicts', () => {
  const { readExecutable } = recordingReader({
    100: '/opt/Canopy/canopy',
    101: '/usr/bin/other',
    102: '/usr/bin/other',
    103: '/usr/bin/other',
  });

  assert.deepEqual(
    selectNativeDescendants({
      rows: linuxRows,
      rootPid: 100,
      platform: 'linux',
      readExecutable,
    }),
    [],
  );
});

test('macOS keeps ps full paths without reading executable links', () => {
  const rows = [
    {
      pid: 100,
      parent: 1,
      command: '/Applications/Canopy.app/Contents/MacOS/Canopy',
    },
    {
      pid: 101,
      parent: 100,
      command:
        '/Applications/Canopy.app/Contents/Resources/bin/canopy-file-broker',
    },
    { pid: 102, parent: 101, command: '/Users/user/.local/bin/claude' },
    { pid: 200, parent: 1, command: '/usr/local/bin/codex' },
  ];
  const readExecutable = () => assert.fail('macOS must not read executables');

  const selected = selectNativeDescendants({
    rows,
    rootPid: 100,
    platform: 'darwin',
    readExecutable,
  });

  assert.deepEqual(selected, [rows[1], rows[2]]);
  assert.deepEqual(
    selected.filter((entry) => isFileBroker(entry, 'darwin')),
    [rows[1]],
  );
});

test('windows keeps image-name matching without reading executables', () => {
  const rows = [
    { pid: 100, parent: 1, command: 'C:\\Canopy\\Canopy.exe' },
    {
      pid: 101,
      parent: 100,
      command: 'C:\\Canopy\\bin\\Canopy-File-Broker.EXE',
    },
    { pid: 102, parent: 101, command: 'claude' },
  ];
  const readExecutable = () => assert.fail('Windows must not read executables');

  const selected = selectNativeDescendants({
    rows,
    rootPid: 100,
    platform: 'win32',
    readExecutable,
  });

  assert.deepEqual(selected, [rows[1], rows[2]]);
  assert.equal(isNativeDelegationProcess(rows[2].command, 'win32'), true);
  assert.equal(isFileBroker(rows[1], 'win32'), true);
  assert.equal(isFileBroker(rows[2], 'win32'), false);
});
