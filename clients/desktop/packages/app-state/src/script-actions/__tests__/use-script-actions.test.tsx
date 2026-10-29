/** @jest-environment jsdom */
/* eslint-disable @typescript-eslint/require-await -- act(async) flushes resolved fakes. */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CanopyClient, ScriptActionsChangedEvent } from '@canopy/app-core';
import type {
  ScriptAction,
  ScriptActionsSnapshot,
} from '@canopy/protocol/script-actions';
import {
  useScriptActionsWithClient,
  type UseScriptActionsOptions,
  type UseScriptActionsResult,
} from '../use-script-actions';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

function action(id: string, status: ScriptAction['status']): ScriptAction {
  return {
    id,
    kind: 'detected',
    name: id,
    command: `make ${id}`,
    multiline: false,
    repoId: 'r',
    repoName: 'repo',
    packagePath: null,
    target: { kind: 'repository', repoId: 'r' },
    source: { kind: 'makefile', file: 'Makefile', entry: id, line: 1 },
    revision: 'v1',
    status,
    shortcut: null,
    pinned: false,
  };
}

function snapshot(actions: ScriptAction[]): ScriptActionsSnapshot {
  return {
    actions,
    pendingCount: actions.filter((entry) => entry.status === 'pending').length,
    shellAliasScanEnabled: false,
    scanStatus: 'complete',
    scannedAt: null,
    diagnostics: [],
  };
}

interface Deferred {
  resolve: (value: ScriptActionsSnapshot) => void;
  reject: (error: Error) => void;
}

interface FakeClient {
  client: CanopyClient;
  raw: {
    query: jest.Mock;
    command: jest.Mock;
    subscribe: jest.Mock;
  };
  pending: { args: unknown; deferred: Deferred }[];
  commands: { name: string; args: unknown }[];
  emit: (event: ScriptActionsChangedEvent) => void;
  listenerCount: () => number;
}

function fakeClient(scriptActions = true): FakeClient {
  const pending: { args: unknown; deferred: Deferred }[] = [];
  const commands: { name: string; args: unknown }[] = [];
  const listeners = new Set<(event: ScriptActionsChangedEvent) => void>();
  const client = {
    capabilities: scriptActions ? { scriptActions: true } : {},
    query: jest.fn(
      (_name: string, args: unknown) =>
        new Promise<ScriptActionsSnapshot>((resolve, reject) => {
          pending.push({ args, deferred: { resolve, reject } });
        }),
    ),
    command: jest.fn((name: string, args: unknown) => {
      commands.push({ name, args });
      return Promise.resolve(
        snapshot([action('a', 'approved'), action('d', 'dismissed')]),
      );
    }),
    subscribe: jest.fn(
      (
        _name: string,
        handler: (event: ScriptActionsChangedEvent) => void,
      ): (() => void) => {
        listeners.add(handler);
        return (): void => {
          listeners.delete(handler);
        };
      },
    ),
  };
  return {
    client: client as unknown as CanopyClient,
    raw: client,
    pending,
    commands,
    emit: (event: ScriptActionsChangedEvent): void =>
      listeners.forEach((listener) => listener(event)),
    listenerCount: (): number => listeners.size,
  };
}

let root: Root;
let container: HTMLElement;
let latest: UseScriptActionsResult;

function Probe(props: {
  client: CanopyClient;
  options: UseScriptActionsOptions;
}): JSX.Element | null {
  latest = useScriptActionsWithClient(props.client, props.options);
  return null;
}

function render(client: CanopyClient, options: UseScriptActionsOptions): void {
  act(() => root.render(<Probe client={client} options={options} />));
}

beforeEach(() => {
  container = document.createElement('div');
  root = createRoot(container);
});
afterEach(() => act(() => root.unmount()));

const target = { projectId: 'p1', worktreeId: 'w1' };

test('loads the list for the target', async () => {
  const fake = fakeClient();
  render(fake.client, target);
  expect(latest.status).toBe('loading');
  expect(fake.pending[0]?.args).toEqual({ ...target, includeDismissed: false });
  await act(async () => {
    fake.pending[0]?.deferred.resolve(snapshot([action('a', 'pending')]));
  });
  expect(latest.status).toBe('ready');
  expect(latest.snapshot?.pendingCount).toBe(1);
});

