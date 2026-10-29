/**
 * @jest-environment jsdom
 */
import { act, createElement, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useOverlayEscape } from '@canopy/ui-shared/components';
import {
  CANCEL_SHORTCUT_CONFIRM_WINDOW_MS,
  shouldHandleCancelRunningChatShortcut,
  useCancelRunningChatShortcut,
  useCancelShortcutConfirmationStore,
} from '../useCancelRunningChatShortcut';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function dispatchEscape(
  target: EventTarget = document,
  init: KeyboardEventInit = {},
): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'Escape',
    bubbles: true,
    cancelable: true,
    ...init,
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

function ShortcutHarness({
  enabled,
  active,
  onCancel,
  chatKey,
  ownerDocument,
  targetRootRef,
}: {
  enabled: boolean;
  active?: boolean;
  onCancel: () => void;
  chatKey?: string;
  ownerDocument?: Document;
  targetRootRef?: { readonly current: HTMLElement | null };
}): JSX.Element {
  const { armed } = useCancelRunningChatShortcut({
    enabled,
    active,
    onCancel,
    chatKey,
    ownerDocument,
    targetRootRef,
  });
  return createElement('div', {
    'data-testid': 'shortcut-harness',
    'data-armed': String(armed),
  });
}

function OverlayHarness({ onClose }: { onClose: () => void }): JSX.Element {
  useOverlayEscape(true, onClose);
  return createElement('div', { 'data-testid': 'overlay-harness' });
}

