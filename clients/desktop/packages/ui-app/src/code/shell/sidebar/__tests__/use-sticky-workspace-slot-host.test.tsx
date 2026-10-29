/** @jest-environment jsdom */

import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useStickyWorkspaceSlotHost } from '../use-sticky-workspace-slot-host';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let resolved: HTMLElement | null | undefined;

function Probe({
  anchor,
  workspaceId,
}: {
  readonly anchor: HTMLElement | null;
  readonly workspaceId: string;
}): JSX.Element | null {
  resolved = useStickyWorkspaceSlotHost(anchor, workspaceId);
  return null;
}

describe('useStickyWorkspaceSlotHost', () => {
  let rail: HTMLElement;
  let slot: HTMLElement;
  let anchor: HTMLElement;
  let root: Root;
  let mount: HTMLElement;

  beforeEach(() => {
    resolved = undefined;
    rail = document.createElement('div');
    rail.setAttribute('data-testid', 'app-sidebar');
    slot = document.createElement('div');
    slot.setAttribute('data-sidebar-sticky-workspace-slot', '');
    anchor = document.createElement('div');
    rail.append(slot, anchor);
    document.body.appendChild(rail);
    mount = document.createElement('div');
    document.body.appendChild(mount);
    root = createRoot(mount);
  });

  afterEach(() => {
    act(() => root.unmount());
    rail.remove();
    mount.remove();
  });

  const seat = (workspaceId: string): HTMLElement => {
    const row = document.createElement('div');
    row.setAttribute('data-sidebar-sticky-slot-workspace-id', workspaceId);
    return row;
  };

  it('resolves a seat that already exists', () => {
    const row = seat('ws-1');
    slot.appendChild(row);
    act(() => root.render(<Probe anchor={anchor} workspaceId="ws-1" />));
    expect(resolved).toBe(row);
  });

  // The shared surface seats its rows a commit after the workspace rows
  // mount, so a miss on mount must not be final.
  it('resolves a seat the rail adds after the row mounted', async () => {
    act(() => root.render(<Probe anchor={anchor} workspaceId="ws-1" />));
    expect(resolved).toBeNull();
    const row = seat('ws-1');
    await act(async () => {
      slot.appendChild(row);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(resolved).toBe(row);
    // Another workspace's seat is not this row's.
    act(() => root.render(<Probe anchor={anchor} workspaceId="ws-2" />));
    expect(resolved).toBeNull();
  });
  // A host without the desktop rail (the web portal) can never seat a row, so
  // it must not leave a document-wide observer running for every workspace.
  it('installs no observer outside the desktop rail', () => {
    const observe = jest.spyOn(MutationObserver.prototype, 'observe');
    const loose = document.createElement('div');
    document.body.appendChild(loose);
    try {
      act(() => root.render(<Probe anchor={loose} workspaceId="ws-1" />));
      expect(resolved).toBeNull();
      expect(observe).not.toHaveBeenCalled();
    } finally {
      observe.mockRestore();
      loose.remove();
    }
  });

  it('watches the sticky band rather than the whole rail', () => {
    const observe = jest.spyOn(MutationObserver.prototype, 'observe');
    try {
      act(() => root.render(<Probe anchor={anchor} workspaceId="ws-1" />));
      expect(observe).toHaveBeenCalledTimes(1);
      expect(observe.mock.calls[0]?.[0]).toBe(slot);
    } finally {
      observe.mockRestore();
    }
  });
});
