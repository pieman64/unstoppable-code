import type { TerminalClient } from '@canopy/app-core';
import {
  TERMINAL_CONNECTION_LOST_SIGNAL,
  TERMINAL_SANDBOX_ASLEEP_SIGNAL,
} from '@canopy/protocol/terminal';
import { bindTerminalClient } from '../terminal-client-binding';
import { useTerminalActivityStore } from '../terminal-activity-store';
import { subscribeTerminalActivityFeed } from '../terminal-activity-feed';
import { createFakeTerminalClient } from './fake-terminal-client';

const event = {
  terminalId: 't',
  projectId: 'p',
  worktreeId: 'w',
  running: true,
  processName: 'node',
  occurredAt: '2026-09-22T00:00:00.000Z',
};
let cleanups: Array<() => void>;
beforeEach(() => {
  cleanups = [];
});
afterEach(() => {
  cleanups.reverse().forEach((cleanup) => cleanup());
});
function keep(cleanup: () => void): () => void {
  cleanups.push(cleanup);
  return cleanup;
}

it('is inert until acquired and installs both listeners before snapshot seeding', () => {
  const fake = createFakeTerminalClient();
  keep(bindTerminalClient(fake.client));
  expect(fake.listenerCount('terminal.running-changed')).toBe(0);
  expect(fake.calls.queries['terminal.list']).not.toHaveBeenCalled();
  fake.calls.queries['terminal.list'].mockImplementation(() => {
    expect(fake.listenerCount('terminal.running-changed')).toBe(1);
    expect(fake.listenerCount('terminal.exit')).toBe(1);
    fake.emit('terminal.running-changed', event);
    return Promise.resolve([]);
  });
  keep(subscribeTerminalActivityFeed());
  expect(useTerminalActivityStore.getState().baselineEstablished.has('t')).toBe(
    true,
  );
  expect(useTerminalActivityStore.getState().unseenWorktreeKeys.size).toBe(0);
});

it('shares one feed, reconnects across unbound intervals, and releases callers independently', () => {
  const a = keep(subscribeTerminalActivityFeed());
  const b = keep(subscribeTerminalActivityFeed());
  const first = createFakeTerminalClient();
  const unbind = keep(bindTerminalClient(first.client));
  expect(first.listenerCount('terminal.exit')).toBe(1);
  expect(first.calls.queries['terminal.list']).toHaveBeenCalledTimes(1);
  a();
  a();
  expect(first.listenerCount('terminal.exit')).toBe(1);
  unbind();
  expect(first.listenerCount('terminal.exit')).toBe(0);
  const next = createFakeTerminalClient();
  keep(bindTerminalClient(next.client));
  expect(next.listenerCount('terminal.exit')).toBe(1);
  unbind();
  expect(next.listenerCount('terminal.exit')).toBe(1);
  b();
  expect(next.listenerCount('terminal.exit')).toBe(0);
});

it('fences retained old callbacks after replacement', () => {
  const first = createFakeTerminalClient();
  const transport: TerminalClient = {
    ...first.client,
    subscribe: (name, handler) => {
      first.client.subscribe(name, handler);
      return (): void => undefined;
    },
  };
  keep(bindTerminalClient(transport));
  keep(subscribeTerminalActivityFeed());
  keep(bindTerminalClient(createFakeTerminalClient().client));
  first.emit('terminal.running-changed', event);
  expect(useTerminalActivityStore.getState().entriesByWorktree).toEqual({});
});

it('rolls back a partial acquisition and preserves the original error', () => {
  const fake = createFakeTerminalClient();
  const failure = new Error('exit subscribe failed');
  const transport: TerminalClient = {
    ...fake.client,
    subscribe: (name, handler) => {
      if (name === 'terminal.exit') throw failure;
      const unsubscribe = fake.client.subscribe(name, handler);
      return (): void => {
        unsubscribe();
        throw new Error('cleanup failed');
      };
    },
  };
  keep(bindTerminalClient(transport));
  expect(subscribeTerminalActivityFeed).toThrow(failure);
  expect(fake.listenerCount('terminal.running-changed')).toBe(0);
  expect(fake.calls.queries['terminal.list']).not.toHaveBeenCalled();
  const next = createFakeTerminalClient();
  keep(bindTerminalClient(next.client));
  keep(subscribeTerminalActivityFeed());
  expect(next.listenerCount('terminal.exit')).toBe(1);
});

it('recovers registered consumers after a failed replacement acquisition', () => {
  keep(bindTerminalClient(createFakeTerminalClient().client));
  keep(subscribeTerminalActivityFeed());
  const failed = createFakeTerminalClient();
  const transport: TerminalClient = {
    ...failed.client,
    subscribe: (name, handler) => {
      if (name === 'terminal.exit') throw new Error('failed');
      return failed.client.subscribe(name, handler);
    },
  };
  expect(() => bindTerminalClient(transport)).toThrow('failed');
  expect(failed.listenerCount('terminal.running-changed')).toBe(0);
  const next = createFakeTerminalClient();
  keep(bindTerminalClient(next.client));
  expect(next.listenerCount('terminal.exit')).toBe(1);
});

