import type {
  CommandMap,
  DomainEventMap,
  QueryMap,
  SubscriptionFilter,
  TerminalClient,
  TerminalCommandName,
  TerminalEventName,
  TerminalQueryName,
  Unsubscribe,
} from '@canopy/app-core';
import type { TerminalSession } from '@canopy/protocol/terminal';
import { recordTerminalOutputApplied } from '@/lib/renderer-diagnostics/recorder';

export type IpcTerminalQueryHandlers = {
  [K in TerminalQueryName]: (
    args: QueryMap[K]['args'],
  ) => Promise<QueryMap[K]['result']>;
};

export type IpcTerminalCommandHandlers = {
  [K in TerminalCommandName]: (
    args: CommandMap[K]['args'],
  ) => Promise<CommandMap[K]['result']>;
};

export type IpcTerminalSubscribeHandlers = {
  [K in TerminalEventName]: (
    handler: (event: DomainEventMap[K]) => void,
    filter?: SubscriptionFilter,
  ) => Unsubscribe;
};

interface TerminalScopedPayload {
  readonly projectId: string;
  readonly worktreeId: string;
}

function matchesTerminalScope(
  payload: TerminalScopedPayload,
  filter?: SubscriptionFilter,
): boolean {
  return (
    (filter?.projectId === undefined ||
      filter.projectId === payload.projectId) &&
    (filter?.worktreeId === undefined ||
      filter.worktreeId === payload.worktreeId)
  );
}

export const ipcTerminalQueryHandlers: IpcTerminalQueryHandlers = {
  'terminal.list': async (args): Promise<TerminalSession[]> => {
    const sessions = await window.api.terminal.list();
    return sessions.filter((session): boolean =>
      matchesTerminalScope(session, args),
    );
  },
  'terminal.worktreeState.get': (args) =>
    window.api.terminal.loadWorktreeState(args),
};

export const ipcTerminalCommandHandlers: IpcTerminalCommandHandlers = {
  'terminal.spawn': (args) => window.api.terminal.spawn(args),
  'terminal.attach': (args) => window.api.terminal.attach(args),
  'terminal.write': (args) => window.api.terminal.write(args),
  'terminal.resize': (args) => window.api.terminal.resize(args),
  'terminal.kill': (args) => window.api.terminal.kill(args),
  'terminal.restore': (args) => window.api.terminal.restore(args),
  'terminal.worktreeState.save': (args) =>
    window.api.terminal.saveWorktreeState(args),
};

export const ipcTerminalSubscribeHandlers: IpcTerminalSubscribeHandlers = {
  'terminal.output': (handler, filter) =>
    window.api.terminal.onOutput((event): void => {
      const startedAt = performance.now();
      if (matchesTerminalScope(event, filter)) handler(event);
      // Each subscriber has its own listener; this counts the delivery once.
      recordTerminalOutputApplied(event.terminalId, event.seq, startedAt);
    }),
  'terminal.exit': (handler, filter) =>
    window.api.terminal.onExit((event): void => {
      if (!matchesTerminalScope(event, filter)) return;
      handler({ ...event, occurredAt: new Date().toISOString() });
    }),
  'terminal.running-changed': (handler, filter) =>
    window.api.terminal.onRunningChanged((event): void => {
      if (!matchesTerminalScope(event, filter)) return;
      handler({ ...event, occurredAt: new Date().toISOString() });
    }),
};

export const ipcTerminalClient: TerminalClient = {
  query<K extends TerminalQueryName>(
    name: K,
    args: QueryMap[K]['args'],
  ): Promise<QueryMap[K]['result']> {
    return ipcTerminalQueryHandlers[name](args);
  },
  command<K extends TerminalCommandName>(
    name: K,
    args: CommandMap[K]['args'],
  ): Promise<CommandMap[K]['result']> {
    return ipcTerminalCommandHandlers[name](args);
  },
  subscribe<K extends TerminalEventName>(
    name: K,
    handler: (event: DomainEventMap[K]) => void,
    filter?: SubscriptionFilter,
  ): Unsubscribe {
    return ipcTerminalSubscribeHandlers[name](handler, filter);
  },
};
