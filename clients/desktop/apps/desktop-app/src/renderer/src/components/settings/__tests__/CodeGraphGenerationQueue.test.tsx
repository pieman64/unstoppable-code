/**
 * @jest-environment jsdom
 */
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  CodeGraphGenerationQueueSnapshot,
  CodeGraphQueueEntry,
  CodeGraphReorderGenerationQueueResponse,
} from '@canopy/desktop-shared/types';
import { CodeGraphGenerationQueue } from '../CodeGraphGenerationQueue';

function queuedEntry(id: string): CodeGraphQueueEntry {
  return {
    id,
    scope: 'worktree',
    workspaceIds: ['ws-1'],
    workspaceLabel: 'Acme Website',
    worktreeId: `wt-${id}`,
    label: `Build ${id}`,
    trigger: 'manual refresh',
    queuedAt: 1,
    startedAt: null,
    status: 'queued',
    reorderable: true,
  };
}

function runningEntry(id: string): CodeGraphQueueEntry {
  return {
    id,
    scope: 'workspace-shadow',
    workspaceIds: ['ws-1'],
    label: `Build ${id}`,
    trigger: 'project refresh',
    queuedAt: 1,
    startedAt: 2,
    status: 'running',
    reorderable: false,
  };
}

interface MockApi {
  codeGraphGetGenerationQueue: jest.Mock<
    Promise<CodeGraphGenerationQueueSnapshot>,
    []
  >;
  codeGraphReorderGenerationQueue: jest.Mock<
    Promise<CodeGraphReorderGenerationQueueResponse>,
    [unknown]
  >;
  onCodeGraphGenerationQueueChanged: jest.Mock<
    () => void,
    [callback: (snapshot: CodeGraphGenerationQueueSnapshot) => void]
  >;
}

let queueListener:
  | ((snapshot: CodeGraphGenerationQueueSnapshot) => void)
  | null = null;
let originalApiDescriptor: PropertyDescriptor | undefined;

function installApi(initial: CodeGraphGenerationQueueSnapshot): MockApi {
  const api: MockApi = {
    codeGraphGetGenerationQueue: jest
      .fn<Promise<CodeGraphGenerationQueueSnapshot>, []>()
      .mockResolvedValue(initial),
    codeGraphReorderGenerationQueue: jest.fn<
      Promise<CodeGraphReorderGenerationQueueResponse>,
      [unknown]
    >(),
    onCodeGraphGenerationQueueChanged: jest.fn((cb) => {
      queueListener = cb;
      return () => {
        queueListener = null;
      };
    }),
  };
  Object.defineProperty(window, 'api', { configurable: true, value: api });
  return api;
}

