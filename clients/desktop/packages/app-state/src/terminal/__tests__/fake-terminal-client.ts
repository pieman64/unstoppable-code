import type {
  CommandMap,
  DomainEventMap,
  QueryMap,
  TerminalClient,
  TerminalCommandName,
  TerminalEventName,
  TerminalQueryName,
} from '@canopy/app-core';

type QueryMocks = {
  [K in TerminalQueryName]: jest.Mock<
    Promise<QueryMap[K]['result']>,
    [QueryMap[K]['args']]
  >;
};
type CommandMocks = {
  [K in TerminalCommandName]: jest.Mock<
    Promise<CommandMap[K]['result']>,
    [CommandMap[K]['args']]
  >;
};
type EventListeners = {
  [K in TerminalEventName]: Set<(event: DomainEventMap[K]) => void>;
};

export interface FakeTerminalClient {
  client: TerminalClient;
  calls: { queries: QueryMocks; commands: CommandMocks };
  emit: <K extends TerminalEventName>(
    name: K,
    event: DomainEventMap[K],
  ) => void;
  listenerCount: (name: TerminalEventName) => number;
}

export function createFakeTerminalClient(): FakeTerminalClient {
  const queries: QueryMocks = {
    'terminal.list': jest
      .fn<
        Promise<QueryMap['terminal.list']['result']>,
        [QueryMap['terminal.list']['args']]
      >()
      .mockResolvedValue([]),
    'terminal.worktreeState.get': jest
      .fn<
        Promise<QueryMap['terminal.worktreeState.get']['result']>,
        [QueryMap['terminal.worktreeState.get']['args']]
      >()
      .mockResolvedValue({
        drawerCollapsed: true,
        groups: [],
        activeGroupId: null,
        nextGroupOrdinal: 1,
        groupOrdinals: {},
        terminalCustomNames: {},
        groupCustomNames: {},
        terminals: [],
        liveTerminalIds: [],
      }),
  };
  const commands: CommandMocks = {
    'terminal.spawn': jest
      .fn<
        Promise<CommandMap['terminal.spawn']['result']>,
        [CommandMap['terminal.spawn']['args']]
      >()
      .mockRejectedValue(new Error('Configure terminal.spawn in the test')),
    'terminal.attach': jest
      .fn<
        Promise<CommandMap['terminal.attach']['result']>,
        [CommandMap['terminal.attach']['args']]
      >()
      .mockRejectedValue(new Error('Configure terminal.attach in the test')),
    'terminal.write': jest
      .fn<
        Promise<CommandMap['terminal.write']['result']>,
        [CommandMap['terminal.write']['args']]
      >()
      .mockResolvedValue('written'),
    'terminal.resize': jest
      .fn<
        Promise<CommandMap['terminal.resize']['result']>,
        [CommandMap['terminal.resize']['args']]
      >()
      .mockResolvedValue(undefined),
    'terminal.kill': jest
      .fn<
        Promise<CommandMap['terminal.kill']['result']>,
        [CommandMap['terminal.kill']['args']]
      >()
      .mockResolvedValue(undefined),
    'terminal.restore': jest
      .fn<
        Promise<CommandMap['terminal.restore']['result']>,
        [CommandMap['terminal.restore']['args']]
      >()
      .mockRejectedValue(new Error('Configure terminal.restore in the test')),
    'terminal.worktreeState.save': jest
      .fn<
        Promise<CommandMap['terminal.worktreeState.save']['result']>,
        [CommandMap['terminal.worktreeState.save']['args']]
      >()
      .mockResolvedValue(undefined),
  };
  const listeners: EventListeners = {
    'terminal.output': new Set(),
    'terminal.exit': new Set(),
    'terminal.running-changed': new Set(),
  };
  const client: TerminalClient = {
    query: (name, args) => queries[name](args),
    command: (name, args) => commands[name](args),
    subscribe: (name, handler) => {
      listeners[name].add(handler);
      return (): void => {
        listeners[name].delete(handler);
      };
    },
  };
  return {
    client,
    calls: { queries, commands },
    emit: (name, event): void => {
      listeners[name].forEach((handler) => handler(event));
    },
    listenerCount: (name): number => listeners[name].size,
  };
}
