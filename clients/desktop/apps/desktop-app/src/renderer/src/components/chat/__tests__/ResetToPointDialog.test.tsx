/** @jest-environment jsdom */

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ResetToPointDialog } from '../ResetToPointDialog';

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

function render(onConfirm: () => Promise<void> | void): jest.Mock {
  const onCancel = jest.fn();
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <ResetToPointDialog onConfirm={onConfirm} onCancel={onCancel} />,
    );
  });
  return onCancel;
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.startsWith(label),
  );
  if (!match) throw new Error(`No ${label} button`);
  return match;
}

function press(key: string, init: KeyboardEventInit = {}): void {
  act(() => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key,
        bubbles: true,
        cancelable: true,
        ...init,
      }),
    );
  });
}

describe('ResetToPointDialog', () => {
  it('cancels from the button and from Escape', () => {
    const onCancel = render(jest.fn());

    act(() => button('Cancel').click());
    expect(onCancel).toHaveBeenCalledTimes(1);

    press('Escape');
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it('confirms once from the button and ignores Mod+Enter while reverting', async () => {
    let finish: () => void = () => undefined;
    const onConfirm = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const onCancel = render(onConfirm);

    act(() => button('Revert turn').click());
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(button('Reverting…').disabled).toBe(true);

    press('Enter', { metaKey: true });
    press('Escape');
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();

    await act(async () => {
      finish();
      await Promise.resolve();
    });
  });

  it('confirms from Mod+Enter and shows a failed revert', async () => {
    const onConfirm = jest.fn(() => Promise.reject(new Error('Dirty tree')));
    render(onConfirm);

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true }),
      );
      await Promise.resolve();
    });

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain('Dirty tree');
    expect(button('Revert turn').disabled).toBe(false);
  });
});
