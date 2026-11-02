/**
 * @jest-environment jsdom
 */
import { act, StrictMode, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  CHAT_PREVIEW_MARKED_UNREAD_COPY,
  ChatPreviewPopover,
  type ChatPreviewRow,
} from '../ChatPreviewPopover';
import {
  PipelineStatusPopover,
  type PipelineStatusPopoverEntry,
} from '../PipelineStatusPopover';
import { RunBadgePopover, type RunBadgeRow } from '../RunBadgePopover';
import {
  TerminalStatusPopover,
  type TerminalPopoverRow,
} from '../TerminalStatusPopover';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function render(node: JSX.Element): {
  container: HTMLDivElement;
  root: Root;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  return { container, root };
}

function cleanup(root: Root, container: HTMLDivElement): void {
  act(() => {
    root.unmount();
  });
  container.remove();
}

function anchorRect(): DOMRect {
  return new DOMRect(0, 0, 120, 20);
}

function pipelineEntries(count: number): PipelineStatusPopoverEntry[] {
  return Array.from({ length: count }, (_unused, index) => ({
    id: `run-${String(index + 1)}`,
    name: `Pipeline ${String(index + 1)}`,
    status: 'success',
  }));
}

/**
 * jsdom gives every element a zero-sized rect, which the popover reads as "no
 * layout yet" and leaves unclamped. Give the entry rows a uniform height so the
 * measured three-row bound is deterministic.
 */
function stubPipelineRowLayout(rowHeight: number): () => void {
  const propertyName = 'getBoundingClientRect';
  const original = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    propertyName,
  );
  Object.defineProperty(HTMLElement.prototype, propertyName, {
    configurable: true,
    writable: true,
    value: function (this: HTMLElement): DOMRect {
      const parent = this.parentElement;
      if (parent?.dataset.testid === 'pipeline-status-popover-list') {
        const index = Array.prototype.indexOf.call(parent.children, this);
        return new DOMRect(0, index * rowHeight, 200, rowHeight);
      }
      // Everything else keeps jsdom's zero-sized default.
      return new DOMRect(0, 0, 0, 0);
    },
  });
  return (): void => {
    if (original) {
      Object.defineProperty(HTMLElement.prototype, propertyName, original);
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, propertyName);
    }
  };
}

