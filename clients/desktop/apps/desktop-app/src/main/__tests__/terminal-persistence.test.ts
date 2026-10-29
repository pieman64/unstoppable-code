import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TerminalSession } from '@canopy/desktop-shared/types';
import { getWorktreeTerminalStateFilePath } from '../lib/paths';
import { TerminalPersistenceStore } from '../terminal/persistence';

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
  });

  afterEach(() => {
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
});
