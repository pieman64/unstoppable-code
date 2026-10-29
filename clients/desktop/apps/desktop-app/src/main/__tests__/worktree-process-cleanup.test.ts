import {
  buildWindowsProcessListScript,
  protectedPidsForCurrentProcess,
  readPosixProcessRows,
  resolveCleanupWorktreePaths,
  selectProcessesReferencingPath,
  terminateProcessesReferencingPath,
  type ProcessRow,
} from '../lib/worktree-process-cleanup';

const rows: ProcessRow[] = [
  { pid: 10, parentPid: 1, command: '/Applications/Canopy.app/main' },
  {
    pid: 20,
    parentPid: 10,
    command: 'node /worktrees/sloth/out-e2e/main/index.js',
  },
  { pid: 21, parentPid: 20, command: 'Electron Helper (Renderer)' },
  {
    pid: 30,
    parentPid: 1,
    command: 'node /worktrees/other/out-e2e/main/index.js',
  },
];

describe('worktree process cleanup', () => {
  it('separates Windows process-enumeration statements with newlines', () => {
    expect(buildWindowsProcessListScript()).toContain('" "\n  Write-Output');
  });

  it('keeps newlines in one POSIX argv from forging another process row', async () => {
    const processRows = await readPosixProcessRows('  100\n  200\n', (pid) =>
      Promise.resolve(
        pid === 100
          ? '100 1 node agent.js prompt\n200 1 node /worktrees/sloth/forged'
          : '200 1 node real-process.js',
      ),
    );

    expect(processRows).toEqual([
      {
        pid: 100,
        parentPid: 1,
        command: 'node agent.js prompt 200 1 node /worktrees/sloth/forged',
      },
      { pid: 200, parentPid: 1, command: 'node real-process.js' },
    ]);
  });

  it('rejects a canonical worktree candidate that escapes its managed parent', async () => {
    const worktreePath = '/managed/worktrees/sloth';
    const resolvedPaths = await resolveCleanupWorktreePaths(
      worktreePath,
      (candidate) =>
        Promise.resolve(
          candidate === worktreePath ? '/Users/shared' : '/managed/worktrees',
        ),
    );

    expect(resolvedPaths).toEqual([worktreePath]);
  });

  it('keeps a canonical worktree candidate when only an ancestor is aliased', async () => {
    const worktreePath = '/alias/workspaces/canopy/worktrees/sloth';
    const resolvedPaths = await resolveCleanupWorktreePaths(
      worktreePath,
      (candidate) =>
        Promise.resolve(
          candidate === worktreePath
            ? '/real/workspaces/canopy/worktrees/sloth'
            : '/real/workspaces/canopy/worktrees',
        ),
    );

    expect(resolvedPaths).toEqual([
      worktreePath,
      '/real/workspaces/canopy/worktrees/sloth',
    ]);
  });

  it('protects only the current process subtree and exact ancestors', () => {
    const processRows: ProcessRow[] = [
      { pid: 1, parentPid: 0, command: 'launchd' },
      { pid: 10, parentPid: 1, command: 'current parent' },
      { pid: 11, parentPid: 10, command: 'current process' },
      { pid: 12, parentPid: 11, command: 'current child' },
      { pid: 20, parentPid: 1, command: 'sibling process' },
    ];

    expect(protectedPidsForCurrentProcess(processRows, 11)).toEqual(
      new Set([1, 10, 11, 12]),
    );
  });

  it('selects only argv matches, not unrelated descendants or the current process ancestry', () => {
    expect(
      selectProcessesReferencingPath(rows, '/worktrees/sloth', new Set([10])),
    ).toEqual([20]);
  });

  it('does not treat a sibling path with the same prefix as the removed worktree', () => {
    expect(
      selectProcessesReferencingPath(
        [
          {
            pid: 40,
            parentPid: 1,
            command: 'node /worktrees/sloth-other/out-e2e/main/index.js',
          },
        ],
        '/worktrees/sloth',
        new Set(),
      ),
    ).toEqual([]);
  });

  it('does not match the removed worktree as a suffix of a different path', () => {
    expect(
      selectProcessesReferencingPath(
        [
          {
            pid: 41,
            parentPid: 1,
            command: 'node /backup/worktrees/sloth/out-e2e/main/index.js',
          },
        ],
        '/worktrees/sloth',
        new Set(),
      ),
    ).toEqual([]);
  });

  it('matches a worktree path after an argv assignment boundary', () => {
    expect(
      selectProcessesReferencingPath(
        [
          {
            pid: 42,
            parentPid: 1,
            command: 'node runner.js --cwd=/worktrees/sloth',
          },
        ],
        '/worktrees/sloth',
        new Set(),
      ),
    ).toEqual([42]);
  });

  it('terminates selected processes before worktree removal and escalates survivors', async () => {
    const kills: Array<[number, NodeJS.Signals]> = [];
    const alive = new Set([20]);

    await terminateProcessesReferencingPath('/worktrees/sloth', {
      listProcesses: () => Promise.resolve(rows),
      protectedPids: () => new Set([10]),
      kill: (pid, signal) => {
        kills.push([pid, signal]);
        if (signal === 'SIGKILL') alive.delete(pid);
      },
      isAlive: (pid) => alive.has(pid),
      delay: () => Promise.resolve(),
    });

    expect(kills).toEqual([
      [20, 'SIGTERM'],
      [20, 'SIGKILL'],
    ]);
  });

  it('does not SIGKILL a reused pid after the grace period', async () => {
    const kills: Array<[number, NodeJS.Signals]> = [];
    let listCalls = 0;

    await terminateProcessesReferencingPath('/worktrees/sloth', {
      listProcesses: () => {
        listCalls += 1;
        return Promise.resolve(
          listCalls === 1
            ? [rows[1]]
            : [
                {
                  pid: 20,
                  parentPid: 1,
                  command: 'unrelated replacement process',
                },
              ],
        );
      },
      protectedPids: () => new Set(),
      kill: (pid, signal) => kills.push([pid, signal]),
      isAlive: () => true,
      delay: () => Promise.resolve(),
    });

    expect(kills).toEqual([[20, 'SIGTERM']]);
  });

  it('SIGKILLs a surviving helper after its parent exits and it is reparented', async () => {
    const kills: Array<[number, NodeJS.Signals]> = [];
    let listCalls = 0;
    const matchingHelper = {
      ...rows[2],
      command: 'Electron Helper --app-path=/worktrees/sloth',
    };

    await terminateProcessesReferencingPath('/worktrees/sloth', {
      listProcesses: () => {
        listCalls += 1;
        return Promise.resolve(
          listCalls === 1
            ? [rows[0], rows[1], matchingHelper, rows[3]]
            : [
                {
                  ...matchingHelper,
                  parentPid: 1,
                },
              ],
        );
      },
      protectedPids: () => new Set([10]),
      kill: (pid, signal) => kills.push([pid, signal]),
      isAlive: (pid) => pid === 21,
      delay: () => Promise.resolve(),
    });

    expect(kills).toContainEqual([21, 'SIGKILL']);
  });
});
