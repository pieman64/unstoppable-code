/** @jest-environment jsdom */

import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DialogModal } from '../DialogModal';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe('DialogModal card height', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = '';
  });

  function card(node: JSX.Element): HTMLElement | null {
    act(() => root.render(node));
    return document.querySelector<HTMLElement>('[role="dialog"]');
  }

  it('takes a definite height for a body that sizes from its parent', () => {
    const dialog = card(
      <DialogModal onClose={jest.fn()} title="Transcript" height="85vh">
        <div>Body</div>
      </DialogModal>,
    );

    expect(dialog?.style.height).toBe('85vh');
  });

  it('takes a minimum height so a short body does not collapse the card', () => {
    const dialog = card(
      <DialogModal onClose={jest.fn()} title="Run output" minHeight="24rem">
        <div>Body</div>
      </DialogModal>,
    );

    expect(dialog?.style.minHeight).toBe('24rem');
    expect(dialog?.style.height).toBe('');
  });

  it('fills the phone viewport for the full size and sizes to content above sm', () => {
    const full = card(
      <DialogModal onClose={jest.fn()} title="Run" maxWidth="full">
        <div>Body</div>
      </DialogModal>,
    );
    const fullTokens = (full?.className ?? '').split(/\s+/);
    expect(fullTokens).toEqual(expect.arrayContaining(['h-full', 'sm:h-auto']));

    act(() => root.unmount());
    root = createRoot(container);
    const bounded = card(
      <DialogModal onClose={jest.fn()} title="Run" maxWidth="3xl">
        <div>Body</div>
      </DialogModal>,
    );
    const boundedTokens = (bounded?.className ?? '').split(/\s+/);
    expect(boundedTokens).not.toContain('h-full');
    expect(boundedTokens).not.toContain('sm:h-auto');
  });
  it('pins a top-placed card so it grows down, and fits the rest of the window', () => {
    const dialog = card(
      <DialogModal onClose={jest.fn()} title="Add project" placement="top">
        <div>Body</div>
      </DialogModal>,
    );
    const overlay = dialog?.parentElement;
    const overlayTokens = (overlay?.className ?? '').split(/\s+/);
    expect(overlayTokens).toEqual(
      expect.arrayContaining(['items-start', 'pt-[clamp(1rem,10dvh,6rem)]']),
    );
    expect(overlayTokens).not.toContain('items-center');
    expect(dialog?.style.maxHeight).toBe(
      'calc(100dvh - clamp(1rem, 10dvh, 6rem) - 1rem)',
    );
  });

  it('centers by default and keeps an explicit max height', () => {
    const dialog = card(
      <DialogModal onClose={jest.fn()} title="Run" maxHeight="50vh">
        <div>Body</div>
      </DialogModal>,
    );
    expect((dialog?.parentElement?.className ?? '').split(/\s+/)).toContain(
      'items-center',
    );
    expect(dialog?.style.maxHeight).toBe('50vh');
  });
});
