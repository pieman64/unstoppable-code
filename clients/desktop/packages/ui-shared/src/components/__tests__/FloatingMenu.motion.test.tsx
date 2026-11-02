/** @jest-environment jsdom */

import { act, useRef, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DropdownMenuItem } from '../DropdownMenu';
import { FloatingMenu, type FloatingMenuProps } from '../FloatingMenu';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type HarnessProps = Partial<
  Pick<
    FloatingMenuProps,
    'motion' | 'padding' | 'shell' | 'placement' | 'style'
  >
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
    jest.restoreAllMocks();
  });

  function menu(): HTMLElement | null {
    return document.querySelector<HTMLElement>('[data-testid="menu"]');
  }

  it.each(['border-box', 'content-box'] as const)(
    'aligns a fractional-width %s menu during its scale animation',
    (boxSizing) => {
      jest
        .spyOn(HTMLElement.prototype, 'offsetWidth', 'get')
        .mockReturnValue(127);
      jest
        .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
        .mockImplementation(function (this: HTMLElement) {
          return this.tagName === 'BUTTON'
            ? new DOMRect(300, 300, 40, 40)
            : new DOMRect(0, 0, 127.0625 * 0.97, 80 * 0.97);
        });

      act(() =>
        root.render(
          <Harness
            placement="bottom-right"
            style={{
              width: boxSizing === 'border-box' ? '127.0625px' : '120.0625px',
              boxSizing,
              padding: '3px',
              border: '0.5px solid',
            }}
          />,
        ),
      );

      expect(menu()?.style.left).toBe('212.9375px');
    },
  );

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