test('is unsupported and inert without the capability', () => {
  const fake = fakeClient(false);
  render(fake.client, target);
  expect(latest.supported).toBe(false);
  expect(latest.status).toBe('idle');
  expect(fake.raw.query).not.toHaveBeenCalled();
  expect(fake.raw.subscribe).not.toHaveBeenCalled();
});

test('drops a response that arrives after the target changes', async () => {
  const fake = fakeClient();
  render(fake.client, target);
  render(fake.client, { projectId: 'p1', worktreeId: 'w2' });
  await act(async () => {
    fake.pending[0]?.deferred.resolve(snapshot([action('stale', 'pending')]));
  });
  expect(latest.snapshot).toBeNull();
  await act(async () => {
    fake.pending[1]?.deferred.resolve(snapshot([action('fresh', 'pending')]));
  });
  expect(latest.snapshot?.actions.map((entry) => entry.id)).toEqual(['fresh']);
});

test('refreshes on matching change events and focus, then unsubscribes', async () => {
  const fake = fakeClient();
  render(fake.client, target);
  await act(async () => {
    fake.pending[0]?.deferred.resolve(snapshot([]));
  });
  act(() =>
    fake.emit({ projectId: 'p1', worktreeId: 'other', occurredAt: 'x' }),
  );
  expect(fake.pending).toHaveLength(1);
  act(() => fake.emit({ ...target, occurredAt: 'x' }));
  expect(fake.pending).toHaveLength(2);
  act(() => {
    window.dispatchEvent(new Event('focus'));
  });
  expect(fake.pending).toHaveLength(3);
  act(() => root.unmount());
  expect(fake.listenerCount()).toBe(0);
  root = createRoot(container);
});

test('keeps prior data when a refresh fails', async () => {
  const fake = fakeClient();
  render(fake.client, target);
  await act(async () => {
    fake.pending[0]?.deferred.resolve(snapshot([action('a', 'pending')]));
  });
  let refreshed: Promise<unknown> = Promise.resolve();
  act(() => {
    refreshed = latest.refresh();
  });
  await act(async () => {
    fake.pending[1]?.deferred.reject(new Error('scan failed'));
    await refreshed;
  });
  expect(latest.status).toBe('error');
  expect(latest.error).toBe('scan failed');
  expect(latest.snapshot?.actions).toHaveLength(1);
});

test('applies write results and hides dismissed rows unless requested', async () => {
  const fake = fakeClient();
  render(fake.client, target);
  await act(async () => {
    fake.pending[0]?.deferred.resolve(snapshot([]));
  });
  await act(async () => {
    await latest.review([{ id: 'a', revision: 'v1' }], 'approve');
  });
  expect(fake.commands[0]).toEqual({
    name: 'scriptActions.review',
    args: {
      ...target,
      entries: [{ id: 'a', revision: 'v1' }],
      decision: 'approve',
    },
  });
  expect(latest.snapshot?.actions.map((entry) => entry.id)).toEqual(['a']);
});

test('a late same-target list cannot overwrite a newer preference write', async () => {
  const fake = fakeClient();
  render(fake.client, target);
  await act(async () => {
    fake.pending[0]?.deferred.resolve(snapshot([action('a', 'pending')]));
  });
  let refresh: Promise<ScriptActionsSnapshot | null> = Promise.resolve(null);
  act(() => {
    refresh = latest.refresh();
  });
  await act(async () => {
    await latest.review([{ id: 'a', revision: 'v1' }], 'approve');
  });
  await act(async () => {
    fake.pending[1]?.deferred.resolve(snapshot([action('a', 'pending')]));
    await refresh;
  });
  expect(latest.snapshot?.actions[0]?.status).toBe('approved');
});

test('a same-target focus refresh does not cancel a submission freshness query', async () => {
  const fake = fakeClient();
  render(fake.client, target);
  await act(async () => {
    fake.pending[0]?.deferred.resolve(snapshot([]));
  });
  let refreshed: Promise<ScriptActionsSnapshot | null> = Promise.resolve(null);
  act(() => {
    refreshed = latest.refresh();
  });
  act(() => {
    window.dispatchEvent(new Event('focus'));
  });
  let result: ScriptActionsSnapshot | null = null;
  await act(async () => {
    fake.pending[1]?.deferred.resolve(snapshot([action('a', 'approved')]));
    result = await refreshed;
  });
  expect(result).not.toBeNull();
  expect(latest.status).toBe('loading');
  await act(async () => {
    fake.pending[2]?.deferred.resolve(snapshot([]));
  });
});
