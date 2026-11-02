import type * as NodeFs from 'node:fs';

const actualFs = jest.requireActual<typeof NodeFs>('node:fs');
const mockWriteFileSync = jest.fn<
  void,
  Parameters<typeof NodeFs.writeFileSync>
>();
jest.mock('node:fs', () => ({
  ...jest.requireActual<typeof NodeFs>('node:fs'),
  writeFileSync: (...args: Parameters<typeof NodeFs.writeFileSync>): void =>
    mockWriteFileSync(...args),
}));
const mockLogMainProcessWarn = jest.fn();
jest.mock('../lib/main-process-logging', () => ({
  ...jest.requireActual<object>('../lib/main-process-logging'),
  logMainProcessWarn: (...args: unknown[]): unknown =>
    mockLogMainProcessWarn(...args),
}));
jest.mock('../plugins/plugin-cleanup', () => ({
  cleanupWorktreeChatPluginDirs: jest.fn(),
}));
jest.mock('../observability/worktree-cleanup', () => ({
  purgePersistedWorktreeObservabilityData: jest.fn(() => Promise.resolve()),
}));
// Cleanup's chat-state scope deletion records a fire-and-forget session
// diagnostic, which would start the real observability service. Its debounced
// flush then writes `agent-observability/snapshot.json` into the temp data dir
// without being awaited, racing the `afterEach` removal (ENOTEMPTY). The stub
// must cover what the cleanup path calls on the service: chat-state's lazy
// callers swallow a missing method instead of failing the test.
jest.mock('../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    recordSessionDiagnostic: jest.fn(),
    recordAppDiagnostic: jest.fn(),
    flush: jest.fn(() => Promise.resolve()),
  })),
  peekObservabilityService: jest.fn(() => null),
}));
jest.mock('../browser/browser-service-registry', () => ({
  getBrowserService: jest.fn(() => null),
}));
jest.mock('../lib/plan-persistence', () => ({
  deleteTrackedPlansForWorktree: jest.fn(() => Promise.resolve()),
}));
jest.mock('../lib/detected-plan-persistence', () => ({
  deleteDetectedPlansForWorktree: jest.fn(() => Promise.resolve()),
}));
jest.mock('../lib/script-log-store', () => ({
  deleteScriptRunLogsForWorktree: jest.fn(() => Promise.resolve()),
}));
jest.mock('../lib/hook-log-store', () => ({
  deleteHookRunLogsForWorktree: jest.fn(() => Promise.resolve()),
}));
jest.mock('../chat-search/service', () => ({
  getChatSearchService: jest.fn(() => ({
    deleteWorktreeDocs: jest.fn(() => Promise.resolve()),
  })),
}));

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { TerminalSession } from '@canopy/desktop-shared/types';
import {
  getWorktreeDataDir,
  getWorktreeTerminalStateFilePath,
} from '../lib/paths';
import { cleanupPersistedWorktreeData } from '../lib/worktree-data-cleanup';
import {
  TerminalPersistenceStore,
  terminalPersistenceStore,
} from '../terminal/persistence';

function errnoError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

function attempt(operation: () => void): void {
  try {
    operation();
  } catch {
    // Only the file left behind matters to the caller.
  }
}

function sessionGroupRequest(session: TerminalSession): {
  projectId: string;
  worktreeId: string;
  drawerCollapsed: boolean;
  groups: Array<{
    id: string;
    terminalIds: string[];
    focusedTerminalId: string;
    splitSizes: number[];
  }>;
  activeGroupId: string;
  nextGroupOrdinal: number;
  groupOrdinals: Record<string, number>;
  terminalCustomNames: Record<string, string>;
  groupCustomNames: Record<string, string>;
} {
  return {
    projectId: session.projectId,
    worktreeId: session.worktreeId,
    drawerCollapsed: false,
    groups: [
      {
        id: 'group-1',
        terminalIds: [session.id],
        focusedTerminalId: session.id,
        splitSizes: [1],
      },
    ],
    activeGroupId: 'group-1',
    nextGroupOrdinal: 2,
    groupOrdinals: { 'group-1': 1 },
    terminalCustomNames: {},
    groupCustomNames: {},
  };
}