it('handles a rejected snapshot without tearing down the feed', async () => {
  const fake = createFakeTerminalClient();
  fake.calls.queries['terminal.list'].mockRejectedValue(new Error('offline'));
  keep(bindTerminalClient(fake.client));
  keep(subscribeTerminalActivityFeed());
  await Promise.resolve();
  expect(fake.listenerCount('terminal.exit')).toBe(1);
});

it('attempts both releases and allows reacquisition when cleanup throws', () => {
  const fake = createFakeTerminalClient();
  const transport: TerminalClient = {
    ...fake.client,
    subscribe: (name, handler) => {
      const unsubscribe = fake.client.subscribe(name, handler);
      return (): void => {
        unsubscribe();
        if (name === 'terminal.running-changed')
          throw new Error('cleanup failed');
      };
    },
  };
  keep(bindTerminalClient(transport));
  const release = keep(subscribeTerminalActivityFeed());
  expect(release).toThrow('cleanup failed');
  expect(fake.listenerCount('terminal.exit')).toBe(0);
  const next = createFakeTerminalClient();
  keep(bindTerminalClient(next.client));
  keep(subscribeTerminalActivityFeed());
  expect(next.listenerCount('terminal.exit')).toBe(1);
});

describe('command outcomes and environment shutdowns', () => {
  const WORKTREE_KEY = 'p/w';
  let nowMs = 0;

  interface EventRoute {
    terminalId: string;
    projectId: string;
    worktreeId: string;
    occurredAt: string;
  }
  function route(terminalId: string): EventRoute {
    return {
      terminalId,
      projectId: 'p',
      worktreeId: 'w',
      occurredAt: event.occurredAt,
    };
  }

  beforeEach(() => {
    nowMs = 1_700_000_000_000;
    jest.spyOn(Date, 'now').mockImplementation((): number => nowMs);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('routes explicit command statuses and drops only the shut-down terminal', () => {
    const fake = createFakeTerminalClient();
    keep(bindTerminalClient(fake.client));
    keep(subscribeTerminalActivityFeed());

    fake.emit('terminal.running-changed', {
      ...route('t1'),
      running: true,
      processName: 'make',
    });
    fake.emit('terminal.running-changed', {
      ...route('t2'),
      running: true,
      processName: 'sleep',
    });
    nowMs += 3_000;
    fake.emit('terminal.running-changed', {
      ...route('t1'),
      running: false,
      processName: null,
      exitCode: 2,
    });
    fake.emit('terminal.exit', {
      ...route('t2'),
      exitCode: null,
      signal: TERMINAL_CONNECTION_LOST_SIGNAL,
    });

    const state = useTerminalActivityStore.getState();
    expect(Object.keys(state.entriesByWorktree[WORKTREE_KEY] ?? {})).toEqual([
      't1',
    ]);
    expect(state.entriesByWorktree[WORKTREE_KEY]?.t1).toMatchObject({
      running: false,
      exitCode: 2,
      endedAt: nowMs,
    });
    expect(state.runningWorktreeKeys.has(WORKTREE_KEY)).toBe(false);
    expect(state.unseenWorktreeKeys.has(WORKTREE_KEY)).toBe(true);
    expect(state.unseenFailureWorktreeKeys.has(WORKTREE_KEY)).toBe(true);
  });

  it('re-seeds a terminal restarted under the same id after the project slept', () => {
    const fake = createFakeTerminalClient();
    keep(bindTerminalClient(fake.client));
    keep(subscribeTerminalActivityFeed());

    fake.emit('terminal.running-changed', {
      ...route('t1'),
      running: true,
      processName: 'sleep',
    });
    nowMs += 10_000;
    fake.emit('terminal.exit', {
      ...route('t1'),
      exitCode: null,
      signal: TERMINAL_SANDBOX_ASLEEP_SIGNAL,
    });
    expect(
      useTerminalActivityStore.getState().baselineEstablished.has('t1'),
    ).toBe(false);
    expect(useTerminalActivityStore.getState().unseenWorktreeKeys.size).toBe(0);
    expect(
      useTerminalActivityStore.getState().unseenFailureWorktreeKeys.size,
    ).toBe(0);

    fake.emit('terminal.running-changed', {
      ...route('t1'),
      running: false,
      processName: null,
    });
    nowMs += 1_000;
    fake.emit('terminal.running-changed', {
      ...route('t1'),
      running: true,
      processName: 'npm',
    });
    nowMs += 3_000;
    fake.emit('terminal.running-changed', {
      ...route('t1'),
      running: false,
      processName: null,
      exitCode: 0,
    });

    const state = useTerminalActivityStore.getState();
    expect(state.unseenWorktreeKeys.has(WORKTREE_KEY)).toBe(true);
    expect(state.unseenFailureWorktreeKeys.has(WORKTREE_KEY)).toBe(false);
    expect(state.entriesByWorktree[WORKTREE_KEY]?.t1).toMatchObject({
      exitCode: 0,
      signal: null,
      endedAt: nowMs,
    });
  });
});
