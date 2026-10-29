import type {
  CanopyClient,
  DomainEventMap,
  DomainEventName,
  Unsubscribe,
} from '@canopy/app-core';

type HandlerSets = {
  [K in DomainEventName]?: Set<(event: DomainEventMap[K]) => void>;
};

/**
 * A recording `CanopyClient` for store tests. `query` and `command` are bare
 * jest mocks the test programs per case; `emit` fans a domain event to every
 * handler the store subscribed.
 */
export interface FakeClient {
  readonly client: CanopyClient;
  readonly query: jest.Mock;
  readonly command: jest.Mock;
  readonly subscribed: DomainEventName[];
  readonly unsubscribed: DomainEventName[];
  readonly emit: <K extends DomainEventName>(
    name: K,
    event: DomainEventMap[K],
  ) => void;
}

export function createFakeClient(): FakeClient {
  const query = jest.fn();
  const command = jest.fn();
  const subscribed: DomainEventName[] = [];
  const unsubscribed: DomainEventName[] = [];
  const handlers: HandlerSets = {};

  const client: CanopyClient = {
    capabilities: {
      localExecution: false,
      terminalPty: false,
      fileSystemAccess: 'read',
      voice: false,
      settingsScope: 'api-keys-only',
      pipelines: 'crud-only',
      routing: 'url',
      orgProjects: true,
    },
    query,
    command,
    subscribe<K extends DomainEventName>(
      name: K,
      handler: (event: DomainEventMap[K]) => void,
    ): Unsubscribe {
      subscribed.push(name);
      const set =
        handlers[name] ?? new Set<(event: DomainEventMap[K]) => void>();
      set.add(handler);
      handlers[name] = set;
      return (): void => {
        set.delete(handler);
        unsubscribed.push(name);
      };
    },
  };

  return {
    client,
    query,
    command,
    subscribed,
    unsubscribed,
    emit: <K extends DomainEventName>(
      name: K,
      event: DomainEventMap[K],
    ): void => {
      const set: Set<(event: DomainEventMap[K]) => void> | undefined =
        handlers[name];
      set?.forEach((handler) => {
        handler(event);
      });
    },
  };
}

export function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolve: (value: T) => void = () => {};
  let reject: (error: Error) => void = () => {};
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

export function accountChange(): DomainEventMap['workspace-context.changed'] & {
  readonly reason: 'account-change';
} {
  return {
    occurredAt: '2026-09-10T00:00:00.000Z',
    reason: 'account-change',
    state: { context: { kind: 'personal' }, revision: 0, organizations: [] },
  };
}
