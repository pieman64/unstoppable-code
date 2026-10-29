/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ScriptActionsAddReceipt } from '@canopy/protocol/script-actions';
import {
  createScriptActionsNoticeDeduper,
  pollScriptActionsReceipt,
  shouldNotifyScriptActionsReceipt,
  useScriptActionsAddNotices,
  type ScriptActionsAddNotice,
  type ScriptActionsAddNoticeRequest,
} from '../add-notice';
import { scriptActionsFoundMessage } from '../review-model';
import {
  createFakeScriptActionsClient,
  snapshotOf,
} from './fake-script-actions-client';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

function receipt(
  overrides: Partial<ScriptActionsAddReceipt> = {},
): ScriptActionsAddReceipt {
  return {
    projectId: 'proj',
    worktreeId: null,
    operationId: 'op-1',
    repoIds: ['repo-a'],
    status: 'complete',
    pendingCount: 3,
    completedAt: '2026-10-21T00:00:00.000Z',
    ...overrides,
  };
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

describe('scriptActionsFoundMessage', () => {
  it('pluralizes and falls back to the project', () => {
    expect(scriptActionsFoundMessage(1, 'api')).toBe(
      'Found 1 script in api to review',
    );
    expect(scriptActionsFoundMessage(4, null)).toBe(
      'Found 4 scripts in this project to review',
    );
  });
});

describe('notice decisions', () => {
  it('notifies only completed receipts with pending scripts', () => {
    expect(shouldNotifyScriptActionsReceipt(receipt())).toBe(true);
    expect(shouldNotifyScriptActionsReceipt(receipt({ pendingCount: 0 }))).toBe(
      false,
    );
    expect(
      shouldNotifyScriptActionsReceipt(receipt({ status: 'failed' })),
    ).toBe(false);
    expect(
      shouldNotifyScriptActionsReceipt(receipt({ status: 'scanning' })),
    ).toBe(false);
    expect(shouldNotifyScriptActionsReceipt(null)).toBe(false);
  });

  it('dedupes by operation ID', () => {
    const fresh = createScriptActionsNoticeDeduper(2);
    expect(fresh('a')).toBe(true);
    expect(fresh('a')).toBe(false);
    expect(fresh('b')).toBe(true);
    expect(fresh('c')).toBe(true);
    // The oldest entry ages out of the bounded set.
    expect(fresh('a')).toBe(true);
  });
});

describe('pollScriptActionsReceipt', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('backs off until the scan settles', async () => {
    const fake = createFakeScriptActionsClient(snapshotOf([]));
    const responses = [
      receipt({ status: 'scanning' }),
      receipt({ status: 'scanning' }),
      receipt({ status: 'scanning' }),
      receipt(),
    ];
    const times: number[] = [];
    fake.handlers.set('scriptActions.receipt', () => {
      times.push(Date.now());
      return Promise.resolve(responses.shift() ?? null);
    });
    const start = Date.now();
    const result = pollScriptActionsReceipt(fake.client, {
      projectId: 'proj',
      operationId: 'op-1',
    });
    await advance(10_000);
    await expect(result).resolves.toEqual(receipt());
    expect(times.map((time) => time - start)).toEqual([0, 1_000, 3_000, 7_000]);
  });

  it('gives up at the deadline', async () => {
    const fake = createFakeScriptActionsClient(snapshotOf([]));
    fake.handlers.set('scriptActions.receipt', () =>
      Promise.resolve(receipt({ status: 'scanning' })),
    );
    const result = pollScriptActionsReceipt(
      fake.client,
      { projectId: 'proj', operationId: 'op-1' },
      { deadlineMs: 5_000 },
    );
    await advance(10_000);
    await expect(result).resolves.toBeNull();
  });

  it('keeps polling through request failures', async () => {
    const fake = createFakeScriptActionsClient(snapshotOf([]));
    let calls = 0;
    fake.handlers.set('scriptActions.receipt', () => {
      calls += 1;
      return calls === 1
        ? Promise.reject(new Error('offline'))
        : Promise.resolve(receipt());
    });
    const result = pollScriptActionsReceipt(fake.client, {
      projectId: 'proj',
      operationId: 'op-1',
    });
    await advance(2_000);
    await expect(result).resolves.toEqual(receipt());
  });
});

