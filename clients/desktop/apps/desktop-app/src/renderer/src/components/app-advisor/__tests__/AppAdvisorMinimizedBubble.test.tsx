/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useAppAdvisorStore } from '@/stores/appAdvisorStore';
import { hasBrowserNativeViewOverlay } from '@/lib/browserNativeOverlay';
import { AppAdvisorMinimizedBubble } from '../AppAdvisorMinimizedBubble';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

let container: HTMLDivElement;
let root: Root;
const openDialog = jest.fn();

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  openDialog.mockClear();
  useAppAdvisorStore.setState({ open: false, minimized: false, openDialog });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function bubble(): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(
    '[data-testid="app-advisor-minimized-bubble"]',
  );
}

it('shows only while the floating panel is minimized', () => {
  act(() => root.render(<AppAdvisorMinimizedBubble />));
  expect(bubble()).toBeNull();

  act(() => useAppAdvisorStore.setState({ minimized: true }));
  expect(bubble()?.getAttribute('aria-label')).toBe('Open App Advisor');
  expect(bubble()?.className).toContain('rounded-full');

  // Open again: the panel is back, so the bubble goes.
  act(() => useAppAdvisorStore.setState({ minimized: false, open: true }));
  expect(bubble()).toBeNull();
});

it('reopens the panel', () => {
  useAppAdvisorStore.setState({ minimized: true });
  act(() => root.render(<AppAdvisorMinimizedBubble />));
  act(() => bubble()?.click());
  expect(openDialog).toHaveBeenCalledTimes(1);
});

it('does not hold the in-app browser on its still frame while it is up', () => {
  useAppAdvisorStore.setState({ minimized: true });
  act(() => root.render(<AppAdvisorMinimizedBubble />));
  expect(bubble()).not.toBeNull();
  // It sits on a floating layer, which blocks the native Browser view by
  // default; the bubble is persistent, so it opts out.
  expect(bubble()?.closest('.z-drawer')).not.toBeNull();
  expect(hasBrowserNativeViewOverlay(document)).toBe(false);
});
