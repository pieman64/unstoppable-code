/** @jest-environment jsdom */
import { act, useRef, useState, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ComposerPlusMenuPresentation } from '../ComposerPlusMenuPresentation';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

function Harness({
  selected,
  disabled = false,
  omitFirst = false,
}: {
  selected: (id: string) => void;
  disabled?: boolean;
  omitFirst?: boolean;
}): JSX.Element {
  const anchor = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <div ref={anchor}>
      <ComposerPlusMenuPresentation
        isOpen={open}
        setIsOpen={setOpen}
        keyboardNavigation
        disabled={disabled}
        anchorRef={anchor}
        triggerRef={trigger}
        returnFocusRef={trigger}
        dataTestIdPrefix="test"
        menuId="actions"
        capsuleTrigger
        rows={['attachment', 'plugins', 'commands']
          .filter((id) => !omitFirst || id !== 'attachment')
          .map((id) => ({
            id,
            label: id,
            icon: null,
            group: 'Add',
            dataTestId: `action-${id}`,
            onSelect: (): void => {
              setOpen(false);
              selected(id);
            },
          }))}
      />
    </div>
  );
}

describe('controlled composer + presentation', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });
  function plus(): HTMLButtonElement | null {
    return container.querySelector('[data-testid="test-plus-button"]');
  }
  function press(key: string): void {
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key, bubbles: true }),
      );
    });
  }

  it('highlights the first enabled row and activates exactly once by keyboard', () => {
    const selected = jest.fn();
    act(() => root.render(<Harness selected={selected} />));
    act(() => plus()?.click());
    expect(
      document.querySelector('[data-testid="action-attachment"]')?.className,
    ).toContain('bg-subtle');
    press('ArrowDown');
    press('Enter');
    expect(selected).toHaveBeenCalledTimes(1);
    expect(selected).toHaveBeenCalledWith('plugins');
    expect(document.querySelector('[data-testid="test-plus-menu"]')).toBeNull();
    press('Enter');
    expect(selected).toHaveBeenCalledTimes(1);
  });

  it('reselects after the active row disappears, and disabling only closes the menu', async () => {
    const selected = jest.fn();
    act(() => root.render(<Harness selected={selected} />));
    act(() => plus()?.click());
    await act(async () => {
      root.render(<Harness selected={selected} omitFirst />);
      await Promise.resolve();
    });
    expect(
      document.querySelector('[data-testid="action-plugins"]')?.className,
    ).toContain('bg-subtle');
    act(() => root.render(<Harness selected={selected} disabled />));
    expect(document.querySelector('[data-testid="test-plus-menu"]')).toBeNull();
    expect(selected).not.toHaveBeenCalled();
  });

  it('dismisses back to + without invoking an action', () => {
    const selected = jest.fn();
    act(() => root.render(<Harness selected={selected} />));
    act(() => plus()?.click());
    press('Escape');
    expect(document.activeElement).toBe(plus());
    expect(selected).not.toHaveBeenCalled();
  });
});
