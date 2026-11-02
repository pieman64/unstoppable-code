/** @jest-environment jsdom */

import { act, useState, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NoticeButton } from '../Notice';
import { ErrorBanner, ErrorState } from '../StatusBlocks';
import { TRY_AGAIN_LABEL, TRYING_AGAIN_LABEL, useRetry } from '../useRetry';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

function deferred(): Deferred {
  let resolve: () => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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
});

function render(node: JSX.Element): void {
  act(() => root.render(node));
}

function onlyButton(): HTMLButtonElement {
  const buttons = container.querySelectorAll('button');
  const [first] = Array.from(buttons);
  if (buttons.length !== 1 || !(first instanceof HTMLButtonElement)) {
    throw new Error(`expected one button, found ${String(buttons.length)}`);
  }
  return first;
}

describe('ErrorState', () => {
  it('shows the quiet glyph with no tile, one sentence, and one Try again capsule', () => {
    const onRetry = jest.fn();
    render(
      <ErrorState
        testId="failed"
        message="Couldn't load workflows."
        onRetry={onRetry}
      />,
    );
    const state = container.querySelector('[data-testid="failed"]');
    expect(state).toBeInstanceOf(HTMLElement);
    const glyph = state?.querySelector('svg');
    expect(glyph).toBeInstanceOf(SVGElement);
    expect(glyph?.getAttribute('class')).toContain('fg-tertiary');
    // The glyph sits on its own: no tile or tinted box behind it.
    expect(glyph?.parentElement?.className ?? '').not.toMatch(/\bbg-/);
    expect(glyph?.parentElement?.className ?? '').not.toMatch(/rounded/);
    expect(state?.querySelector('[role="alert"]')?.textContent).toBe(
      "Couldn't load workflows.",
    );
    const retry = onlyButton();
    expect(retry.textContent).toBe(TRY_AGAIN_LABEL);
    expect(retry.className).toContain('rounded-full');
    act(() => retry.click());
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('spins inside the capsule while retrying instead of blanking', () => {
    render(
      <ErrorState
        message="Couldn't load the Feed."
        onRetry={jest.fn()}
        retrying
      />,
    );
    const retry = onlyButton();
    expect(retry.textContent).toBe(TRYING_AGAIN_LABEL);
    expect(retry.getAttribute('aria-busy')).toBe('true');
    expect(retry.disabled).toBe(true);
    expect(container.textContent).toContain("Couldn't load the Feed.");
  });

  it('does not repeat Try again in the sentence beside its button', () => {
    render(
      <ErrorState
        testId="failed"
        message="Couldn't load this. Try again."
        onRetry={jest.fn()}
      />,
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Couldn't load this.",
    );
  });

  it('offers no button when trying again cannot help', () => {
    render(<ErrorState message="You can't read this Feed." />);
    expect(container.querySelector('button')).toBeNull();
  });
});

describe('ErrorBanner retry', () => {
  it('spins its Try again in place while the retry runs', () => {
    render(
      <ErrorBanner
        error="Couldn't load shared workflows. Yours are listed."
        onRetry={jest.fn()}
        retryLabel={TRY_AGAIN_LABEL}
        retrying
      />,
    );
    const retry = onlyButton();
    expect(retry.textContent).toBe(TRYING_AGAIN_LABEL);
    expect(retry.getAttribute('aria-busy')).toBe('true');
    expect(container.textContent).toContain('Yours are listed.');
  });
});

describe('NoticeButton busy', () => {
  it('keeps the label without a busy label and stops taking presses', () => {
    const onClick = jest.fn();
    render(
      <NoticeButton busy onClick={onClick}>
        Rescan
      </NoticeButton>,
    );
    const button = onlyButton();
    expect(button.textContent).toBe('Rescan');
    expect(button.disabled).toBe(true);
    act(() => button.click());
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe('useRetry', () => {
  function Harness({ run }: { readonly run: () => unknown }): JSX.Element {
    const { retrying, retry } = useRetry(run);
    const [presses, setPresses] = useState(0);
    return (
      <button
        type="button"
        data-retrying={String(retrying)}
        onClick={() => {
          setPresses(presses + 1);
          retry();
        }}
      >
        {presses}
      </button>
    );
  }

  it('reports the retry until it settles', async () => {
    const pending = deferred();
    const run = jest.fn(() => pending.promise);
    render(<Harness run={run} />);
    const button = onlyButton();
    act(() => button.click());
    expect(button.dataset.retrying).toBe('true');

    await act(async () => {
      pending.resolve();
      await pending.promise;
    });
    expect(button.dataset.retrying).toBe('false');
  });

  it('lets a newer retry take over, so an older one settling late does not end it', async () => {
    const first = deferred();
    const second = deferred();
    const run = jest
      .fn<Promise<void>, []>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    render(<Harness run={run} />);
    const button = onlyButton();
    act(() => button.click());
    act(() => button.click());
    expect(run).toHaveBeenCalledTimes(2);

    await act(async () => {
      first.resolve();
      await first.promise;
    });
    expect(button.dataset.retrying).toBe('true');

    await act(async () => {
      second.resolve();
      await second.promise;
    });
    expect(button.dataset.retrying).toBe('false');
  });

  it('ends the spinner when the retry fails, leaving the failure to the host', async () => {
    const pending = deferred();
    render(<Harness run={() => pending.promise} />);
    const button = onlyButton();
    act(() => button.click());
    await act(async () => {
      pending.reject(new Error('still offline'));
      await pending.promise.catch(() => undefined);
    });
    expect(button.dataset.retrying).toBe('false');
  });

  it('does not spin for a retry that finishes at once', () => {
    const run = jest.fn();
    render(<Harness run={run} />);
    const button = onlyButton();
    act(() => button.click());
    expect(run).toHaveBeenCalledTimes(1);
    expect(button.dataset.retrying).toBe('false');
  });
});
