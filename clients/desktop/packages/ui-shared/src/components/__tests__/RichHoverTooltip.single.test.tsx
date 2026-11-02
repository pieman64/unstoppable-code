/**
 * @jest-environment jsdom
 *
 * Row preview cards (interactive rich tooltips with an open delay) must
 * never stack: moving from one row's card back across the rows to the next
 * row leaves only the next row's card open, and under `single` stacking a
 * card that opens closes any other, even one whose leave was never seen.
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RichHoverTooltip } from '../RichHoverTooltip';
import { Tooltip } from '../Tooltip';
import { TooltipProvider, type TooltipStacking } from '../tooltip-handoff';

/** Moves the pointer from `from` to `to` the way a browser reports it. */
function movePointer(from: Element | null, to: Element | null): void {
  act(() => {
    if (from) {
      from.dispatchEvent(
        new MouseEvent('mouseout', { bubbles: true, relatedTarget: to }),
      );
    }
    if (to) {
      to.dispatchEvent(
        new MouseEvent('mouseover', { bubbles: true, relatedTarget: from }),
      );
    }
  });
}

function advance(ms: number): void {
  act(() => {
    jest.advanceTimersByTime(ms);
  });
}

function openCards(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('[role="tooltip"]'),
  ).map((card) => card.textContent ?? '');
}

describe.each([false, true])('rich row cards (deferred=%s)', (deferred) => {
  let container: HTMLDivElement;
  let root: Root;

  const render = (stacking: TooltipStacking): void => {
    act(() => {
      root.render(
        <TooltipProvider stacking={stacking}>
          <div data-testid="rail">
            {['Greeting', 'New Task'].map((title) => (
              <RichHoverTooltip
                key={title}
                deferUntilInteraction={deferred}
                content={<span>{`${title} card`}</span>}
                openDelay={500}
                interactive
                openOnTriggerKey={false}
              >
                <div data-row={title}>{title}</div>
              </RichHoverTooltip>
            ))}
            <Tooltip label="Pin">
              <button type="button" data-row="pin">
                Pin
              </button>
            </Tooltip>
            <RichHoverTooltip
              content={<span>Inbox card</span>}
              openDelay={500}
              interactive
              openOnTriggerKey={false}
            >
              <div data-row="Inbox">
                Inbox
                <Tooltip label="Archive">
                  <button type="button" data-row="archive">
                    Archive
                  </button>
                </Tooltip>
              </div>
            </RichHoverTooltip>
          </div>
        </TooltipProvider>,
      );
    });
  };

  beforeEach(() => {
    jest.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    render('stack');
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    jest.useRealTimers();
  });

  const present = (node: Element | null | undefined, what: string): Element => {
    if (!node) throw new Error(`${what} is not rendered`);
    return node;
  };
  const row = (title: string): Element =>
    present(container.querySelector(`[data-row="${title}"]`), title);
  const card = (title: string): Element =>
    present(
      Array.from(document.querySelectorAll('[role="tooltip"]')).find(
        (node) => node.textContent === `${title} card`,
      ),
      `${title} card`,
    );

  it('closes a card the pointer visited once the pointer moves on', () => {
    const rail = container.querySelector('[data-testid="rail"]');
    movePointer(rail, row('Greeting'));
    advance(600);
    expect(openCards()).toEqual(['Greeting card']);

    // Onto the card, back across its row, then down to the next row.
    movePointer(row('Greeting'), card('Greeting'));
    advance(100);
    movePointer(card('Greeting'), row('Greeting'));
    advance(50);
    movePointer(row('Greeting'), row('New Task'));
    advance(1000);

    expect(openCards()).toEqual(['New Task card']);
  });

  it('keeps only the newest card open under single stacking', () => {
    render('single');
    const rail = container.querySelector('[data-testid="rail"]');
    movePointer(rail, row('Greeting'));
    advance(600);
    // A leave the browser never reported: the pointer shows up on the next
    // row while the first card still believes it is hovered.
    movePointer(null, row('New Task'));
    advance(600);
    expect(openCards()).toEqual(['New Task card']);

    // A control's tooltip replaces the card too.
    movePointer(null, row('pin'));
    advance(10);
    expect(openCards()).toEqual(['Pin']);
  });

  it("keeps a row's card open beside the tooltip of a control in that row", () => {
    render('single');
    const rail = container.querySelector('[data-testid="rail"]');
    movePointer(rail, row('Inbox'));
    advance(600);
    expect(openCards()).toEqual(['Inbox card']);

    movePointer(row('Inbox'), row('archive'));
    advance(10);
    expect(openCards().sort()).toEqual(['Archive', 'Inbox card']);

    // A tooltip outside the row still replaces both.
    movePointer(row('archive'), row('pin'));
    advance(10);
    expect(openCards()).toEqual(['Pin']);
  });

  it("opens a row's card around a control tooltip that is already open", () => {
    render('single');
    movePointer(null, row('archive'));
    advance(10);
    expect(openCards()).toEqual(['Archive']);
    advance(600);
    expect(openCards().sort()).toEqual(['Archive', 'Inbox card']);
  });

  it('lets cards stack without single stacking', () => {
    const rail = container.querySelector('[data-testid="rail"]');
    movePointer(rail, row('Greeting'));
    advance(600);
    movePointer(null, row('New Task'));
    advance(600);
    expect(openCards().sort()).toEqual(['Greeting card', 'New Task card']);
  });
});
