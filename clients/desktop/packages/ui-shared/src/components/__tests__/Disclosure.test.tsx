/**
 * @jest-environment jsdom
 */
import { act, useState, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Disclosure } from '../Disclosure';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function render(element: JSX.Element): void {
  act(() => root.render(element));
}

function byTestId(id: string): HTMLElement {
  const element = host.querySelector(`[data-testid="${id}"]`);
  if (!(element instanceof HTMLElement)) throw new Error(`No ${id}`);
  return element;
}

function click(element: HTMLElement): void {
  act(() => element.click());
}

describe('Disclosure', () => {
  it('starts closed with no body and opens on click', () => {
    render(
      <Disclosure label="Advanced" dataTestId="adv">
        <p>Body</p>
      </Disclosure>,
    );
    const toggle = byTestId('adv-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.hasAttribute('aria-controls')).toBe(false);
    expect(host.querySelector('[data-testid="adv-body"]')).toBeNull();

    click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const body = byTestId('adv-body');
    expect(toggle.getAttribute('aria-controls')).toBe(body.id);
    expect(body.textContent).toBe('Body');
    expect(byTestId('adv').dataset.state).toBe('open');

    click(toggle);
    expect(host.querySelector('[data-testid="adv-body"]')).toBeNull();
  });

  it('names a non-default choice beside the closed label only', () => {
    render(
      <Disclosure label="Advanced" hint="Private memory on" dataTestId="adv">
        Body
      </Disclosure>,
    );
    const toggle = byTestId('adv-toggle');
    expect(toggle.textContent).toBe('Advanced · Private memory on');
    click(toggle);
    expect(toggle.textContent).toBe('Advanced');
  });

  it('keeps a closed body mounted and hidden when asked', () => {
    render(
      <Disclosure label="Logs" keepMounted dataTestId="logs">
        <input aria-label="Filter" defaultValue="kept" />
      </Disclosure>,
    );
    const body = byTestId('logs-body');
    expect(body.hidden).toBe(true);
    // A display class would beat `hidden`, so the closed body has none.
    expect(body.className).toBe('');
    click(byTestId('logs-toggle'));
    expect(body.hidden).toBe(false);
  });

  it('follows a controlled open state and reports toggles', () => {
    const changes: boolean[] = [];
    function Host(): JSX.Element {
      const [open, setOpen] = useState(true);
      return (
        <Disclosure
          label="Completed (2)"
          open={open}
          onOpenChange={(next) => {
            changes.push(next);
            setOpen(next);
          }}
          toggleTestId="completed-toggle"
        >
          Runs
        </Disclosure>
      );
    }
    render(<Host />);
    const toggle = byTestId('completed-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    click(toggle);
    expect(changes).toEqual([false]);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('puts a box section title and its meta in one row', () => {
    render(
      <Disclosure
        variant="box"
        label="Retrieved context"
        meta="3 sources"
        dataTestId="ctx"
      >
        Sources
      </Disclosure>,
    );
    const toggle = byTestId('ctx-toggle');
    expect(toggle.textContent).toBe('Retrieved context3 sources');
    expect(toggle.className).toContain('w-full');
    // The box's chevron ends the row, after the meta (design call 2B).
    expect(toggle.lastElementChild?.querySelector('svg')).not.toBeNull();
  });

  it('leads an inline label with its chevron', () => {
    render(
      <Disclosure label="Advanced" dataTestId="adv">
        Body
      </Disclosure>,
    );
    const slot = byTestId('adv-toggle').firstElementChild;
    expect(slot?.querySelector('svg')).not.toBeNull();
    // A 16px slot, so the chevron centers in the same column as a 16px icon
    // above it (the action card's Dispatch glyph over Hidden runs).
    expect(slot?.className).toContain('size-4');
  });
});
