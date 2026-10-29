/** @jest-environment jsdom */
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PipelineStatusPopoverEntry } from '@canopy/ui-shared/components';
import { SidebarPipelineStatusPopover } from '../SidebarPipelineStatusPopover';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/*
 * CAN-3053 finding 6: the pipeline popover's entries were a one-shot
 * `getState()` snapshot read once per row render, so an in-flight run's
 * progress (or a new run starting) went stale until the popover was closed
 * and reopened. `SidebarPipelineStatusPopover` mirrors the existing
 * `SidebarTerminalStatusPopover` live-subscription shape; this file proves
 * both the static fallback (no `subscribeEntries`) and the live path (with
 * it) actually behave as documented.
 */

const ANCHOR_RECT: DOMRect = {
  top: 0,
  left: 0,
  right: 10,
  bottom: 10,
  width: 10,
  height: 10,
  x: 0,
  y: 0,
  toJSON: (): unknown => ({}),
};

function entry(id: string): PipelineStatusPopoverEntry {
  return { id, name: `Pipeline ${id}`, status: 'running' };
}

function render(element: ReactElement): { root: Root; cleanup: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  return {
    root,
    cleanup: (): void => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function popoverHeader(): string | null {
  return (
    document.body.querySelector(
      '[data-testid="pipeline-status-popover-header"]',
    )?.textContent ?? null
  );
}

describe('SidebarPipelineStatusPopover', () => {
  it('reads entries once when no live source is supplied (static fallback)', () => {
    const getEntries = jest.fn().mockReturnValue([entry('a')]);
    const { cleanup } = render(
      <SidebarPipelineStatusPopover
        anchorRect={ANCHOR_RECT}
        worktreeLocalId="wt"
        workspaceLocalId="ws"
        status="running"
        getEntries={getEntries}
      />,
    );
    expect(popoverHeader()).toContain('(1)');
    expect(getEntries).toHaveBeenCalledWith('wt', 'ws');
    cleanup();
  });

  it('re-reads entries live when a subscribe source is supplied, without remounting', () => {
    let notify: (() => void) | undefined;
    let liveEntries: PipelineStatusPopoverEntry[] = [entry('a')];
    const getEntries = jest.fn(() => liveEntries);
    const subscribeEntries = jest.fn(
      (
        _worktreeLocalId: string,
        _workspaceLocalId: string,
        onChange: () => void,
      ): (() => void) => {
        notify = onChange;
        return () => {
          notify = undefined;
        };
      },
    );
    const { cleanup } = render(
      <SidebarPipelineStatusPopover
        anchorRect={ANCHOR_RECT}
        worktreeLocalId="wt"
        workspaceLocalId="ws"
        status="running"
        getEntries={getEntries}
        subscribeEntries={subscribeEntries}
      />,
    );
    expect(popoverHeader()).toContain('(1)');
    expect(subscribeEntries).toHaveBeenCalledWith(
      'wt',
      'ws',
      expect.any(Function),
    );

    // A run's progress changes (or a new run starts) while the popover is
    // open — the host notifies without the row/popover remounting.
    liveEntries = [entry('a'), entry('b')];
    act(() => {
      notify?.();
    });

    expect(popoverHeader()).toContain('(2)');
    cleanup();
  });
});
