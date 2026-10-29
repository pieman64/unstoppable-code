import type { CanopyClient } from '@canopy/app-core';
import type { ScriptAction } from '@canopy/protocol/script-actions';
import type { TerminalSession } from '@canopy/protocol/terminal';

export function scriptAction(
  overrides: Partial<ScriptAction> = {},
): ScriptAction {
  return {
    id: 'dev',
    kind: 'detected',
    name: 'dev',
    command: 'pnpm run dev',
    multiline: false,
    repoId: 'repo-a',
    repoName: 'canopy',
    packagePath: 'apps/web',
    target: { kind: 'repository', repoId: 'repo-a' },
    source: {
      kind: 'package-json',
      file: 'apps/web/package.json',
      entry: 'dev',
      line: 3,
    },
    revision: 'r1',
    status: 'approved',
    shortcut: null,
    pinned: true,
    ...overrides,
  };
}

export function terminalSession(
  id: string,
  overrides: Partial<TerminalSession> = {},
): TerminalSession {
  return {
    id,
    projectId: 'p',
    worktreeId: 'w',
    shell: '/bin/zsh',
    shellBasename: 'zsh',
    cwd: '/tmp',
    createdAt: 0,
    ...overrides,
  };
}

type Handler = (event: { terminalId: string; running?: boolean }) => void;

export interface FakeTerminalClient {
  readonly client: CanopyClient;
  readonly spawns: unknown[];
  readonly writes: unknown[];
  readonly listCalls: unknown[];
  /** Sessions `terminal.list` returns; mutate between calls. */
  sessions: TerminalSession[];
  actions: ScriptAction[];
  rescannedActions: ScriptAction[] | null;
  listError: Error | null;
  /** Fail every `terminal.write` after recording it. */
  writeError: Error | null;
  /** Resolve the next spawn manually when set. */
  holdSpawn: boolean;
  releaseSpawn: () => void;
  whenSpawned: Promise<void>;
  emit(
    name: 'terminal.running-changed' | 'terminal.exit',
    event: { terminalId: string; running?: boolean },
  ): void;
}

export function fakeTerminalClient(
  capabilities: { scriptActions?: boolean; terminalPty: boolean } = {
    scriptActions: true,
    terminalPty: true,
  },
): FakeTerminalClient {
  let noteSpawn = (): void => {};
  const whenSpawned = new Promise<void>((resolve) => {
    noteSpawn = resolve;
  });
  const handlers = new Map<string, Set<Handler>>();
  let spawnCount = 0;
  let pendingRelease: (() => void) | null = null;
  const state: FakeTerminalClient = {
    client: undefined as never,
    spawns: [],
    writes: [],
    listCalls: [],
    sessions: [],
    actions: [scriptAction()],
    rescannedActions: null,
    listError: null,
    writeError: null,
    holdSpawn: false,
    whenSpawned,
    releaseSpawn: () => {
      pendingRelease?.();
      pendingRelease = null;
    },
    emit: (name, event) => {
      handlers.get(name)?.forEach((handler) => handler(event));
    },
  };
  const client = {
    capabilities,
    query: jest.fn((name: string, args: unknown) => {
      if (name === 'scriptActions.list')
        return Promise.resolve({ actions: state.actions });
      if (name !== 'terminal.list')
        return Promise.reject(new Error(`unexpected query ${name}`));
      state.listCalls.push(args);
      if (state.listError) return Promise.reject(state.listError);
      return Promise.resolve(state.sessions);
    }),
    command: jest.fn(async (name: string, args: unknown) => {
      if (name === 'scriptActions.rescan')
        return { actions: state.rescannedActions ?? state.actions };
      if (name === 'terminal.spawn') {
        state.spawns.push(args);
        noteSpawn();
        if (state.holdSpawn)
          await new Promise<void>((resolve) => {
            pendingRelease = resolve;
          });
        spawnCount += 1;
        return terminalSession(`t${spawnCount}`);
      }
      if (name === 'terminal.write') {
        state.writes.push(args);
        if (state.writeError) throw state.writeError;
        return 'written';
      }
      throw new Error(`unexpected command ${name}`);
    }),
    subscribe: jest.fn((name: string, handler: Handler) => {
      const set = handlers.get(name) ?? new Set<Handler>();
      set.add(handler);
      handlers.set(name, set);
      return (): boolean => set.delete(handler);
    }),
  };
  return Object.assign(state, { client: client as unknown as CanopyClient });
}