function makeSession(
  overrides: Partial<TerminalSession> = {},
): TerminalSession {
  return {
    id: overrides.id ?? 'term-1',
    projectId: overrides.projectId ?? 'project-1',
    worktreeId: overrides.worktreeId ?? 'wt-1',
    shell: overrides.shell ?? '/bin/zsh',
    shellBasename: overrides.shellBasename ?? 'zsh',
    cwd: overrides.cwd ?? '/worktrees/project-1/wt-1',
    createdAt: overrides.createdAt ?? 1,
    ...(overrides.kind ? { kind: overrides.kind } : {}),
    ...(overrides.title ? { title: overrides.title } : {}),
    ...(overrides.chatId ? { chatId: overrides.chatId } : {}),
    ...(overrides.sessionKey ? { sessionKey: overrides.sessionKey } : {}),
    ...(overrides.focusOnSpawn !== undefined
      ? { focusOnSpawn: overrides.focusOnSpawn }
      : {}),
    ...(overrides.initialCommand
      ? { initialCommand: overrides.initialCommand }
      : {}),
  };
}

describe('TerminalPersistenceStore', () => {
  const originalCanopyDataDir = process.env.CANOPY_DATA_DIR;
  let tempDataDir = '';

  beforeEach(() => {
    tempDataDir = mkdtempSync(join(tmpdir(), 'canopy-terminal-persist-'));
    process.env.CANOPY_DATA_DIR = tempDataDir;
    mockWriteFileSync.mockReset();
    mockWriteFileSync.mockImplementation(actualFs.writeFileSync);
    mockLogMainProcessWarn.mockReset();
  });

  afterEach(() => {
    jest.useRealTimers();
    if (originalCanopyDataDir === undefined) {
      delete process.env.CANOPY_DATA_DIR;
    } else {
      process.env.CANOPY_DATA_DIR = originalCanopyDataDir;
    }
    rmSync(tempDataDir, { recursive: true, force: true });
  });

  it('persists live sessions, scrollback, and exit state under worktree-data', () => {
    const store = new TerminalPersistenceStore();
    const session = makeSession();

    store.registerLiveSession(session);
    store.appendTerminalOutput(
      session.projectId,
      session.worktreeId,
      session.id,
      Buffer.from('first line\nsecond line', 'utf8'),
    );
    store.markTerminalExited(
      session.projectId,
      session.worktreeId,
      session.id,
      0,
      null,
    );
    store.flushAllSync();

    const filePath = getWorktreeTerminalStateFilePath(
      session.projectId,
      session.worktreeId,
    );
    const persisted = JSON.parse(readFileSync(filePath, 'utf8')) as {
      version: number;
      terminals: Array<{
        session: TerminalSession;
        scrollbackLines: string[];
        exitCode: number | null;
        signal: string | null;
      }>;
      groups: Array<{ terminalIds: string[] }>;
    };

    expect(persisted.version).toBe(1);
    expect(persisted.groups).toHaveLength(1);
    expect(persisted.groups[0]?.terminalIds).toEqual([session.id]);
    expect(persisted.terminals).toEqual([
      {
        session,
        scrollbackLines: ['first line', 'second line'],
        exitCode: 0,
        signal: null,
      },
    ]);

    const loaded = store.loadWorktreeState(
      session.projectId,
      session.worktreeId,
    );
    expect(loaded.liveTerminalIds).toEqual([]);
    expect(loaded.terminals[0]?.scrollbackLines).toEqual([
      'first line',
      'second line',
    ]);

    const persistedEntry = store.getPersistedTerminalEntry(session.id);
    expect(persistedEntry).not.toBeNull();
    expect(persistedEntry).toEqual({
      session,
      scrollbackLines: ['first line', 'second line'],
      exitCode: 0,
      signal: null,
    });
  });

  it('persists the one-shot command needed to restart a preset terminal', () => {
    const store = new TerminalPersistenceStore();
    const session = makeSession({ initialCommand: 'lazygit' });

    store.registerLiveSession(session);
    store.markTerminalExited(
      session.projectId,
      session.worktreeId,
      session.id,
      0,
      null,
    );
    store.flushAllSync();

    expect(store.getPersistedTerminalEntry(session.id)?.session).toEqual(
      expect.objectContaining({ initialCommand: 'lazygit' }),
    );
  });

  it('does not add managed Claude Code terminals to drawer persistence', () => {
    const store = new TerminalPersistenceStore();
    const managed = makeSession({
      id: 'claude-terminal',
      kind: 'claude-code',
      title: 'Claude Code',
      chatId: 'chat-1',
      sessionKey: 'session-key',
    });

    store.registerLiveSession(managed);
    store.appendTerminalOutput(
      managed.projectId,
      managed.worktreeId,
      managed.id,
      Buffer.from('managed output', 'utf8'),
    );

    const loaded = store.loadWorktreeState(
      managed.projectId,
      managed.worktreeId,
    );
    expect(loaded.liveTerminalIds).toEqual([]);
    expect(loaded.groups).toEqual([]);
    expect(loaded.terminals).toEqual([]);
    expect(store.getPersistedTerminalEntry(managed.id)).toBeNull();
  });

  it('adds interactive script terminals to drawer persistence', () => {
    const store = new TerminalPersistenceStore();
    const script = makeSession({
      id: 'script-terminal',
      kind: 'script',
      title: 'Setup',
    });

    store.registerLiveSession(script);

    const loaded = store.loadWorktreeState(script.projectId, script.worktreeId);
    expect(loaded.liveTerminalIds).toEqual([script.id]);
    expect(loaded.groups[0]?.terminalIds).toEqual([script.id]);
    expect(loaded.terminals[0]?.session).toEqual(script);
  });

  it('does not activate a background script terminal during persistence', () => {
    const store = new TerminalPersistenceStore();
    const script = makeSession({
      id: 'background-script-terminal',
      kind: 'script',
      title: 'Automatic setup',
      focusOnSpawn: false,
    });

    store.registerLiveSession(script);

    const loaded = store.loadWorktreeState(script.projectId, script.worktreeId);
    expect(loaded.liveTerminalIds).toEqual([script.id]);
    expect(loaded.groups[0]?.terminalIds).toEqual([script.id]);
    expect(loaded.activeGroupId).toBeNull();
  });

  it('preserves the active terminal when a background script is persisted', () => {
    const store = new TerminalPersistenceStore();
    const shell = makeSession({ id: 'active-shell' });
    const script = makeSession({
      id: 'background-script-terminal',
      kind: 'script',
      title: 'Automatic setup',
      focusOnSpawn: false,
    });

    store.registerLiveSession(shell);
    const before = store.loadWorktreeState(shell.projectId, shell.worktreeId);
    store.registerLiveSession(script);

    const after = store.loadWorktreeState(shell.projectId, shell.worktreeId);
    expect(after.activeGroupId).toBe(before.activeGroupId);
  });

  it('prunes removed terminals and moves custom names into worktree terminal state', () => {
    const store = new TerminalPersistenceStore();
    const first = makeSession({ id: 'term-1' });
    const second = makeSession({ id: 'term-2', createdAt: 2 });

    store.registerLiveSession(first);
    store.registerLiveSession(second);
    const initial = store.loadWorktreeState(first.projectId, first.worktreeId);
    const survivingGroupId = initial.groups[0]?.id ?? 'group-1';

    store.saveWorktreeState({
      projectId: first.projectId,
      worktreeId: first.worktreeId,
      drawerCollapsed: false,
      groups: [
        {
          id: survivingGroupId,
          terminalIds: [first.id],
          focusedTerminalId: first.id,
          splitSizes: [1],
        },
      ],
      activeGroupId: survivingGroupId,
      nextGroupOrdinal: 3,
      groupOrdinals: { [survivingGroupId]: 2 },
      terminalCustomNames: {
        [first.id]: 'Frontend shell',
        [second.id]: 'Should be pruned',
      },
      groupCustomNames: {
        [survivingGroupId]: 'Daily split',
      },
    });
    store.flushAllSync();

    const persisted = store.loadWorktreeState(
      first.projectId,
      first.worktreeId,
    );
    expect(persisted.terminals.map((entry) => entry.session.id)).toEqual([
      first.id,
    ]);
    expect(persisted.terminalCustomNames).toEqual({
      [first.id]: 'Frontend shell',
    });
    expect(persisted.groupCustomNames).toEqual({
      [survivingGroupId]: 'Daily split',
    });
    expect(persisted.groupOrdinals).toEqual({ [survivingGroupId]: 2 });
    expect(persisted.drawerCollapsed).toBe(false);
  });

  it('persists drawer collapsed state even when no terminals remain', () => {
    const store = new TerminalPersistenceStore();
    const session = makeSession();

    store.registerLiveSession(session);
    const initial = store.loadWorktreeState(
      session.projectId,
      session.worktreeId,
    );
    const groupId = initial.groups[0]?.id;
    if (groupId === undefined) {
      throw new Error('expected group');
    }

    store.saveWorktreeState({
      projectId: session.projectId,
      worktreeId: session.worktreeId,
      drawerCollapsed: false,
      groups: [],
      activeGroupId: null,
      nextGroupOrdinal: 2,
      groupOrdinals: {},
      terminalCustomNames: {},
      groupCustomNames: {},
    });
    store.flushAllSync();

    const loaded = store.loadWorktreeState(
      session.projectId,
      session.worktreeId,
    );
    expect(loaded.drawerCollapsed).toBe(false);
    expect(loaded.groups).toEqual([]);
    expect(loaded.terminals).toEqual([]);
  });

  it('keeps only the last 5000 persisted scrollback lines per terminal', () => {
    const store = new TerminalPersistenceStore();
    const session = makeSession();
    const lines: string[] = [];
    for (let index = 0; index < 5002; index += 1) {
      lines.push(`line-${index}`);
    }

    store.registerLiveSession(session);
    store.appendTerminalOutput(
      session.projectId,
      session.worktreeId,
      session.id,
      Buffer.from(lines.join('\n'), 'utf8'),
    );

    const loaded = store.loadWorktreeState(
      session.projectId,
      session.worktreeId,
    );
    const persistedLines = loaded.terminals[0]?.scrollbackLines ?? [];

    expect(persistedLines).toHaveLength(5000);
    expect(persistedLines[0]).toBe('line-2');
    expect(persistedLines[4999]).toBe('line-5001');
  });

  it('preserves UTF-8 characters split across chunk boundaries', () => {
    const store = new TerminalPersistenceStore();
    const session = makeSession();
    const emojiBytes = Buffer.from('done 😀', 'utf8');

    store.registerLiveSession(session);
    store.appendTerminalOutput(
      session.projectId,
      session.worktreeId,
      session.id,
      emojiBytes.subarray(0, emojiBytes.length - 2),
    );
    store.appendTerminalOutput(
      session.projectId,
      session.worktreeId,
      session.id,
      emojiBytes.subarray(emojiBytes.length - 2),
    );

    const loaded = store.loadWorktreeState(
      session.projectId,
      session.worktreeId,
    );
    expect(loaded.terminals[0]?.scrollbackLines).toEqual(['done 😀']);
  });

  it('preserves app-quit exit markers when a later PTY kill exit arrives', () => {
    const store = new TerminalPersistenceStore();
    const session = makeSession();

    store.registerLiveSession(session);
    store.appendTerminalOutput(
      session.projectId,
      session.worktreeId,
      session.id,
      Buffer.from('echo hello', 'utf8'),
    );
    store.markTerminalExited(
      session.projectId,
      session.worktreeId,
      session.id,
      null,
      'app-quit',
    );

    store.markTerminalExited(
      session.projectId,
      session.worktreeId,
      session.id,
      null,
      '9',
    );

    const loaded = store.loadWorktreeState(
      session.projectId,
      session.worktreeId,
    );
    expect(loaded.terminals[0]).toEqual({
      session,
      scrollbackLines: ['echo hello'],
      exitCode: null,
      signal: 'app-quit',
    });
  });

  it.each([
    ['unparseable JSON', '{"version":1,"terminals":['],
    ['a non-object document', '[1,2,3]'],
    ['a document without a version', '{"terminals":[]}'],
    [
      'a version 1 document with a malformed terminal entry',
      '{"version":1,"terminals":[{"session":{"id":"t-1"}}],"groups":[]}',
    ],
    [
      'a version 1 document whose groups are not a list',
      '{"version":1,"terminals":[],"groups":{"id":"g-1"}}',
    ],
  ])(
    'sets %s aside with its original bytes before writing a new state file',
    (_label, original) => {
      const filePath = getWorktreeTerminalStateFilePath('project-1', 'wt-1');
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, original);
      const store = new TerminalPersistenceStore();
      const session = makeSession();

      store.registerLiveSession(session);
      store.flushAllSync();

      const asides = readdirSync(dirname(filePath)).filter((name) =>
        /^terminal-state\.json\.damaged-\d+$/.test(name),
      );
      expect(asides).toHaveLength(1);
      expect(
        readFileSync(join(dirname(filePath), asides[0] ?? ''), 'utf8'),
      ).toBe(original);
      const persisted: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
      expect(persisted).toMatchObject({ version: 1, terminals: [{ session }] });
    },
  );

  it('never rewrites or removes a state file written by a newer version', () => {
    const filePath = getWorktreeTerminalStateFilePath('project-1', 'wt-1');
    mkdirSync(dirname(filePath), { recursive: true });
    const original = '{\n  "version": 2,\n  "futureField": true\n}\n';
    writeFileSync(filePath, original);
    const store = new TerminalPersistenceStore();

    expect(store.loadWorktreeState('project-1', 'wt-1').terminals).toEqual([]);
    store.flushAllSync();
    expect(readFileSync(filePath, 'utf8')).toBe(original);

    const session = makeSession();
    store.registerLiveSession(session);
    store.saveWorktreeState(sessionGroupRequest(session));
    store.flushAllSync();

    expect(readFileSync(filePath, 'utf8')).toBe(original);
    expect(readdirSync(dirname(filePath))).toEqual(['terminal-state.json']);
  });

  it('keeps the previous state file when a write fails partway through', () => {
    const store = new TerminalPersistenceStore();
    const session = makeSession();
    store.registerLiveSession(session);
    store.flushAllSync();
    const filePath = getWorktreeTerminalStateFilePath(
      session.projectId,
      session.worktreeId,
    );
    const previous = readFileSync(filePath, 'utf8');
    mockWriteFileSync.mockImplementation((file, data) => {
      actualFs.writeFileSync(
        file,
        typeof data === 'string' ? data.slice(0, 10) : data,
      );
      throw errnoError('ENOSPC');
    });

    store.appendTerminalOutput(
      session.projectId,
      session.worktreeId,
      session.id,
      Buffer.from('more output', 'utf8'),
    );
    attempt(() => store.flushAllSync());

    expect(readFileSync(filePath, 'utf8')).toBe(previous);
    expect(readdirSync(dirname(filePath))).toEqual(['terminal-state.json']);
  });

  it('logs a failed debounced write and writes the state on the next flush', () => {
    jest.useFakeTimers();
    const store = new TerminalPersistenceStore();
    const session = makeSession();
    const filePath = getWorktreeTerminalStateFilePath(
      session.projectId,
      session.worktreeId,
    );
    mockWriteFileSync.mockImplementation(() => {
      throw errnoError('ENOSPC');
    });

    store.registerLiveSession(session);
    expect(() => jest.advanceTimersByTime(1_000)).not.toThrow();

    expect(mockLogMainProcessWarn).toHaveBeenCalledWith(
      'Failed to write terminal state',
      expect.objectContaining({ code: 'ENOSPC' }),
    );
    expect(existsSync(filePath)).toBe(false);

    mockWriteFileSync.mockImplementation(actualFs.writeFileSync);
    store.flushAllSync();

    const persisted: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
    expect(persisted).toMatchObject({ version: 1, terminals: [{ session }] });
  });

  it('ignores output and exits for a forgotten worktree', () => {
    jest.useFakeTimers();
    const store = new TerminalPersistenceStore();
    const session = makeSession();
    store.registerLiveSession(session);
    store.flushAllSync();
    const filePath = getWorktreeTerminalStateFilePath(
      session.projectId,
      session.worktreeId,
    );
    const persisted = readFileSync(filePath, 'utf8');

    store.forgetWorktree(session.projectId, session.worktreeId);
    store.appendTerminalOutput(
      session.projectId,
      session.worktreeId,
      session.id,
      Buffer.from('late output', 'utf8'),
    );
    store.markTerminalExited(
      session.projectId,
      session.worktreeId,
      session.id,
      0,
      null,
    );
    jest.advanceTimersByTime(1_000);
    store.flushAllSync();

    expect(readFileSync(filePath, 'utf8')).toBe(persisted);
  });

  it('worktree-data cleanup cancels a pending terminal state write', async () => {
    jest.useFakeTimers();
    const session = makeSession();
    const filePath = getWorktreeTerminalStateFilePath(
      session.projectId,
      session.worktreeId,
    );
    mkdirSync(getWorktreeDataDir(session.projectId, session.worktreeId), {
      recursive: true,
    });
    terminalPersistenceStore.registerLiveSession(session);

    const warnings = await cleanupPersistedWorktreeData(
      session.projectId,
      session.worktreeId,
    );
    terminalPersistenceStore.markTerminalExited(
      session.projectId,
      session.worktreeId,
      session.id,
      0,
      null,
    );
    jest.advanceTimersByTime(1_000);

    expect(warnings).toEqual([]);
    expect(existsSync(filePath)).toBe(false);
    expect(
      terminalPersistenceStore.loadWorktreeState(
        session.projectId,
        session.worktreeId,
      ).terminals,
    ).toEqual([]);
  }, 30_000);
});