async function render(): Promise<{
  container: HTMLElement;
  cleanup: () => void;
}> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(<CodeGraphGenerationQueue />);
    await Promise.resolve();
  });
  return {
    container,
    cleanup: (): void => {
      act(() => root?.unmount());
      container.remove();
    },
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('CodeGraphGenerationQueue', () => {
  beforeEach(() => {
    originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api');
    queueListener = null;
  });

  afterEach(() => {
    if (originalApiDescriptor) {
      Object.defineProperty(window, 'api', originalApiDescriptor);
    } else {
      Reflect.deleteProperty(window, 'api');
    }
  });

  it('renders the empty state when nothing is queued or running', async () => {
    installApi({ revision: 1, entries: [] });
    const { container, cleanup } = await render();
    expect(
      container.querySelector('[data-testid="code-graph-queue-empty"]'),
    ).not.toBeNull();
    cleanup();
  });

  it('pins running entries and offers move controls only for queued ones', async () => {
    installApi({
      revision: 3,
      entries: [runningEntry('r1'), queuedEntry('q1'), queuedEntry('q2')],
    });
    const { container, cleanup } = await render();
    expect(
      container.querySelector('[data-testid="code-graph-queue-running-r1"]'),
    ).not.toBeNull();
    // Running rows have no move controls.
    expect(
      container.querySelector('[data-testid="code-graph-queue-move-up-r1"]'),
    ).toBeNull();
    // First queued row cannot move up; second can. The unavailable arrow is
    // `aria-disabled` so it keeps the ghost surface instead of the shared
    // disabled fill.
    const q1Up = container.querySelector<HTMLButtonElement>(
      '[data-testid="code-graph-queue-move-up-q1"]',
    );
    expect(q1Up?.getAttribute('aria-disabled')).toBe('true');
    const q1Down = container.querySelector<HTMLButtonElement>(
      '[data-testid="code-graph-queue-move-down-q1"]',
    );
    expect(q1Down?.getAttribute('aria-disabled')).toBe('false');
    cleanup();
  });

  it('identifies the project for worktree rows and accessible move controls', async () => {
    installApi({
      revision: 3,
      entries: [queuedEntry('q1'), queuedEntry('q2')],
    });
    const { container, cleanup } = await render();
    const row = container.querySelector(
      '[data-testid="code-graph-queue-entry-q1"]',
    );
    expect(row?.textContent).toContain('Project: Acme Website');
    expect(
      container
        .querySelector('[data-testid="code-graph-queue-move-down-q1"]')
        ?.getAttribute('aria-label'),
    ).toBe('Move Build q1 in Acme Website down');
    cleanup();
  });

  it('identifies the project for running worktree rows and falls back to the project ID', async () => {
    const entry = queuedEntry('r1');
    entry.workspaceIds = ['workspace-fallback'];
    delete entry.workspaceLabel;
    entry.startedAt = 2;
    entry.status = 'running';
    entry.reorderable = false;
    installApi({ revision: 3, entries: [entry] });
    const { container, cleanup } = await render();
    const row = container.querySelector(
      '[data-testid="code-graph-queue-running-r1"]',
    );
    expect(row?.textContent).toContain('Project: workspace-fallback');
    cleanup();
  });

  it('applies an optimistic reorder and adopts the authoritative response', async () => {
    const api = installApi({
      revision: 5,
      entries: [queuedEntry('q1'), queuedEntry('q2'), queuedEntry('q3')],
    });
    const reordered: CodeGraphGenerationQueueSnapshot = {
      revision: 6,
      entries: [queuedEntry('q2'), queuedEntry('q1'), queuedEntry('q3')],
    };
    api.codeGraphReorderGenerationQueue.mockResolvedValue(reordered);

    const { container, cleanup } = await render();
    const q1Down = container.querySelector<HTMLButtonElement>(
      '[data-testid="code-graph-queue-move-down-q1"]',
    );
    act(() => q1Down?.click());
    await flush();

    expect(api.codeGraphReorderGenerationQueue).toHaveBeenCalledWith({
      revision: 5,
      orderedQueuedEntryIds: ['q2', 'q1', 'q3'],
    });
    cleanup();
  });

  it('reloads the authoritative snapshot and warns on a reorder conflict', async () => {
    const api = installApi({
      revision: 5,
      entries: [queuedEntry('q1'), queuedEntry('q2')],
    });
    const conflictSnapshot: CodeGraphGenerationQueueSnapshot = {
      revision: 9,
      entries: [queuedEntry('q2'), queuedEntry('q1')],
    };
    api.codeGraphReorderGenerationQueue.mockResolvedValue({
      ok: false,
      code: 'conflict',
      message: 'stale',
      snapshot: conflictSnapshot,
    });

    const { container, cleanup } = await render();
    const q1Down = container.querySelector<HTMLButtonElement>(
      '[data-testid="code-graph-queue-move-down-q1"]',
    );
    act(() => q1Down?.click());
    await flush();

    const error = container.querySelector(
      '[data-testid="code-graph-queue-error"]',
    );
    expect(error?.textContent).toContain('generation queue changed');
    cleanup();
  });

  it('removes stale rows when a broadcast drops entries', async () => {
    installApi({
      revision: 2,
      entries: [queuedEntry('q1'), queuedEntry('q2')],
    });
    const { container, cleanup } = await render();
    expect(
      container.querySelector('[data-testid="code-graph-queue-entry-q2"]'),
    ).not.toBeNull();

    await act(async () => {
      queueListener?.({ revision: 3, entries: [queuedEntry('q1')] });
      await Promise.resolve();
    });

    expect(
      container.querySelector('[data-testid="code-graph-queue-entry-q2"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="code-graph-queue-entry-q1"]'),
    ).not.toBeNull();
    cleanup();
  });

  it('resolves a drag against the latest authoritative entry IDs', async () => {
    const api = installApi({
      revision: 2,
      entries: [queuedEntry('q1'), queuedEntry('q2'), queuedEntry('q3')],
    });
    api.codeGraphReorderGenerationQueue.mockResolvedValue({
      revision: 4,
      entries: [queuedEntry('q1'), queuedEntry('q3'), queuedEntry('q2')],
    });
    const { container, cleanup } = await render();

    act(() => {
      container
        .querySelector('[data-testid="code-graph-queue-entry-q1"]')
        ?.dispatchEvent(new Event('dragstart', { bubbles: true }));
    });
    await act(async () => {
      queueListener?.({
        revision: 3,
        entries: [queuedEntry('q3'), queuedEntry('q1'), queuedEntry('q2')],
      });
      await Promise.resolve();
    });
    act(() => {
      container
        .querySelector('[data-testid="code-graph-queue-entry-q3"]')
        ?.dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }));
    });
    await flush();

    expect(api.codeGraphReorderGenerationQueue).toHaveBeenCalledWith({
      revision: 3,
      orderedQueuedEntryIds: ['q1', 'q3', 'q2'],
    });
    cleanup();
  });

  it('abandons a drag when a live snapshot removes the dragged entry', async () => {
    const api = installApi({
      revision: 2,
      entries: [queuedEntry('q1'), queuedEntry('q2')],
    });
    const { container, cleanup } = await render();

    act(() => {
      container
        .querySelector('[data-testid="code-graph-queue-entry-q1"]')
        ?.dispatchEvent(new Event('dragstart', { bubbles: true }));
    });
    await act(async () => {
      queueListener?.({ revision: 3, entries: [queuedEntry('q2')] });
      await Promise.resolve();
    });
    act(() => {
      container
        .querySelector('[data-testid="code-graph-queue-entry-q2"]')
        ?.dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }));
    });

    expect(api.codeGraphReorderGenerationQueue).not.toHaveBeenCalled();
    cleanup();
  });
});
