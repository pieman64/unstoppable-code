/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useSuspendSidebarHovers } from '../useSuspendSidebarHovers';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

function Harness({ open }: { open: boolean }): JSX.Element | null {
  useSuspendSidebarHovers(open);
  return null;
}

describe('useSuspendSidebarHovers', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    delete document.body.dataset.sidebarMenuOpen;
  });

  it('sets and clears the body flag, reference-counted across menus', () => {
    act(() =>
      root.render(
        <>
          <Harness open />
          <Harness open />
        </>,
      ),
    );
    expect(document.body.dataset.sidebarMenuOpen).toBe('true');

    // One menu closes — the other keeps the flag.
    act(() =>
      root.render(
        <>
          <Harness open />
          <Harness open={false} />
        </>,
      ),
    );
    expect(document.body.dataset.sidebarMenuOpen).toBe('true');

    // Last menu closes — flag clears.
    act(() =>
      root.render(
        <>
          <Harness open={false} />
          <Harness open={false} />
        </>,
      ),
    );
    expect(document.body.dataset.sidebarMenuOpen).toBeUndefined();
  });
});