describe('useScriptActionsAddNotices', () => {
  let container: HTMLDivElement;
  let root: Root;
  let track: ((request: ScriptActionsAddNoticeRequest) => void) | null;

  function Harness({
    client,
    scopeKey,
    onNotice,
  }: {
    readonly client: Parameters<typeof useScriptActionsAddNotices>[0]['client'];
    readonly scopeKey: string;
    readonly onNotice: (notice: ScriptActionsAddNotice) => void;
  }): null {
    track = useScriptActionsAddNotices({ client, scopeKey, onNotice });
    return null;
  }

  beforeEach(() => {
    jest.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    track = null;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    jest.useRealTimers();
  });

  function setup(
    responses: (ScriptActionsAddReceipt | null)[],
    capabilities = { scriptActions: true },
  ): {
    onNotice: jest.Mock;
    fake: ReturnType<typeof createFakeScriptActionsClient>;
  } {
    const fake = createFakeScriptActionsClient(snapshotOf([]), capabilities);
    fake.handlers.set('scriptActions.receipt', () =>
      Promise.resolve(
        responses.length > 1
          ? (responses.shift() ?? null)
          : (responses[0] ?? null),
      ),
    );
    const onNotice = jest.fn();
    act(() => {
      root.render(
        <Harness client={fake.client} scopeKey="a" onNotice={onNotice} />,
      );
    });
    return { onNotice, fake };
  }

  it('reports one notice when the receipt completes', async () => {
    const { onNotice } = setup([receipt({ status: 'scanning' }), receipt()]);
    act(() =>
      track?.({ projectId: 'proj', operationId: 'op-1', targetName: 'api' }),
    );
    act(() =>
      track?.({ projectId: 'proj', operationId: 'op-1', targetName: 'api' }),
    );
    await advance(5_000);
    expect(onNotice).toHaveBeenCalledTimes(1);
    expect(onNotice).toHaveBeenCalledWith({
      receipt: receipt(),
      targetName: 'api',
    });
  });

  it('shows nothing on timeout or failure', async () => {
    const timedOut = setup([receipt({ status: 'scanning' })]);
    act(() =>
      track?.({ projectId: 'proj', operationId: 'op-1', targetName: null }),
    );
    await advance(70_000);
    expect(timedOut.onNotice).not.toHaveBeenCalled();

    const failed = setup([receipt({ status: 'failed', operationId: 'op-2' })]);
    act(() =>
      track?.({ projectId: 'proj', operationId: 'op-2', targetName: null }),
    );
    await advance(1_000);
    expect(failed.onNotice).not.toHaveBeenCalled();
  });

  it('cancels polling on unmount and on scope change', async () => {
    const { onNotice, fake } = setup([
      receipt({ status: 'scanning' }),
      receipt(),
    ]);
    act(() =>
      track?.({ projectId: 'proj', operationId: 'op-1', targetName: null }),
    );
    act(() => {
      root.render(
        <Harness client={fake.client} scopeKey="b" onNotice={onNotice} />,
      );
    });
    await advance(10_000);
    expect(onNotice).not.toHaveBeenCalled();
    const polls = fake.calls.filter(
      (call) => call.name === 'scriptActions.receipt',
    ).length;
    expect(polls).toBe(1);
  });

  it('does not poll without the capability', async () => {
    const { onNotice, fake } = setup([receipt()], { scriptActions: false });
    act(() =>
      track?.({ projectId: 'proj', operationId: 'op-1', targetName: null }),
    );
    await advance(5_000);
    expect(fake.calls).toHaveLength(0);
    expect(onNotice).not.toHaveBeenCalled();
  });
});
