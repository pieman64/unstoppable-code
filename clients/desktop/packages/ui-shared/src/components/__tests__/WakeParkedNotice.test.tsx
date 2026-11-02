/** @jest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { WakeParkedNotice, type WakeParkedReason } from '../WakeParkedNotice';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('WakeParkedNotice', () => {
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

  function render(
    reason: WakeParkedReason,
    onContinue?: () => Promise<void>,
  ): void {
    act(() =>
      root.render(
        <WakeParkedNotice
          reason={reason}
          {...(onContinue === undefined ? {} : { onContinue })}
        />,
      ),
    );
  }

  async function flush(): Promise<void> {
    await act(async () => {
      await Promise.resolve();
    });
  }

  function button(): HTMLButtonElement | null {
    return container.querySelector<HTMLButtonElement>(
      '[data-testid="wake-parked-continue"]',
    );
  }

  it.each([
    ['consecutive_limit', 'several times in a row'],
    ['daily_limit', 'many times today'],
    ['other', "won't reply to finished background work"],
  ] as const)('explains a %s park', (reason, text) => {
    render(reason, () => Promise.resolve());
    const notice = container.querySelector(
      '[data-testid="wake-parked-notice"]',
    );
    expect(notice?.textContent).toContain('Automatic replies paused');
    expect(notice?.textContent).toContain(text);
    expect(button()?.textContent).toBe('Continue');
  });

  it('offers no Continue to a viewer who cannot prompt', () => {
    render('consecutive_limit');
    expect(button()).toBeNull();
  });

  it('shows Continuing… while the resume is in flight, once', async () => {
    let finish: () => void = () => undefined;
    const onContinue = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    render('consecutive_limit', onContinue);

    act(() => button()?.click());
    expect(button()?.textContent).toBe('Continuing…');
    expect(button()?.disabled).toBe(true);
    act(() => button()?.click());
    expect(onContinue).toHaveBeenCalledTimes(1);

    finish();
    await flush();
    expect(button()?.textContent).toBe('Continue');
  });

  it('says when it could not continue and lets the user try again', async () => {
    const onContinue = jest
      .fn<Promise<void>, []>()
      .mockRejectedValueOnce(new Error('nope'))
      .mockResolvedValueOnce(undefined);
    render('daily_limit', onContinue);

    act(() => button()?.click());
    await flush();
    expect(container.textContent).toContain("Couldn't continue.");

    act(() => button()?.click());
    await flush();
    expect(onContinue).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain("Couldn't continue.");
  });
});
