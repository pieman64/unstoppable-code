/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useOverlayEscape } from '../useOverlayEscape';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

function Dialog({ onClose }: { readonly onClose: () => void }): null {
  useOverlayEscape(true, onClose);
  return null;
}

function Page({
  open,
  onBack,
}: {
  readonly open: boolean;
  readonly onBack: () => void;
}): null {
  useOverlayEscape(open, onBack, undefined, { layer: 'page' });
  return null;
}

function pressEscape(): void {
  act(() => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
  });
}

const roots: Root[] = [];
function mount(): Root {
  const root = createRoot(document.createElement('div'));
  roots.push(root);
  return root;
}

afterEach(() => {
  act(() => {
    while (roots.length > 0) roots.pop()?.unmount();
  });
});

describe('useOverlayEscape page layer', () => {
  it('keeps a page Escape that opens after a dialog beneath the dialog', () => {
    const closeDialog = jest.fn();
    const back = jest.fn();
    const dialog = mount();
    const page = mount();
    act(() => dialog.render(<Dialog onClose={closeDialog} />));
    // The page's Back becomes available only after the dialog is up, as a
    // landed detail does once its data resolves (CAN-3710).
    act(() => page.render(<Page open={false} onBack={back} />));
    act(() => page.render(<Page open onBack={back} />));

    pressEscape();
    expect(closeDialog).toHaveBeenCalledTimes(1);
    expect(back).not.toHaveBeenCalled();

    act(() => dialog.unmount());
    pressEscape();
    expect(back).toHaveBeenCalledTimes(1);
  });

  it('still lets a dialog that opens over a page close first', () => {
    const closeDialog = jest.fn();
    const back = jest.fn();
    const page = mount();
    const dialog = mount();
    act(() => page.render(<Page open onBack={back} />));
    act(() => dialog.render(<Dialog onClose={closeDialog} />));

    pressEscape();
    expect(closeDialog).toHaveBeenCalledTimes(1);
    expect(back).not.toHaveBeenCalled();
  });
});
