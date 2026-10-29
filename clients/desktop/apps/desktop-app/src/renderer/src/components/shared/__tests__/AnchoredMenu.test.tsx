/** @jest-environment jsdom */
import { act, useRef, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AnchoredMenu, type AnchoredMenuPlacement } from '../AnchoredMenu';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

interface HarnessProps {
  placement: AnchoredMenuPlacement;
  portal?: boolean;
  className?: string;
  onClose?: () => void;
}

function Harness({
  placement,
  portal = false,
  className,
  onClose = (): void => undefined,
}: HarnessProps): JSX.Element {
  const anchorRef = useRef<HTMLButtonElement>(null);
  return (
    <div className="relative">
      <button type="button" ref={anchorRef}>
        Open
      </button>
      <AnchoredMenu
        open
        onClose={onClose}
        anchorRef={anchorRef}
        placement={placement}
        portal={portal}
        className={className}
        testId="anchored-menu"
      >
        <div>Row</div>
      </AnchoredMenu>
    </div>
  );
}

/**
 * Pins the class list the menu surface receives: the shared surface recipe,
 * then the placement this wrapper owns, then the caller's own classes. The
 * placement is written as literal strings so the design-system lint can read
 * it; this guards that the rewrite kept the output identical.
 */
describe('AnchoredMenu surface classes', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function menuClassName(): string | undefined {
    return document.body.querySelector<HTMLElement>(
      '[data-testid="anchored-menu"]',
    )?.className;
  }

  it.each([
    ['below-start', 'absolute left-0 top-full mt-1'],
    ['above-start', 'absolute left-0 bottom-full mb-1'],
    ['right-start', 'absolute left-full top-0 ml-1'],
  ] as const)(
    'positions an in-flow %s menu after the surface recipe',
    (placement, expected) => {
      act(() => {
        root.render(<Harness placement={placement} />);
      });

      expect(menuClassName()).toBe(
        `rounded-lg bg-quaternary outline-none p-1 shadow-xl ${expected}`,
      );
    },
  );

  it('appends the caller placement after its own', () => {
    act(() => {
      root.render(<Harness placement="below-start" className="w-44" />);
    });

    expect(menuClassName()).toBe(
      'rounded-lg bg-quaternary outline-none p-1 shadow-xl absolute left-0 top-full mt-1 w-44',
    );
  });

  it('does not dismiss or swallow a press on a portaled nested menu action', () => {
    const onClose = jest.fn();
    const onSelect = jest.fn();
    act(() =>
      root.render(<Harness placement="below-start" portal onClose={onClose} />),
    );
    const nested = document.createElement('div');
    nested.dataset.floatingMenuNested = 'true';
    const remove = document.createElement('button');
    remove.textContent = 'Remove from group';
    remove.addEventListener('click', onSelect);
    nested.append(remove);
    document.body.append(nested);
    try {
      act(() => {
        remove.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        remove.dispatchEvent(
          new MouseEvent('click', { bubbles: true, cancelable: true }),
        );
      });
      expect(onClose).not.toHaveBeenCalled();
      expect(onSelect).toHaveBeenCalledTimes(1);
      act(() => {
        document.body.dispatchEvent(
          new MouseEvent('mousedown', { bubbles: true }),
        );
      });
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      nested.remove();
    }
  });

  it('layers a portaled menu on the dropdown tier with the caller placement', () => {
    act(() => {
      root.render(
        <Harness
          placement="below-start"
          portal
          className="sidebar-instant-interactions w-36"
        />,
      );
    });

    const tokens = (menuClassName() ?? '').split(/\s+/).filter(Boolean);
    expect(tokens).toEqual([
      'rounded-lg',
      'bg-quaternary',
      'outline-none',
      'p-1',
      'shadow-xl',
      'z-dropdown',
      'sidebar-instant-interactions',
      'w-36',
    ]);
    expect(tokens).not.toContain('absolute');
  });
});
