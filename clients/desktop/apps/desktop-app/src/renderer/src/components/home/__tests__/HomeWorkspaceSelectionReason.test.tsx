/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { create as createZustand } from 'zustand';
import { HomeWorkspaceSelectionReason } from '../HomeWorkspaceSelectionReason';
import { useHomeComposerStore } from '@/stores/homeComposerStore';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

jest.mock('@/stores/homeComposerStore', () => {
  const { create } = jest.requireActual<{ create: typeof createZustand }>(
    'zustand',
  );
  return {
    useHomeComposerStore: create(() => ({
      workspaceId: null,
      workspaceSelectionReason: null,
    })),
  };
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(onSwitch: () => void = jest.fn()): void {
  act(() => {
    root.render(<HomeWorkspaceSelectionReason onSwitch={onSwitch} />);
  });
}

const hint = (): Element | null =>
  container.querySelector('[data-testid="home-workspace-reason"]');

it('explains a most-recent import landing with a Switch project action', () => {
  useHomeComposerStore.setState({
    workspaceId: 'side-quest',
    workspaceSelectionReason: 'most-recent-import',
  });
  const onSwitch = jest.fn();
  render(onSwitch);
  expect(hint()?.textContent).toBe('Most recent·Switch');
  const action = container.querySelector(
    '[data-testid="home-workspace-reason-action"]',
  );
  if (!(action instanceof HTMLButtonElement)) throw new Error('no action');
  expect(action.getAttribute('aria-label')).toBe('Switch project');
  act(() => action.click());
  expect(onSwitch).toHaveBeenCalledTimes(1);
  // Switch only opens the picker; the selection and its reason stay.
  expect(useHomeComposerStore.getState().workspaceId).toBe('side-quest');
  expect(useHomeComposerStore.getState().workspaceSelectionReason).toBe(
    'most-recent-import',
  );
});

it('renders nothing without a reason', () => {
  useHomeComposerStore.setState({
    workspaceId: 'side-quest',
    workspaceSelectionReason: null,
  });
  render();
  expect(hint()).toBeNull();
});

it('renders nothing without a selected workspace', () => {
  useHomeComposerStore.setState({
    workspaceId: null,
    workspaceSelectionReason: 'most-recent-import',
  });
  render();
  expect(hint()).toBeNull();
});

it('disappears when a later selection clears the reason', () => {
  useHomeComposerStore.setState({
    workspaceId: 'side-quest',
    workspaceSelectionReason: 'most-recent-import',
  });
  render();
  expect(hint()).not.toBeNull();
  act(() => {
    useHomeComposerStore.setState({
      workspaceId: 'payments-service',
      workspaceSelectionReason: null,
    });
  });
  expect(hint()).toBeNull();
});
