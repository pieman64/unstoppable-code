/**
 * @jest-environment jsdom
 */
import { act, useRef, useState, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Popover } from '../Popover';
import { SettingsSelect } from '../SettingsSelect';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = '';
});

function byTestId(id: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  if (!element) throw new Error(`${id} not found`);
  return element;
}

function Harness(): JSX.Element {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        data-testid="trigger"
        onClick={(): void => setOpen(true)}
      >
        Follow up
      </button>
      <button type="button" data-testid="elsewhere">
        Elsewhere
      </button>
      <Popover
        open={open}
        onOpenChange={setOpen}
        anchorRef={anchorRef}
        aria-label="Follow up"
        data-testid="popover"
      >
        <input data-testid="field" aria-label="Message" />
        <button
          type="button"
          data-testid="done"
          onClick={(): void => setOpen(false)}
        >
          Done
        </button>
      </Popover>
    </>
  );
}

function SelectHarness(): JSX.Element {
  const [open, setOpen] = useState(true);
  const [value, setValue] = useState<'day' | 'week'>('day');
  const anchorRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={anchorRef} type="button" data-testid="trigger">
        Filters
      </button>
      <button type="button" data-testid="elsewhere">
        Elsewhere
      </button>
      <Popover
        open={open}
        onOpenChange={setOpen}
        anchorRef={anchorRef}
        aria-label="Filters"
        data-testid="popover"
      >
        <SettingsSelect
          aria-label="Range"
          data-testid="range"
          value={value}
          onValueChange={setValue}
          options={[
            { value: 'day', label: 'Day', testId: 'range-day' },
            { value: 'week', label: 'Week', testId: 'range-week' },
          ]}
        />
      </Popover>
    </>
  );
}

function press(target: Element): void {
  act(() => {
    target.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function openPopover(): void {
  render();
  const trigger = byTestId('trigger');
  act(() => trigger.focus());
  act(() => trigger.click());
}

function render(): void {
  act(() => root.render(<Harness />));
}

function key(target: Element, name: string, shiftKey = false): void {
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: name,
        shiftKey,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
}

describe('Popover', () => {
  it('is a named dialog on the menu surface with the 12px inset', () => {
    openPopover();
    const popover = byTestId('popover');
    expect(popover.getAttribute('role')).toBe('dialog');
    expect(popover.getAttribute('aria-label')).toBe('Follow up');
    expect(popover.className).toContain('bg-quaternary');
    expect(popover.className).toContain('p-3');
    expect(popover.className).toContain('w-72');
    expect(container.contains(popover)).toBe(false);
  });

  it('moves focus in on open and keeps Tab inside', () => {
    openPopover();
    expect(document.activeElement).toBe(byTestId('field'));
    key(byTestId('field'), 'Tab');
    expect(document.activeElement).toBe(byTestId('done'));
    key(byTestId('done'), 'Tab');
    expect(document.activeElement).toBe(byTestId('field'));
  });

  it('closes on Escape and returns focus to the control', () => {
    openPopover();
    key(byTestId('field'), 'Escape');
    expect(document.querySelector('[data-testid="popover"]')).toBeNull();
    expect(document.activeElement).toBe(byTestId('trigger'));
  });

  it('returns focus when it closes itself', () => {
    openPopover();
    act(() => byTestId('done').click());
    expect(document.querySelector('[data-testid="popover"]')).toBeNull();
    expect(document.activeElement).toBe(byTestId('trigger'));
  });

  it('stays open while a choice is pressed in a menu opened from inside it', () => {
    act(() => root.render(<SelectHarness />));
    press(byTestId('range'));
    press(byTestId('range-week'));
    expect(document.querySelector('[data-testid="popover"]')).not.toBeNull();
    expect(byTestId('range').textContent).toContain('Week');
  });

  it('still closes, with the menu opened from inside it, on a press outside both', () => {
    act(() => root.render(<SelectHarness />));
    press(byTestId('range'));
    expect(document.querySelector('[data-testid="range-day"]')).not.toBeNull();
    press(byTestId('elsewhere'));
    expect(document.querySelector('[data-testid="popover"]')).toBeNull();
  });

  it('ignores outside presses, and lets their clicks land, while it may not close', () => {
    const onOpenChange = jest.fn();
    const onElsewhere = jest.fn();
    function BusyHarness(): JSX.Element {
      const anchorRef = useRef<HTMLButtonElement>(null);
      return (
        <>
          <button ref={anchorRef} type="button" data-testid="trigger">
            Profiles
          </button>
          <button type="button" data-testid="elsewhere" onClick={onElsewhere}>
            Leave
          </button>
          <Popover
            open
            onOpenChange={onOpenChange}
            anchorRef={anchorRef}
            closeOnOutsidePress={false}
            aria-label="Profiles"
            data-testid="popover"
          >
            <button type="button">Work</button>
          </Popover>
        </>
      );
    }
    act(() => root.render(<BusyHarness />));
    press(byTestId('elsewhere'));
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onElsewhere).toHaveBeenCalledTimes(1);
  });

  it('scrolls its own content when it is taller than the window allows', () => {
    // The surface gets the room FloatingMenu measures as its max height; a
    // manual surface has no managed scroll viewport, so it scrolls itself.
    openPopover();
    expect(byTestId('popover').className).toContain('overflow-y-auto');
  });

  it('closes on a press outside', () => {
    openPopover();
    act(() => {
      byTestId('elsewhere').dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true }),
      );
      byTestId('elsewhere').dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });
    expect(document.querySelector('[data-testid="popover"]')).toBeNull();
  });

  it('opens at a point and closes on a window resize or blur', () => {
    const onOpenChange = jest.fn();
    act(() =>
      root.render(
        <Popover
          open
          onOpenChange={onOpenChange}
          anchorPoint={{ x: 120, y: 60 }}
          ownerDocument={document}
          aria-label="Comment"
          data-testid="popover"
        >
          <button type="button">Comment</button>
        </Popover>,
      ),
    );
    const popover = byTestId('popover');
    expect(popover.style.left).toBe('120px');
    expect(popover.style.top).toBe('64px');
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    onOpenChange.mockClear();
    act(() => {
      window.dispatchEvent(new Event('blur'));
    });
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });
});
