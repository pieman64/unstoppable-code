/** @jest-environment jsdom */

import { act, useRef, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DropdownMenuItem } from '../DropdownMenu';
import { FloatingMenu, type FloatingMenuProps } from '../FloatingMenu';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type HarnessProps = Partial<
  Pick<FloatingMenuProps, 'motion' | 'padding' | 'shell'>
>;

function Harness(props: HarnessProps): JSX.Element {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  return (
    <>
      <button ref={triggerRef} type="button">
        Actions
      </button>
      <FloatingMenu
        {...props}
        open
        onOpenChange={jest.fn()}
        anchorRef={triggerRef}
        aria-label="Actions"
        data-testid="menu"
      >
        <DropdownMenuItem>First</DropdownMenuItem>
      </FloatingMenu>
    </>
  );
}

describe('FloatingMenu motion and padding', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
  });

  function menu(): HTMLElement | null {
    return document.querySelector<HTMLElement>('[data-testid="menu"]');
  }

  it('animates in by default', () => {
    act(() => root.render(<Harness />));

    expect(menu()?.classList).toContain('canopy-floating-menu');
    expect(menu()?.classList).not.toContain('canopy-floating-menu-no-motion');
  });

  it('appears immediately for a high-frequency surface such as a context menu', () => {
    act(() => root.render(<Harness motion="none" />));

    expect(menu()?.classList).toContain('canopy-floating-menu-no-motion');
  });

  it('passes the surface padding through to the dropdown surface', () => {
    act(() => root.render(<Harness padding="content" />));

    expect(menu()?.classList).toContain('p-4');
    expect(menu()?.classList).not.toContain('p-1');
  });

  it('takes the picker anatomy as a shell', () => {
    act(() => root.render(<Harness shell="picker" />));

    expect(menu()?.classList).toContain('canopy-picker-menu');
    expect(menu()?.classList).toContain('canopy-floating-menu');

    act(() => root.render(<Harness />));

    expect(menu()?.classList).not.toContain('canopy-picker-menu');
  });
});
