/** @jest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  BackgroundWorkCapNotice,
  backgroundWorkCapMessage,
} from '../BackgroundWorkCapNotice';
import { ComposerDrawer } from '../ComposerDrawer';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const MINUTE = 60_000;
const CAP = 1_800_000_000_000;

describe('BackgroundWorkCapNotice', () => {
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

  function byTestId(id: string): HTMLElement | null {
    return container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  }

  it('counts whole minutes up, never under one', () => {
    expect(backgroundWorkCapMessage(CAP, CAP - 15 * MINUTE)).toBe(
      'Background work stops in 15 min because this chat has been idle.',
    );
    expect(backgroundWorkCapMessage(CAP, CAP - 14 * MINUTE - 1)).toContain(
      'in 15 min',
    );
    expect(backgroundWorkCapMessage(CAP, CAP - 10_000)).toContain('in 1 min');
    expect(backgroundWorkCapMessage(CAP, CAP + 10_000)).toContain('in 1 min');
  });

  it('is a section of the composer drawer, explained only without an action', () => {
    act(() =>
      root.render(
        <ComposerDrawer edge="top">
          <BackgroundWorkCapNotice
            capExpiresAtMs={CAP}
            nowMs={CAP - 5 * MINUTE}
          />
        </ComposerDrawer>,
      ),
    );
    const notice = byTestId('background-work-cap-notice');
    expect(notice?.hasAttribute('data-composer-drawer-section')).toBe(true);
    expect(notice?.getAttribute('role')).toBe('status');
    expect(notice?.textContent).toContain('stops in 5 min');
    expect(byTestId('background-work-keep-running')).toBeNull();
  });

  it('runs Keep running once at a time and reports a failure', async () => {
    let finish: (() => void) | undefined;
    const keepRunning = jest
      .fn<Promise<void>, []>()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      )
      .mockRejectedValueOnce(new Error('refused'));
    act(() =>
      root.render(
        <BackgroundWorkCapNotice
          capExpiresAtMs={CAP}
          nowMs={CAP - 5 * MINUTE}
          onKeepRunning={keepRunning}
        />,
      ),
    );
    const button = (): HTMLElement | null =>
      byTestId('background-work-keep-running');
    expect(button()?.textContent).toBe('Keep running');
    act(() => button()?.click());
    expect(button()?.getAttribute('aria-busy')).toBe('true');
    act(() => button()?.click());
    expect(keepRunning).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish?.();
      await Promise.resolve();
    });
    expect(button()?.hasAttribute('aria-busy')).toBe(false);

    await act(async () => {
      button()?.click();
      await Promise.resolve();
    });
    expect(byTestId('background-work-cap-notice-error')?.textContent).toBe(
      "Couldn't keep it running. Try again.",
    );
  });
});