describe('shared worktree popovers', () => {
  afterEach((): void => {
    document.body.innerHTML = '';
  });

  it('restores inherited pipeline row layout after the stub is removed', () => {
    const propertyName = 'getBoundingClientRect';
    const originalOwnDescriptor = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      propertyName,
    );
    const restoreLayout = stubPipelineRowLayout(20);

    try {
      restoreLayout();
      expect(
        Object.getOwnPropertyDescriptor(HTMLElement.prototype, propertyName),
      ).toEqual(originalOwnDescriptor);
    } finally {
      if (originalOwnDescriptor) {
        Object.defineProperty(
          HTMLElement.prototype,
          propertyName,
          originalOwnDescriptor,
        );
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, propertyName);
      }
    }
  });

  it('renders pipeline status details and the empty state', () => {
    const entries: PipelineStatusPopoverEntry[] = [
      { id: 'run-1', name: 'Quality Gate', status: 'success' },
      { id: 'run-2', name: 'Deploy Preview', status: 'running' },
    ];
    const rendered = render(
      <PipelineStatusPopover
        anchorRect={anchorRect()}
        entries={entries}
        status="running"
      />,
    );

    try {
      expect(document.body.textContent).toContain('Workflows Running');
      expect(document.body.textContent).toContain('Quality Gate');
      expect(document.body.textContent).toContain('Success');
      expect(document.body.textContent).toContain('Deploy Preview');
      expect(document.body.textContent).toContain('Running');

      act(() => {
        rendered.root.render(
          <PipelineStatusPopover
            anchorRect={anchorRect()}
            entries={[]}
            status="running"
          />,
        );
      });
      expect(document.body.textContent).toContain('No workflow details');
    } finally {
      cleanup(rendered.root, rendered.container);
    }
  });

  it('freezes a paused run duration at the pause instant', () => {
    // The badge tooltip used to keep counting wall-clock time while the whole
    // run sat paused, so a run that did 30s of work before pausing read as
    // hours old.
    const nowSpy = jest
      .spyOn(Date, 'now')
      .mockReturnValue(Date.parse('2026-03-23T14:00:00.000Z'));
    const entries: PipelineStatusPopoverEntry[] = [
      {
        id: 'run-paused',
        name: 'Quality Gate',
        status: 'paused',
        startedAt: '2026-03-23T12:00:00.000Z',
        pausedAt: '2026-03-23T12:00:30.000Z',
      },
      {
        id: 'run-resumed',
        name: 'Deploy Preview',
        status: 'running',
        startedAt: '2026-03-23T13:00:00.000Z',
        pausedMs: 3_540_000,
      },
    ];
    const rendered = render(
      <PipelineStatusPopover
        anchorRect={anchorRect()}
        entries={entries}
        status="paused"
      />,
    );

    try {
      const list = document.body.querySelector(
        '[data-testid="pipeline-status-popover-list"]',
      );
      expect(list?.children[0].textContent).toContain('30s');
      expect(list?.children[0].textContent).not.toContain('2h');
      // Resumed after a one-hour pause: only the minute of real work counts.
      expect(list?.children[1].textContent).toContain('1m');
      expect(list?.children[1].textContent).not.toContain('1h');
    } finally {
      cleanup(rendered.root, rendered.container);
      nowSpy.mockRestore();
    }
  });

  it('counts pipeline entries in the header only when there are any', () => {
    const rendered = render(
      <PipelineStatusPopover
        anchorRect={anchorRect()}
        entries={[]}
        status="unseen"
      />,
    );

    try {
      const header = (): Element | null =>
        document.body.querySelector(
          '[data-testid="pipeline-status-popover-header"]',
        );
      expect(header()?.textContent).toBe('Workflows Completed');

      act(() => {
        rendered.root.render(
          <PipelineStatusPopover
            anchorRect={anchorRect()}
            entries={pipelineEntries(4)}
            status="unseen"
          />,
        );
      });
      expect(header()?.textContent).toBe('Workflows Completed (4)');
    } finally {
      cleanup(rendered.root, rendered.container);
    }
  });

  it('scrolls the pipeline entry list past three rows and leaves the header fixed', () => {
    const restoreLayout = stubPipelineRowLayout(20);
    const rendered = render(
      <PipelineStatusPopover
        anchorRect={anchorRect()}
        entries={pipelineEntries(3)}
        status="unseen"
      />,
    );

    try {
      const list = (): HTMLElement => {
        const el = document.body.querySelector(
          '[data-testid="pipeline-status-popover-list"]',
        );
        if (!(el instanceof HTMLElement)) {
          throw new Error('pipeline entry list not rendered');
        }
        return el;
      };

      // Three rows fit, so the list stays unclamped and click-through.
      expect(list().dataset.scrollable).toBe('false');
      expect(list().style.maxHeight).toBe('');
      expect(list().className).not.toContain('overflow-y-auto');

      act(() => {
        rendered.root.render(
          <PipelineStatusPopover
            anchorRect={anchorRect()}
            entries={pipelineEntries(12)}
            status="unseen"
          />,
        );
      });

      // Bounded to the measured height of the first three rows.
      expect(list().dataset.scrollable).toBe('true');
      expect(list().style.maxHeight).toBe('60px');
      expect(list().className).toContain('overflow-y-auto');
      expect(list().className).toContain('pointer-events-auto');
      // All twelve rows stay mounted inside the scroll region, and the header
      // is a sibling of the list rather than part of the scrolled content.
      expect(list().children).toHaveLength(12);
      expect(
        list().querySelector('[data-testid="pipeline-status-popover-header"]'),
      ).toBeNull();
    } finally {
      cleanup(rendered.root, rendered.container);
      restoreLayout();
    }
  });

  it('reports hover on the scrollable pipeline list so hosts can defer closing', () => {
    const restoreLayout = stubPipelineRowLayout(20);
    const onListMouseEnter = jest.fn();
    const onListMouseLeave = jest.fn();
    const onListFocus = jest.fn();
    const onListBlur = jest.fn();
    const onListDismiss = jest.fn();
    const onScrollableListReady = jest.fn();
    const onParentPointerDown = jest.fn();
    const onParentClick = jest.fn();
    const onParentContextMenu = jest.fn();
    const rendered = render(
      <div
        onPointerDown={onParentPointerDown}
        onClick={onParentClick}
        onContextMenu={onParentContextMenu}
      >
        <PipelineStatusPopover
          anchorRect={anchorRect()}
          entries={pipelineEntries(8)}
          status="unseen"
          listId="pipeline-list"
          onListMouseEnter={onListMouseEnter}
          onListMouseLeave={onListMouseLeave}
          onListFocus={onListFocus}
          onListBlur={onListBlur}
          onListDismiss={onListDismiss}
          onScrollableListReady={onScrollableListReady}
        />
      </div>,
    );

    try {
      const list = document.body.querySelector(
        '[data-testid="pipeline-status-popover-list"]',
      );
      if (!(list instanceof HTMLElement)) {
        throw new Error('pipeline entry list not rendered');
      }
      expect(list.id).toBe('pipeline-list');
      expect(list.tabIndex).toBe(0);
      expect(onScrollableListReady).toHaveBeenCalledWith(list);

      act(() => {
        list.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
        list.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        list.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
      });
      expect(onParentPointerDown).not.toHaveBeenCalled();
      expect(onParentClick).not.toHaveBeenCalled();
      expect(onParentContextMenu).not.toHaveBeenCalled();

      act(() => {
        list.dispatchEvent(
          new MouseEvent('mouseover', { bubbles: true, relatedTarget: null }),
        );
      });
      expect(onListMouseEnter).toHaveBeenCalledTimes(1);

      act(() => {
        list.dispatchEvent(
          new MouseEvent('mouseout', { bubbles: true, relatedTarget: null }),
        );
      });
      expect(onListMouseLeave).toHaveBeenCalledTimes(1);

      act(() => list.focus());
      expect(onListFocus).toHaveBeenCalledTimes(1);
      act(() => list.blur());
      expect(onListBlur).toHaveBeenCalledTimes(1);

      act(() => {
        list.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        );
      });
      expect(onListDismiss).toHaveBeenCalledTimes(1);

      act(() => list.focus());
      expect(onListFocus).toHaveBeenCalledTimes(2);

      act(() => {
        rendered.root.render(
          <PipelineStatusPopover
            anchorRect={anchorRect()}
            entries={pipelineEntries(2)}
            status="unseen"
            listId="pipeline-list"
            onListFocus={onListFocus}
            onListBlur={onListBlur}
            onListDismiss={onListDismiss}
          />,
        );
      });
      expect(onListBlur).toHaveBeenCalledTimes(2);
      const shortList = document.getElementById('pipeline-list');
      expect(shortList).not.toBeNull();
      act(() => {
        shortList?.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      });
      expect(onListBlur).toHaveBeenCalledTimes(3);
    } finally {
      cleanup(rendered.root, rendered.container);
      restoreLayout();
    }
  });

  it('does not report a list blur during StrictMode replay before focus', () => {
    const onListBlur = jest.fn();
    const rendered = render(
      <StrictMode>
        <PipelineStatusPopover
          anchorRect={anchorRect()}
          entries={pipelineEntries(2)}
          status="unseen"
          onListBlur={onListBlur}
        />
      </StrictMode>,
    );

    try {
      expect(onListBlur).not.toHaveBeenCalled();
    } finally {
      cleanup(rendered.root, rendered.container);
    }
  });

  it('renders terminal status details and the empty state', () => {
    const rows: TerminalPopoverRow[] = [
      {
        terminalId: 'terminal-1',
        label: 'Dev Server',
        statusText: 'exit 0',
        statusClass: 'text-success',
        dotClass: 'bg-success',
      },
    ];
    const rendered = render(
      <TerminalStatusPopover
        anchorRect={anchorRect()}
        rows={rows}
        status="unseen"
      />,
    );

    try {
      expect(document.body.textContent).toContain('Terminals Completed');
      expect(document.body.textContent).toContain('Dev Server');
      expect(document.body.textContent).toContain('exit 0');
      // Automation hooks: the popover root and one row per terminal.
      expect(
        document.body.querySelector('[data-testid="terminal-status-popover"]'),
      ).not.toBeNull();
      const row = document.body.querySelector<HTMLElement>(
        '[data-testid="terminal-status-popover-row"]',
      );
      expect(row?.dataset.terminalId).toBe('terminal-1');
      expect(row?.textContent).toBe('Dev Serverexit 0');

      act(() => {
        rendered.root.render(
          <TerminalStatusPopover
            anchorRect={anchorRect()}
            rows={[]}
            status="unseen"
          />,
        );
      });
      expect(document.body.textContent).toContain('No terminal details');
    } finally {
      cleanup(rendered.root, rendered.container);
    }
  });

  it('renders run badge details, its test id, and the empty state', () => {
    const rows: RunBadgeRow[] = [
      {
        id: 'script-1',
        label: 'Typecheck',
        statusText: 'running',
        statusClass: 'text-sky-400',
        dotClass: 'bg-sky-400',
      },
    ];
    const rendered = render(
      <RunBadgePopover
        anchorRect={anchorRect()}
        rows={rows}
        heading="Scripts running"
        emptyText="No script details"
      />,
    );

    try {
      expect(document.body.textContent).toContain('Scripts running');
      expect(document.body.textContent).toContain('Typecheck');
      expect(document.body.textContent).toContain('running');
      expect(
        document.body.querySelector(
          '[data-testid="worktree-row-script-popover"]',
        ),
      ).not.toBeNull();

      act(() => {
        rendered.root.render(
          <RunBadgePopover
            anchorRect={anchorRect()}
            rows={[]}
            heading="Scripts running"
            emptyText="No script details"
          />,
        );
      });
      expect(document.body.textContent).toContain('No script details');
    } finally {
      cleanup(rendered.root, rendered.container);
    }
  });

  it('renders chat preview details, fallbacks, and scheduling', () => {
    const rows: ChatPreviewRow[] = [
      {
        chatId: 'chat-1',
        title: 'Implementation',
        providerType: 'codex',
        preview: 'Tests are ready',
      },
      {
        chatId: 'chat-2',
        title: 'Scheduled review',
        providerType: undefined,
        preview: undefined,
        scheduledAt: '2026-07-22T10:00:00.000Z',
      },
    ];
    const rendered = render(
      <ChatPreviewPopover
        anchorRect={anchorRect()}
        rows={rows}
        heading="Chats"
      />,
    );

    try {
      expect(document.body.textContent).toContain('Chats');
      expect(document.body.textContent).toContain('Implementation');
      expect(document.body.textContent).toContain('Tests are ready');
      expect(document.body.textContent).toContain('Scheduled review');
      expect(document.body.textContent).toContain('No response yet');
      expect(document.body.textContent).toContain('Scheduled for ');
    } finally {
      cleanup(rendered.root, rendered.container);
    }
  });

  test('a chat marked unread says so instead of its last response', () => {
    const rows: ChatPreviewRow[] = [
      {
        chatId: 'chat-marked',
        title: 'Flagged for later',
        providerType: 'claude',
        preview: 'Old reply text',
        markedUnread: true,
      },
      {
        chatId: 'chat-replied',
        title: 'New reply',
        providerType: 'claude',
        preview: 'Fresh reply text',
      },
    ];
    const rendered = render(
      <ChatPreviewPopover
        anchorRect={anchorRect()}
        rows={rows}
        heading="Unread chats"
      />,
    );

    try {
      expect(CHAT_PREVIEW_MARKED_UNREAD_COPY).toBe('Marked as unread');
      expect(document.body.textContent).toContain('Marked as unread');
      expect(document.body.textContent).not.toContain('Old reply text');
      expect(document.body.textContent).toContain('Fresh reply text');
    } finally {
      cleanup(rendered.root, rendered.container);
    }
  });
});
