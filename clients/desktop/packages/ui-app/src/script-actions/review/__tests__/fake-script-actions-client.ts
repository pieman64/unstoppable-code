import type {
  CanopyCapabilities,
  CanopyClient,
  CommandMap,
  CommandName,
  QueryMap,
  QueryName,
} from '@canopy/app-core';
import type {
  ScriptAction,
  ScriptActionsSnapshot,
} from '@canopy/protocol/script-actions';

export const BASE_CAPABILITIES: CanopyCapabilities = {
  localExecution: false,
  terminalPty: false,
  fileSystemAccess: 'read',
  voice: false,
  settingsScope: 'api-keys-only',
  pipelines: 'crud-only',
  routing: 'url',
  overviewNotifications: false,
};

export function action(overrides: Partial<ScriptAction> = {}): ScriptAction {
  const name = overrides.name ?? 'build';
  return {
    id: overrides.id ?? `detected:${name}`,
    kind: 'detected',
    name,
    command: `pnpm run ${name}`,
    multiline: false,
    repoId: 'repo-a',
    repoName: 'api',
    packagePath: null,
    target: { kind: 'repository', repoId: 'repo-a' },
    source: {
      kind: 'package-json',
      file: 'package.json',
      entry: name,
      line: 3,
    },
    revision: 'r1',
    status: 'pending',
    shortcut: null,
    pinned: false,
    ...overrides,
  };
}

export function snapshotOf(
  actions: ScriptAction[],
  overrides: Partial<ScriptActionsSnapshot> = {},
): ScriptActionsSnapshot {
  return {
    actions,
    pendingCount: actions.filter((entry) => entry.status === 'pending').length,
    shellAliasScanEnabled: true,
    scanStatus: 'complete',
    scannedAt: '2026-10-21T00:00:00.000Z',
    diagnostics: [],
    ...overrides,
  };
}

export class CodedError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

type Handler = (args: unknown) => Promise<unknown>;

export interface FakeScriptActionsClient {
  readonly client: CanopyClient;
  readonly calls: { readonly name: string; readonly args: unknown }[];
  /** The snapshot the next list returns. */
  current: ScriptActionsSnapshot;
  /** Overrides for individual operations. */
  readonly handlers: Map<string, Handler>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * In-memory script-actions client. Reviews and preference writes update the
 * current snapshot the way the service does; tests override operations
 * through `handlers` to inject failures.
 */
export function createFakeScriptActionsClient(
  initial: ScriptActionsSnapshot,
  capabilities: Partial<CanopyCapabilities> = { scriptActions: true },
): FakeScriptActionsClient {
  const fake: Omit<FakeScriptActionsClient, 'client'> = {
    calls: [],
    current: initial,
    handlers: new Map(),
  };
  const update = (
    mutate: (
      entry: ScriptAction,
      args: Record<string, unknown>,
    ) => ScriptAction,
  ): Handler => {
    return (args) => {
      const record = isRecord(args) ? args : {};
      fake.current = {
        ...fake.current,
        actions: fake.current.actions.map((entry) => mutate(entry, record)),
      };
      return Promise.resolve(fake.current);
    };
  };
  const defaults: Record<string, Handler> = {
    'scriptActions.list': () => Promise.resolve(fake.current),
    'scriptActions.rescan': () => Promise.resolve(fake.current),
    'scriptActions.review': update((entry, args) => {
      const entries = Array.isArray(args.entries) ? args.entries : [];
      const hit = entries.some(
        (candidate: unknown) =>
          isRecord(candidate) && candidate.id === entry.id,
      );
      if (!hit) return entry;
      const decision = args.decision;
      return {
        ...entry,
        status:
          decision === 'approve'
            ? 'approved'
            : decision === 'dismiss'
              ? 'dismissed'
              : 'pending',
      };
    }),
    'scriptActions.setShortcut': update((entry, args) =>
      entry.id === args.id
        ? {
            ...entry,
            shortcut:
              typeof args.accelerator === 'string' ? args.accelerator : null,
          }
        : entry,
    ),
    'scriptActions.setPinned': update((entry, args) =>
      entry.id === args.id ? { ...entry, pinned: args.pinned === true } : entry,
    ),
    'scriptActions.enableShellAliasScan': () => {
      fake.current = { ...fake.current, shellAliasScanEnabled: true };
      return Promise.resolve(fake.current);
    },
    'scriptActions.receipt': () => Promise.resolve(null),
  };
  const run = (name: string, args: unknown): Promise<unknown> => {
    fake.calls.push({ name, args });
    const handler = fake.handlers.get(name) ?? defaults[name];
    return handler
      ? handler(args)
      : Promise.reject(new Error(`unexpected ${name}`));
  };
  const client: CanopyClient = {
    capabilities: { ...BASE_CAPABILITIES, ...capabilities },
    query<K extends QueryName>(
      name: K,
      args: QueryMap[K]['args'],
    ): Promise<QueryMap[K]['result']> {
      return run(name, args) as Promise<QueryMap[K]['result']>;
    },
    command<K extends CommandName>(
      name: K,
      args: CommandMap[K]['args'],
    ): Promise<CommandMap[K]['result']> {
      return run(name, args) as Promise<CommandMap[K]['result']>;
    },
    subscribe: () => () => undefined,
  };
  return Object.assign(fake, { client });
}
