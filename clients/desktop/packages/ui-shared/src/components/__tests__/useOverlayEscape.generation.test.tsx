/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import {
  hasEscapeEnabledOverlay,
  overlayGeneration,
  subscribeOverlayStack,
  useOverlayEscape,
} from '../useOverlayEscape';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

function Overlay({ open }: { readonly open: boolean }): null {
  useOverlayEscape(open, (): void => undefined);
  return null;
}

describe('overlayGeneration', () => {
  it('changes when an overlay opens and again when it closes', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const start = overlayGeneration(document);
    act(() => root.render(<Overlay open={false} />));
    expect(overlayGeneration(document)).toBe(start);
    act(() => root.render(<Overlay open />));
    const opened = overlayGeneration(document);
    expect(opened).not.toBe(start);
    expect(hasEscapeEnabledOverlay(document)).toBe(true);
    act(() => root.render(<Overlay open={false} />));
    expect(overlayGeneration(document)).not.toBe(opened);
    expect(hasEscapeEnabledOverlay(document)).toBe(false);
    act(() => root.unmount());
  });
});

describe('subscribeOverlayStack', () => {
  it('notifies when an overlay opens and closes, until unsubscribed', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const listener = jest.fn();
    const unsubscribe = subscribeOverlayStack(document, listener);
    act(() => root.render(<Overlay open />));
    expect(listener).toHaveBeenCalledTimes(1);
    act(() => root.render(<Overlay open={false} />));
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    act(() => root.render(<Overlay open />));
    expect(listener).toHaveBeenCalledTimes(2);
    act(() => root.unmount());
  });

  it('does not notify listeners of another document', () => {
    const other = document.implementation.createHTMLDocument('other');
    const listener = jest.fn();
    const unsubscribe = subscribeOverlayStack(other, listener);
    const root = createRoot(document.createElement('div'));
    act(() => root.render(<Overlay open />));
    act(() => root.unmount());
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });
});
