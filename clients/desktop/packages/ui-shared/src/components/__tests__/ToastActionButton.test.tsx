/** @jest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  SUCCESS_TOAST_LIFETIME_MS,
  toastStackLifetimeMs,
} from '../../lib/toast-lifetime';
import { ToastActionButton } from '../ToastStack';
import { TRY_AGAIN_LABEL, TRYING_AGAIN_LABEL } from '../useRetry';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

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

function button(): HTMLButtonElement {
  const element = container.querySelector('button');
  if (!(element instanceof HTMLButtonElement)) throw new Error('no button');
  return element;
}

describe('ToastActionButton', () => {
  it('runs a quick action, then closes the toast, without reaching the card', () => {
    const run = jest.fn();
    const onDone = jest.fn();
    const onCardClick = jest.fn();
    act(() =>
      root.render(
        // Stands in for the activatable card around the toast's buttons.
        <div onClick={onCardClick}>
          <ToastActionButton label="Review" run={run} onDone={onDone} />
        </div>,
      ),
    );
    act(() => button().click());
    expect(run).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onCardClick).not.toHaveBeenCalled();
  });

  it('spins Try again inside the capsule until the retry settles, then closes', async () => {
    let finish: () => void = () => undefined;
    const retry = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const run = jest.fn(() => retry);
    const onDone = jest.fn();
    act(() =>
      root.render(
        <ToastActionButton
          label={TRY_AGAIN_LABEL}
          busyLabel={TRYING_AGAIN_LABEL}
          run={run}
          onDone={onDone}
        />,
      ),
    );
    act(() => button().click());
    expect(button().textContent).toBe(TRYING_AGAIN_LABEL);
    expect(button().getAttribute('aria-busy')).toBe('true');
    expect(onDone).not.toHaveBeenCalled();
    act(() => button().click());
    expect(run).toHaveBeenCalledTimes(1);

    await act(async () => {
      finish();
      await retry;
    });
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(button().textContent).toBe(TRY_AGAIN_LABEL);
  });

  it('shares one busy state between buttons for the same action, such as a card and its dialog', async () => {
    let finish: () => void = () => undefined;
    const retry = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const run = jest.fn(() => retry);
    const onDone = jest.fn();
    act(() =>
      root.render(
        <>
          <ToastActionButton
            data-testid="card"
            label={TRY_AGAIN_LABEL}
            busyLabel={TRYING_AGAIN_LABEL}
            actionKey="toast-7"
            run={run}
            onDone={onDone}
          />
          <ToastActionButton
            data-testid="dialog"
            label={TRY_AGAIN_LABEL}
            busyLabel={TRYING_AGAIN_LABEL}
            actionKey="toast-7"
            run={run}
            onDone={onDone}
          />
        </>,
      ),
    );
    const byTestId = (id: string): HTMLButtonElement => {
      const element = container.querySelector(`[data-testid="${id}"]`);
      if (!(element instanceof HTMLButtonElement)) throw new Error(id);
      return element;
    };
    act(() => byTestId('dialog').click());
    // The card's button spins too and does not start the action again.
    expect(byTestId('card').textContent).toBe(TRYING_AGAIN_LABEL);
    expect(byTestId('card').disabled).toBe(true);
    act(() => byTestId('card').click());
    expect(run).toHaveBeenCalledTimes(1);

    await act(async () => {
      finish();
      await retry;
    });
    expect(byTestId('card').textContent).toBe(TRY_AGAIN_LABEL);
    expect(byTestId('card').disabled).toBe(false);
  });

  it('closes the toast after a failed retry too; the failure raises its own toast', async () => {
    const retry = Promise.reject(new Error('still offline'));
    retry.catch(() => undefined);
    const onDone = jest.fn();
    act(() =>
      root.render(
        <ToastActionButton
          label={TRY_AGAIN_LABEL}
          run={() => retry}
          onDone={onDone}
        />,
      ),
    );
    await act(async () => {
      button().click();
      await retry.catch(() => undefined);
    });
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});

describe('toastStackLifetimeMs', () => {
  it('keeps a failure until it is closed, even with a hold', () => {
    expect(toastStackLifetimeMs('destructive', 15_000)).toBe(0);
    expect(toastStackLifetimeMs('destructive', 15_000, 60_000)).toBe(0);
  });

  it('lets a success leave after 6 seconds unless the host holds it', () => {
    expect(SUCCESS_TOAST_LIFETIME_MS).toBe(6_000);
    expect(toastStackLifetimeMs('positive', 15_000)).toBe(6_000);
    expect(toastStackLifetimeMs('positive', 15_000, 60_000)).toBe(60_000);
  });

  it("keeps the host's lifetime for everything else", () => {
    expect(toastStackLifetimeMs('neutral', 15_000)).toBe(15_000);
    expect(toastStackLifetimeMs('attention', 8_000)).toBe(8_000);
  });
});
