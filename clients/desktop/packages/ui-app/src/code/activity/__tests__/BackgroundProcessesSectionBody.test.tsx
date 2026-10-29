/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import type { BackgroundTask } from '@canopy/protocol/background-tasks';
import { BackgroundProcessesSectionBody } from '../BackgroundProcessesSectionBody';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const PROCESSES: readonly BackgroundTask[] = [
  {
    id: 'older-running',
    ownerToolUseId: 'tool-older-running',
    parentTaskId: null,
    startedAt: 1,
    settledAt: null,
    summary: null,
    lastDescription: null,
    kind: 'bash',
    title: 'Older running process',
    status: 'running',
    updatedAt: 100,
    outputLines: ['\u001b[32mPASS\u001b[0m older output'],
    canStop: true,
  },
  {
    id: 'completed',
    ownerToolUseId: 'tool-completed',
    parentTaskId: null,
    startedAt: 1,
    settledAt: null,
    lastDescription: null,
    kind: 'agent',
    title: 'Completed process',
    status: 'completed',
    updatedAt: 300,
    summary: 'Completed summary',
    outputLines: [],
    canStop: false,
  },
  {
    id: 'newer-running',
    ownerToolUseId: 'tool-newer-running',
    parentTaskId: null,
    startedAt: 1,
    settledAt: null,
    summary: null,
    kind: 'workflow',
    title: 'Newer running process',
    lastDescription: 'Reviewing the extraction',
    status: 'running',
    updatedAt: 200,
    outputLines: ['Workflow output is hidden'],
    canStop: true,
  },
];

describe('BackgroundProcessesSectionBody', () => {
  it('blocks descriptions in session replay but records the kind and status', () => {
    // Descriptions fall back to the command or prompt.
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <BackgroundProcessesSectionBody
          tasks={PROCESSES}
          stoppingTaskId={null}
          onStop={jest.fn()}
          onOpenDetail={jest.fn()}
        />,
      );
    });
    const leaf = (text: string): Element | undefined =>
      Array.from(container.querySelectorAll('*')).find(
        (element) =>
          element.childElementCount === 0 && element.textContent === text,
      );
    const blocked = (text: string): boolean =>
      leaf(text)?.closest(`.${REPLAY_BLOCK_CLASS}`) != null;
    expect(blocked('Newer running process')).toBe(true);
    expect(blocked('Reviewing the extraction')).toBe(true);
    expect(leaf('workflow')).toBeDefined();
    expect(blocked('workflow')).toBe(false);
    act(() => root.unmount());
    container.remove();
  });

  it('sorts active rows, renders previews, and collapses terminal rows', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <BackgroundProcessesSectionBody
          tasks={PROCESSES}
          stoppingTaskId={null}
          onStop={jest.fn()}
          onOpenDetail={jest.fn()}
        />,
      );
    });

    const rows = container.querySelectorAll('[data-testid="activity-bg-item"]');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('Newer running process');
    expect(rows[1]?.textContent).toContain('Older running process');
    expect(container.textContent).toContain('Reviewing the extraction');
    expect(container.textContent).toContain('older output');
    expect(container.textContent).not.toContain('Workflow output is hidden');
    expect(container.textContent).not.toContain('Completed process');
    expect(
      container.querySelector('[data-testid="activity-bg-body"]'),
    ).not.toBeNull();

    act(() => root.unmount());
    container.remove();
  });

  it('opens rows by pointer and keyboard and stops without opening detail', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const onStop = jest.fn();
    const onOpenDetail = jest.fn();

    act(() => {
      root.render(
        <BackgroundProcessesSectionBody
          tasks={PROCESSES}
          stoppingTaskId="newer-running"
          onStop={onStop}
          onOpenDetail={onOpenDetail}
        />,
      );
    });

    const rows = container.querySelectorAll<HTMLElement>(
      '[data-testid="activity-bg-item"]',
    );
    const stops = container.querySelectorAll<HTMLButtonElement>(
      '[data-testid="activity-bg-stop"]',
    );
    expect(stops[0]?.textContent).toBe('Stopping…');
    expect(stops[0]?.disabled).toBe(true);

    act(() => rows[1]?.click());
    expect(onOpenDetail).toHaveBeenCalledWith(PROCESSES[0]);

    act(() => {
      rows[0]?.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }),
      );
    });
    expect(onOpenDetail).toHaveBeenCalledWith(PROCESSES[2]);

    act(() => stops[1]?.click());
    expect(onStop).toHaveBeenCalledWith(PROCESSES[0]);
    expect(onOpenDetail).toHaveBeenCalledTimes(2);

    act(() => root.unmount());
    container.remove();
  });

  it('expands terminal rows and returns no body for an empty list', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const onOpenDetail = jest.fn();

    act(() => {
      root.render(
        <BackgroundProcessesSectionBody
          tasks={PROCESSES}
          stoppingTaskId={null}
          onStop={jest.fn()}
          onOpenDetail={onOpenDetail}
        />,
      );
    });

    const toggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="activity-bg-stopped-toggle"]',
    );
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    act(() => toggle?.click());
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(container.textContent).toContain('Completed process');
    expect(container.textContent).toContain('Completed summary');

    const rows = container.querySelectorAll<HTMLElement>(
      '[data-testid="activity-bg-item"]',
    );
    act(() => {
      rows[2]?.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, key: ' ' }),
      );
    });
    expect(onOpenDetail).toHaveBeenCalledWith(PROCESSES[1]);

    act(() => {
      root.render(
        <BackgroundProcessesSectionBody
          tasks={[]}
          stoppingTaskId={null}
          onStop={jest.fn()}
          onOpenDetail={jest.fn()}
        />,
      );
    });
    expect(container.childElementCount).toBe(0);

    act(() => root.unmount());
    container.remove();
  });
});