describe('useCancelRunningChatShortcut', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    jest.useFakeTimers();
    useCancelShortcutConfirmationStore.getState().setArmedChatKey(null);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
      jest.runOnlyPendingTimers();
    });
    container.remove();
    jest.useRealTimers();
  });

  function renderHarness(
    enabled: boolean,
    onCancel: () => void,
    chatKey?: string,
    active?: boolean,
    ownerDocument?: Document,
    targetRootRef?: { readonly current: HTMLElement | null },
  ): void {
    act(() => {
      root.render(
        createElement(ShortcutHarness, {
          enabled,
          active,
          onCancel,
          chatKey,
          ownerDocument,
          targetRootRef,
        }),
      );
    });
  }

  function armedState(): string | null | undefined {
    return container
      .querySelector('[data-testid="shortcut-harness"]')
      ?.getAttribute('data-armed');
  }

  it('arms without cancelling on the first Escape keydown', () => {
    const onCancel = jest.fn();
    renderHarness(true, onCancel);

    const event = dispatchEscape();

    expect(onCancel).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
    expect(armedState()).toBe('true');
  });

  it('cancels on the second Escape within the confirmation window', () => {
    const onCancel = jest.fn();
    renderHarness(true, onCancel);

    dispatchEscape();
    act(() => {
      jest.advanceTimersByTime(CANCEL_SHORTCUT_CONFIRM_WINDOW_MS - 1);
    });
    const second = dispatchEscape();

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(second.defaultPrevented).toBe(true);
    expect(armedState()).toBe('false');
  });

  it('listens only in the document that owns the rendered chat surface', () => {
    act(() => {
      root.unmount();
    });
    container.remove();

    const ownerDocument = document.implementation.createHTMLDocument('popout');
    container = ownerDocument.createElement('div');
    ownerDocument.body.append(container);
    root = createRoot(container);

    const onCancel = jest.fn();
    renderHarness(true, onCancel, undefined, undefined, ownerDocument);

    dispatchEscape(document);
    dispatchEscape(document);

    expect(onCancel).not.toHaveBeenCalled();
    expect(armedState()).toBe('false');

    dispatchEscape(ownerDocument);
    dispatchEscape(ownerDocument);

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(armedState()).toBe('false');
  });

  it('ignores Escape from outside the active chat panel root', () => {
    const targetRoot = document.createElement('section');
    const inside = document.createElement('button');
    const outside = document.createElement('button');
    targetRoot.append(inside);
    document.body.append(targetRoot, outside);
    const onCancel = jest.fn();

    renderHarness(true, onCancel, undefined, undefined, undefined, {
      current: targetRoot,
    });

    dispatchEscape(outside);
    dispatchEscape(outside);
    expect(onCancel).not.toHaveBeenCalled();
    expect(armedState()).toBe('false');

    dispatchEscape(inside);
    dispatchEscape(inside);
    expect(onCancel).toHaveBeenCalledTimes(1);

    targetRoot.remove();
    outside.remove();
  });

  // Panel scoping must reject a SIBLING surface, not the whole app. Nothing
  // holds the caret right after a window refocus, a modal close, or a terminal
  // pane releasing the caret with no predecessor (CAN-2309), and the browser
  // reports the body/document as the target in that state.
  it('still cancels for Escape with nothing focused inside the panel root', () => {
    const targetRoot = document.createElement('section');
    document.body.append(targetRoot);
    const onCancel = jest.fn();

    renderHarness(true, onCancel, undefined, undefined, undefined, {
      current: targetRoot,
    });

    dispatchEscape(document.body);
    expect(armedState()).toBe('true');
    dispatchEscape(document.body);

    expect(onCancel).toHaveBeenCalledTimes(1);

    targetRoot.remove();
  });

  // The neutral-target allowance must not reach a chat the user cannot see.
  // `MainPage` stays mounted behind `display: none` while another page is
  // active and `isActivePanel` knows nothing about the active page, so a
  // hidden worktree chat can still be `enabled && active` and still listening.
  // jsdom has no layout engine, so stub the rendered-ness probe the hook uses.
  it('does not cancel for a neutral target when the panel root is off screen', () => {
    const targetRoot = document.createElement('section');
    document.body.append(targetRoot);
    Object.defineProperty(targetRoot, 'checkVisibility', {
      configurable: true,
      value: (): boolean => false,
    });
    const onCancel = jest.fn();

    renderHarness(true, onCancel, undefined, undefined, undefined, {
      current: targetRoot,
    });

    dispatchEscape(document.body);
    dispatchEscape(document.body);

    expect(onCancel).not.toHaveBeenCalled();
    expect(armedState()).toBe('false');

    targetRoot.remove();
  });

  it('still cancels for a neutral target when the panel root is on screen', () => {
    const targetRoot = document.createElement('section');
    document.body.append(targetRoot);
    Object.defineProperty(targetRoot, 'checkVisibility', {
      configurable: true,
      value: (): boolean => true,
    });
    const onCancel = jest.fn();

    renderHarness(true, onCancel, undefined, undefined, undefined, {
      current: targetRoot,
    });

    dispatchEscape(document.body);
    dispatchEscape(document.body);

    expect(onCancel).toHaveBeenCalledTimes(1);

    targetRoot.remove();
  });

  // `ChatContent` roots are `display: contents`, which generates no box and
  // always reports invisible. The probe must walk past those to the first
  // ancestor that does generate a box, and must NOT walk past a hidden one.
  it('treats a display:contents root as rendered via its nearest boxed ancestor', () => {
    const host = document.createElement('div');
    const targetRoot = document.createElement('div');
    host.append(targetRoot);
    document.body.append(host);
    targetRoot.style.display = 'contents';
    Object.defineProperty(targetRoot, 'checkVisibility', {
      configurable: true,
      value: (): boolean => false,
    });
    Object.defineProperty(host, 'checkVisibility', {
      configurable: true,
      value: (): boolean => true,
    });
    const onCancel = jest.fn();

    renderHarness(true, onCancel, undefined, undefined, undefined, {
      current: targetRoot,
    });

    dispatchEscape(document.body);
    dispatchEscape(document.body);

    expect(onCancel).toHaveBeenCalledTimes(1);

    host.remove();
  });

  it('still cancels for Escape dispatched at the document itself', () => {
    const targetRoot = document.createElement('section');
    document.body.append(targetRoot);
    const onCancel = jest.fn();

    renderHarness(true, onCancel, undefined, undefined, undefined, {
      current: targetRoot,
    });

    dispatchEscape(document);
    dispatchEscape(document);

    expect(onCancel).toHaveBeenCalledTimes(1);

    targetRoot.remove();
  });

  it('ignores a terminal target from an auxiliary-window DOM realm', () => {
    act(() => {
      root.unmount();
    });
    container.remove();

    const foreignFrame = document.createElement('iframe');
    document.body.append(foreignFrame);
    const ownerDocument = foreignFrame.contentDocument;
    if (ownerDocument === null || foreignFrame.contentWindow === null) {
      throw new Error('Expected iframe document and window');
    }
    container = ownerDocument.createElement('div');
    ownerDocument.body.append(container);
    root = createRoot(container);

    const terminal = ownerDocument.createElement('div');
    terminal.className = 'xterm';
    ownerDocument.body.append(terminal);
    const onCancel = jest.fn();
    renderHarness(true, onCancel, undefined, undefined, ownerDocument);

    const dispatchForeignEscape = (): void => {
      const event = ownerDocument.createEvent('Event');
      event.initEvent('keydown', true, true);
      Object.defineProperty(event, 'key', {
        configurable: true,
        value: 'Escape',
      });
      act(() => {
        terminal.dispatchEvent(event);
      });
    };
    dispatchForeignEscape();
    dispatchForeignEscape();

    expect(onCancel).not.toHaveBeenCalled();
    expect(armedState()).toBe('false');
    foreignFrame.remove();
  });

  it('disarms after the confirmation window lapses', () => {
    const onCancel = jest.fn();
    renderHarness(true, onCancel);

    dispatchEscape();
    act(() => {
      jest.advanceTimersByTime(CANCEL_SHORTCUT_CONFIRM_WINDOW_MS);
    });

    expect(armedState()).toBe('false');

    // The next press starts a fresh confirmation instead of cancelling.
    dispatchEscape();
    expect(onCancel).not.toHaveBeenCalled();
    expect(armedState()).toBe('true');
  });

  it('ignores held-key repeat events for both presses', () => {
    const onCancel = jest.fn();
    renderHarness(true, onCancel);

    dispatchEscape(document, { repeat: true });
    expect(armedState()).toBe('false');

    dispatchEscape();
    dispatchEscape(document, { repeat: true });
    expect(onCancel).not.toHaveBeenCalled();
    expect(armedState()).toBe('true');
  });

  it('captures Escape before other handlers can stop propagation', () => {
    const onCancel = jest.fn();
    const terminal = document.createElement('div');
    document.body.append(terminal);
    terminal.addEventListener('keydown', (event) => {
      event.stopPropagation();
    });

    renderHarness(true, onCancel);

    const first = dispatchEscape(terminal);
    const second = dispatchEscape(terminal);

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(first.defaultPrevented).toBe(true);
    expect(second.defaultPrevented).toBe(true);
    terminal.remove();
  });

  it('lets an active overlay consume outside-focus Escape before arming cancellation', () => {
    const onCancel = jest.fn();
    const onOverlayClose = jest.fn();
    act(() => {
      root.render(
        createElement(
          'div',
          null,
          createElement(ShortcutHarness, {
            enabled: true,
            active: true,
            onCancel,
            chatKey: 'proj/wt/chat-1',
          }),
          createElement(OverlayHarness, { onClose: onOverlayClose }),
        ),
      );
    });

    const event = dispatchEscape(document);

    expect(onOverlayClose).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
    expect(
      useCancelShortcutConfirmationStore.getState().armedChatKey,
    ).toBeNull();
    expect(event.defaultPrevented).toBe(true);
  });

  it('does not arm or cancel when disabled', () => {
    const onCancel = jest.fn();
    renderHarness(false, onCancel);

    dispatchEscape();
    dispatchEscape();

    expect(onCancel).not.toHaveBeenCalled();
    expect(armedState()).toBe('false');
  });

  it('keeps a running chat armed across shortcut ownership changes', () => {
    const onCancel = jest.fn();
    renderHarness(true, onCancel, 'proj/wt/chat-1', true);
    dispatchEscape();

    renderHarness(true, onCancel, 'proj/wt/chat-1', false);

    expect(useCancelShortcutConfirmationStore.getState().armedChatKey).toBe(
      'proj/wt/chat-1',
    );
    expect(armedState()).toBe('true');
  });

  it('keeps the keyed confirmation through a transient identity gap', () => {
    const onCancel = jest.fn();
    renderHarness(true, onCancel, 'proj/wt/chat-1', true);
    dispatchEscape();

    renderHarness(true, onCancel, undefined, true);
    act(() => {
      jest.advanceTimersByTime(250);
    });

    expect(useCancelShortcutConfirmationStore.getState().armedChatKey).toBe(
      'proj/wt/chat-1',
    );
    dispatchEscape();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(
      useCancelShortcutConfirmationStore.getState().armedChatKey,
    ).toBeNull();
  });

  it('keeps the keyed confirmation through a transient enabled gap', () => {
    const onCancel = jest.fn();
    renderHarness(true, onCancel, 'proj/wt/chat-1', true);
    dispatchEscape();

    renderHarness(false, onCancel, 'proj/wt/chat-1', true);
    renderHarness(true, onCancel, 'proj/wt/chat-1', true);
    act(() => {
      jest.advanceTimersByTime(250);
    });

    expect(useCancelShortcutConfirmationStore.getState().armedChatKey).toBe(
      'proj/wt/chat-1',
    );
    dispatchEscape();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('accepts the first Escape during a transient enabled gap', () => {
    const onCancel = jest.fn();
    renderHarness(true, onCancel, 'proj/wt/chat-1', true);
    renderHarness(false, onCancel, 'proj/wt/chat-1', true);

    const first = dispatchEscape();

    expect(first.defaultPrevented).toBe(true);
    expect(useCancelShortcutConfirmationStore.getState().armedChatKey).toBe(
      'proj/wt/chat-1',
    );
    renderHarness(true, onCancel, 'proj/wt/chat-1', true);
    dispatchEscape();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('handles each Escape once when keyed owners overlap during handoff', () => {
    const firstCancel = jest.fn();
    const secondCancel = jest.fn();
    act(() => {
      root.render(
        createElement(
          'div',
          null,
          createElement(ShortcutHarness, {
            enabled: true,
            active: true,
            onCancel: firstCancel,
            chatKey: 'proj/wt/chat-1',
          }),
          createElement(ShortcutHarness, {
            enabled: true,
            active: true,
            onCancel: secondCancel,
            chatKey: 'proj/wt/chat-1',
          }),
        ),
      );
    });

    dispatchEscape();

    expect(firstCancel).not.toHaveBeenCalled();
    expect(secondCancel).not.toHaveBeenCalled();
    expect(useCancelShortcutConfirmationStore.getState().armedChatKey).toBe(
      'proj/wt/chat-1',
    );

    dispatchEscape();

    expect(firstCancel.mock.calls.length + secondCancel.mock.calls.length).toBe(
      1,
    );
    expect(
      useCancelShortcutConfirmationStore.getState().armedChatKey,
    ).toBeNull();
  });

  it('lets the replacement chat own Escape immediately after a keyed handoff', () => {
    const firstCancel = jest.fn();
    const secondCancel = jest.fn();
    act(() => {
      root.render(
        createElement(ShortcutHarness, {
          key: 'first-owner',
          enabled: true,
          active: true,
          onCancel: firstCancel,
          chatKey: 'proj/wt/chat-1',
        }),
      );
    });
    act(() => {
      root.render(
        createElement(ShortcutHarness, {
          key: 'second-owner',
          enabled: true,
          active: true,
          onCancel: secondCancel,
          chatKey: 'proj/wt/chat-2',
        }),
      );
    });

    const first = dispatchEscape();

    expect(first.defaultPrevented).toBe(true);
    expect(firstCancel).not.toHaveBeenCalled();
    expect(secondCancel).not.toHaveBeenCalled();
    expect(useCancelShortcutConfirmationStore.getState().armedChatKey).toBe(
      'proj/wt/chat-2',
    );
  });

  it('keeps a keyed confirmation across a composer remount', () => {
    const onCancel = jest.fn();
    renderHarness(true, onCancel, 'proj/wt/chat-1', true);
    dispatchEscape();

    act(() => {
      root.unmount();
    });
    root = createRoot(container);
    renderHarness(true, onCancel, 'proj/wt/chat-1', true);
    dispatchEscape();

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(
      useCancelShortcutConfirmationStore.getState().armedChatKey,
    ).toBeNull();
  });

  it('does not let a retired disabled owner clear its replacement confirmation', () => {
    const firstCancel = jest.fn();
    const replacementCancel = jest.fn();
    renderHarness(true, firstCancel, 'proj/wt/chat-1', true);
    renderHarness(false, firstCancel, 'proj/wt/chat-1', true);

    act(() => {
      root.unmount();
    });
    root = createRoot(container);
    renderHarness(true, replacementCancel, 'proj/wt/chat-1', true);
    dispatchEscape();

    act(() => {
      jest.advanceTimersByTime(250);
    });

    expect(useCancelShortcutConfirmationStore.getState().armedChatKey).toBe(
      'proj/wt/chat-1',
    );
    dispatchEscape();
    expect(replacementCancel).toHaveBeenCalledTimes(1);
    expect(firstCancel).not.toHaveBeenCalled();
  });

  it('does not let a retired owner handle Escape during a handoff gap', () => {
    const onCancel = jest.fn();
    renderHarness(true, onCancel, 'proj/wt/chat-1', true);

    act(() => {
      root.unmount();
    });
    const duringGap = dispatchEscape();

    expect(duringGap.defaultPrevented).toBe(false);
    expect(onCancel).not.toHaveBeenCalled();
    expect(
      useCancelShortcutConfirmationStore.getState().armedChatKey,
    ).toBeNull();

    root = createRoot(container);
    renderHarness(true, onCancel, 'proj/wt/chat-1', true);
    dispatchEscape();
    expect(onCancel).not.toHaveBeenCalled();
    dispatchEscape();

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(
      useCancelShortcutConfirmationStore.getState().armedChatKey,
    ).toBeNull();
  });

  it('keeps the listener after the Strict Mode setup replay', () => {
    const onCancel = jest.fn();
    act(() => {
      root.render(
        createElement(
          StrictMode,
          null,
          createElement(ShortcutHarness, {
            enabled: true,
            active: true,
            onCancel,
            chatKey: 'proj/wt/chat-1',
          }),
        ),
      );
    });
    act(() => {
      jest.runOnlyPendingTimers();
    });

    const event = dispatchEscape();

    expect(event.defaultPrevented).toBe(true);
    expect(onCancel).not.toHaveBeenCalled();
    expect(useCancelShortcutConfirmationStore.getState().armedChatKey).toBe(
      'proj/wt/chat-1',
    );
  });

  it('ignores Escape when another mounted surface owns shortcuts', () => {
    const onCancel = jest.fn();
    renderHarness(true, onCancel, 'proj/wt/chat-1', false);

    const event = dispatchEscape();

    expect(event.defaultPrevented).toBe(false);
    expect(onCancel).not.toHaveBeenCalled();
    expect(armedState()).toBe('false');
  });

  it('disarms when the shortcut becomes disabled mid-confirmation', () => {
    const onCancel = jest.fn();
    renderHarness(true, onCancel);

    dispatchEscape();
    expect(armedState()).toBe('true');

    renderHarness(false, onCancel);
    act(() => {
      jest.runOnlyPendingTimers();
    });
    expect(armedState()).toBe('false');

    renderHarness(true, onCancel);
    dispatchEscape();
    expect(onCancel).not.toHaveBeenCalled();
    expect(armedState()).toBe('true');
  });

  it('publishes the armed chat key to the shared confirmation store', () => {
    const onCancel = jest.fn();
    renderHarness(true, onCancel, 'proj/wt/chat-1');

    expect(
      useCancelShortcutConfirmationStore.getState().armedChatKey,
    ).toBeNull();

    dispatchEscape();
    expect(useCancelShortcutConfirmationStore.getState().armedChatKey).toBe(
      'proj/wt/chat-1',
    );

    dispatchEscape();
    expect(
      useCancelShortcutConfirmationStore.getState().armedChatKey,
    ).toBeNull();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('clears the shared confirmation store when the window lapses', () => {
    const onCancel = jest.fn();
    renderHarness(true, onCancel, 'proj/wt/chat-1');

    dispatchEscape();
    act(() => {
      jest.advanceTimersByTime(CANCEL_SHORTCUT_CONFIRM_WINDOW_MS);
    });

    expect(
      useCancelShortcutConfirmationStore.getState().armedChatKey,
    ).toBeNull();
  });

  it('does not clobber a sibling instance armed state on unmount', () => {
    const onCancel = jest.fn();
    useCancelShortcutConfirmationStore
      .getState()
      .setArmedChatKey('proj/wt/other-chat');

    renderHarness(true, onCancel, 'proj/wt/chat-1');
    act(() => {
      root.unmount();
    });

    expect(useCancelShortcutConfirmationStore.getState().armedChatKey).toBe(
      'proj/wt/other-chat',
    );
    useCancelShortcutConfirmationStore.getState().setArmedChatKey(null);

    // Re-create the root so the shared afterEach unmount stays valid.
    root = createRoot(container);
  });

  it('does not clear a newer sibling armed state when its window lapses', () => {
    const onCancel = jest.fn();
    renderHarness(true, onCancel, 'proj/wt/chat-1');
    dispatchEscape();
    act(() => {
      useCancelShortcutConfirmationStore
        .getState()
        .setArmedChatKey('proj/wt/other-chat');
    });

    act(() => {
      jest.advanceTimersByTime(CANCEL_SHORTCUT_CONFIRM_WINDOW_MS);
    });

    expect(useCancelShortcutConfirmationStore.getState().armedChatKey).toBe(
      'proj/wt/other-chat',
    );
  });

  it('does not clear sibling state when arming without a chat key', () => {
    const onCancel = jest.fn();
    useCancelShortcutConfirmationStore
      .getState()
      .setArmedChatKey('proj/wt/other-chat');

    renderHarness(true, onCancel);
    dispatchEscape();

    expect(useCancelShortcutConfirmationStore.getState().armedChatKey).toBe(
      'proj/wt/other-chat',
    );
  });

  it('defers when another Escape handler already handled the event', () => {
    const event = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    event.preventDefault();

    expect(shouldHandleCancelRunningChatShortcut(event)).toBe(false);
  });

  // CAN-2309: Esc-Esc is ordinary input inside a terminal (vim, less, fzf,
  // Claude Code's own TUI). Typing it in one terminal must never interrupt an
  // agent running in another surface.
  it('never cancels for Escape pressed inside a terminal pane', () => {
    const onCancel = jest.fn();
    const host = document.createElement('div');
    host.className = 'canopy-terminal-host';
    const xterm = document.createElement('div');
    xterm.className = 'xterm';
    const textarea = document.createElement('textarea');
    xterm.append(textarea);
    host.append(xterm);
    document.body.append(host);

    renderHarness(true, onCancel);

    const first = dispatchEscape(textarea);
    const second = dispatchEscape(textarea);

    expect(onCancel).not.toHaveBeenCalled();
    expect(first.defaultPrevented).toBe(false);
    expect(second.defaultPrevented).toBe(false);
    expect(armedState()).toBe('false');
    host.remove();
  });

  it('defers for Escape events from a terminal pane', () => {
    const xterm = document.createElement('div');
    xterm.className = 'xterm';
    document.body.append(xterm);
    let handled = true;
    xterm.addEventListener('keydown', (event) => {
      handled = shouldHandleCancelRunningChatShortcut(event);
    });

    dispatchEscape(xterm);

    expect(handled).toBe(false);
    xterm.remove();
  });

  it('defers for Escape events from the in-app browser chrome', () => {
    const browser = document.createElement('div');
    browser.setAttribute('data-browser-surface', '');
    const input = document.createElement('input');
    browser.append(input);
    document.body.append(browser);
    let handled = true;
    browser.addEventListener('keydown', (event) => {
      handled = shouldHandleCancelRunningChatShortcut(event);
    });

    dispatchEscape(input);

    expect(handled).toBe(false);
    browser.remove();
  });

  it('defers for Escape events from dialogs', () => {
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    document.body.append(dialog);
    let handled = false;
    dialog.addEventListener('keydown', (event) => {
      handled = shouldHandleCancelRunningChatShortcut(event);
    });

    dispatchEscape(dialog);

    expect(handled).toBe(false);
    dialog.remove();
  });
});
