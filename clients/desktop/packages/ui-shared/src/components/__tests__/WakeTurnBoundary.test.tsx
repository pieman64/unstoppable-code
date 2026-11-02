/** @jest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { WakeTurnBoundary } from '../WakeTurnBoundary';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('WakeTurnBoundary', () => {
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

  function row(): HTMLElement | null {
    return container.querySelector('[data-testid="wake-turn-boundary"]');
  }

  function link(): HTMLButtonElement | null {
    return container.querySelector(
      '[data-testid="wake-turn-boundary-show-spawning-turn"]',
    );
  }

  it('names the finished task and links to the turn that started it', () => {
    const onShowSpawningTurn = jest.fn();
    act(() =>
      root.render(
        <WakeTurnBoundary
          taskLabel="Run the tests"
          onShowSpawningTurn={onShowSpawningTurn}
        />,
      ),
    );

    // The link is an icon-only button named by its label and tooltip.
    expect(row()?.textContent).toBe('Continued after Run the tests finished');
    expect(link()?.getAttribute('aria-label')).toBe('Show where it started');
    expect(link()?.querySelector('svg')).not.toBeNull();
    act(() => link()?.click());
    expect(onShowSpawningTurn).toHaveBeenCalledTimes(1);
  });

  it("shows the link's tooltip on focus", () => {
    act(() => root.render(<WakeTurnBoundary onShowSpawningTurn={jest.fn()} />));
    // Tab traversal: a keydown reaches the document before focus moves.
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }),
      );
      link()?.focus();
    });

    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe(
      'Show where it started',
    );
  });

  it('falls back to generic copy, with no link when the turn is out of view', () => {
    act(() => root.render(<WakeTurnBoundary />));

    expect(row()?.textContent).toBe('Continued after background work finished');
    expect(link()).toBeNull();
  });

  it('names the scheduled prompt a cron fire ran, or says one ran', () => {
    act(() =>
      root.render(<WakeTurnBoundary taskLabel="Check the deploy" scheduled />),
    );
    expect(row()?.textContent).toBe(
      'Continued for the scheduled prompt Check the deploy',
    );
    expect(row()?.querySelector('strong')?.textContent).toBe(
      'Check the deploy',
    );
    act(() => root.render(<WakeTurnBoundary scheduled />));
    expect(row()?.textContent).toBe('Continued for a scheduled prompt');
  });

  it('says the agent continued after loading tools, linking to the load', () => {
    const onShowSpawningTurn = jest.fn();
    act(() =>
      root.render(
        <WakeTurnBoundary
          toolsLoaded
          onShowSpawningTurn={onShowSpawningTurn}
        />,
      ),
    );
    expect(row()?.textContent).toBe('Continued after loading tools');
    act(() => link()?.click());
    expect(onShowSpawningTurn).toHaveBeenCalledTimes(1);
  });

  it('names the task that reported an event, which keeps running', () => {
    act(() =>
      root.render(<WakeTurnBoundary taskLabel="build log errors" event />),
    );

    expect(row()?.textContent).toBe(
      'Continued after an event from build log errors',
    );
    expect(row()?.querySelector('strong')?.textContent).toBe(
      'build log errors',
    );
  });

  it('falls back to generic event copy when the task is unnamed', () => {
    act(() => root.render(<WakeTurnBoundary event />));

    expect(row()?.textContent).toBe('Continued after a background event');
  });
});
