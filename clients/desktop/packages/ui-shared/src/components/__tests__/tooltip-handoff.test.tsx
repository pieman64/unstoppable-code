/**
 * @jest-environment jsdom
 *
 * Hover handoff between neighbouring tooltips: the first hover waits for the
 * host's delay, a neighbour then opens at once in place of the previous one,
 * a tooltip stays briefly after the pointer leaves, and re-entering soon
 * after it closes opens at once.
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RichHoverTooltip } from '../RichHoverTooltip';
import { Tooltip } from '../Tooltip';
import {
  HOST_TOOLTIP_TIMINGS,
  TOOLTIP_WARM_MS,
  TooltipProvider,
} from '../tooltip-handoff';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const { openDelay: OPEN_DELAY, closeDelay: CLOSE_DELAY } = HOST_TOOLTIP_TIMINGS;

function Toolbar(): JSX.Element {
  return (
    <TooltipProvider {...HOST_TOOLTIP_TIMINGS}>
      <Tooltip label="Back">
        <button type="button">back</button>
      </Tooltip>
      <Tooltip label="Forward">
        <button type="button">forward</button>
      </Tooltip>
      <RichHoverTooltip content="Dev servers">
        <button type="button">servers</button>
      </RichHoverTooltip>
    </TooltipProvider>
  );
}

function tooltips(): string[] {
  return Array.from(
    document.body.querySelectorAll<HTMLElement>('[role="tooltip"]'),
    (node) => node.textContent ?? '',
  );
}

describe('tooltip handoff', () => {
  let container: HTMLDivElement;
  let root: Root;
  let buttons: Record<'back' | 'forward' | 'servers', HTMLButtonElement>;
  let pointerOn: HTMLElement | null;

  function moveTo(next: HTMLElement | null): void {
    const previous = pointerOn;
    act(() => {
      previous?.dispatchEvent(
        new MouseEvent('mouseout', { bubbles: true, relatedTarget: next }),
      );
      next?.dispatchEvent(
        new MouseEvent('mouseover', { bubbles: true, relatedTarget: previous }),
      );
    });
    pointerOn = next;
  }

  let coldClock = 0;

  const wait = (ms: number): void => {
    act(() => jest.advanceTimersByTime(ms));
  };

  beforeEach(() => {
    jest.useFakeTimers();
    // Each install restarts the fake clock at real time, but the window's
    // last close survives from earlier tests; start every test well past it.
    coldClock += TOOLTIP_WARM_MS * 100;
    jest.setSystemTime(Date.now() + coldClock);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(<Toolbar />));
    const [back, forward, servers] = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    );
    if (!back || !forward || !servers) throw new Error('Buttons not found');
    buttons = { back, forward, servers };
    pointerOn = null;
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = '';
    jest.useRealTimers();
  });

  it('waits for the first hover, then switches to a neighbour at once', () => {
    moveTo(buttons.back);
    wait(OPEN_DELAY - 1);
    expect(tooltips()).toEqual([]);
    wait(1);
    expect(tooltips()).toEqual(['Back']);

    moveTo(buttons.forward);
    expect(tooltips()).toEqual(['Forward']);

    moveTo(buttons.servers);
    expect(tooltips()).toEqual(['Dev servers']);
  });

  it('stays briefly after the pointer leaves the row', () => {
    moveTo(buttons.back);
    wait(OPEN_DELAY);
    moveTo(null);
    wait(CLOSE_DELAY - 1);
    expect(tooltips()).toEqual(['Back']);
    wait(1);
    expect(tooltips()).toEqual([]);
  });

  it('opens at once when the pointer comes back soon after it closed', () => {
    moveTo(buttons.back);
    wait(OPEN_DELAY);
    moveTo(null);
    wait(CLOSE_DELAY);
    expect(tooltips()).toEqual([]);

    moveTo(buttons.forward);
    expect(tooltips()).toEqual(['Forward']);
  });

  it('waits again once the window has cooled down', () => {
    moveTo(buttons.back);
    wait(OPEN_DELAY);
    moveTo(null);
    wait(CLOSE_DELAY);
    wait(TOOLTIP_WARM_MS);

    moveTo(buttons.forward);
    expect(tooltips()).toEqual([]);
    wait(OPEN_DELAY);
    expect(tooltips()).toEqual(['Forward']);
  });

  it('cancels a pending first open when the pointer passes over', () => {
    moveTo(buttons.back);
    wait(OPEN_DELAY / 2);
    // Still waiting: the test only means something if the open is pending.
    expect(tooltips()).toEqual([]);
    moveTo(null);
    wait(OPEN_DELAY * 2);
    expect(tooltips()).toEqual([]);
  });

  describe('motion', () => {
    let animate: jest.Mock;

    beforeEach(() => {
      // jsdom has no Web Animations; give surfaces one to call.
      animate = jest.fn();
      Object.defineProperty(HTMLElement.prototype, 'animate', {
        configurable: true,
        value: animate,
      });
      // Each surface measures further right, so a handoff has distance to
      // cover.
      let calls = 0;
      jest
        .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
        .mockImplementation(() => {
          calls += 1;
          return new DOMRect(calls * 40, 10, 30, 20);
        });
    });

    afterEach(() => {
      jest.restoreAllMocks();
      Reflect.deleteProperty(HTMLElement.prototype, 'animate');
    });

    function handOff(): void {
      moveTo(buttons.back);
      wait(OPEN_DELAY);
      moveTo(buttons.forward);
      moveTo(buttons.servers);
    }

    it('jumps between button tooltips with no motion', () => {
      handOff();
      expect(tooltips()).toEqual(['Dev servers']);
      expect(animate).not.toHaveBeenCalled();
    });

    it('slides a hover card that opts in', () => {
      act(() =>
        root.render(
          <TooltipProvider {...HOST_TOOLTIP_TIMINGS}>
            <Tooltip label="Back">
              <button type="button">back</button>
            </Tooltip>
            <Tooltip label="Forward">
              <button type="button">forward</button>
            </Tooltip>
            <RichHoverTooltip content="Dev servers" handoffMotion="slide">
              <button type="button">servers</button>
            </RichHoverTooltip>
          </TooltipProvider>,
        ),
      );
      const [back, forward, servers] = Array.from(
        container.querySelectorAll<HTMLButtonElement>('button'),
      );
      if (!back || !forward || !servers) throw new Error('Buttons not found');
      buttons = { back, forward, servers };
      handOff();
      expect(tooltips()).toEqual(['Dev servers']);
      expect(animate).toHaveBeenCalledTimes(1);
    });
  });
});
