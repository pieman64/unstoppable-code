/**
 * @jest-environment jsdom
 *
 * The edit shell's unsaved-changes guard (CAN-4072): the dirty report to
 * main, the navigation guard it registers, and the two-step answer to main's
 * close and quit requests.
 */
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  AppWindowConfirmCloseRequest,
  AppWindowConfirmCloseResponder,
} from '@canopy/desktop-shared/types';
import {
  UnsavedChangesDialog,
  type UnsavedChangesSaveResult,
} from '@canopy/ui-app/workflows';
import { askNavigationGuard } from '@/stores/navigationStore';
import { useWorkflowEditGuard } from '../useWorkflowEditGuard';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
  writable: true,
});

type ConfirmCloseListener = (
  request: AppWindowConfirmCloseRequest,
  responder: AppWindowConfirmCloseResponder,
) => void;

const setUnsavedChanges = jest.fn<Promise<void>, [boolean]>();
const unsubscribeConfirmClose = jest.fn();
let confirmCloseListener: ConfirmCloseListener | null = null;
const onConfirmClose = jest.fn((listener: ConfirmCloseListener) => {
  confirmCloseListener = listener;
  return unsubscribeConfirmClose;
});

let root: Root;
let container: HTMLDivElement;

interface HostProps {
  readonly dirty: boolean;
  readonly save?: () => Promise<UnsavedChangesSaveResult>;
  readonly discard?: () => void;
}

/** Renders the dialog from the guard's prompt, as the shell does. */
function GuardHost({ dirty, save, discard }: HostProps): ReactElement {
  const guard = useWorkflowEditGuard({
    isDirty: dirty,
    save:
      save ??
      ((): Promise<UnsavedChangesSaveResult> => Promise.resolve({ ok: true })),
    ...(discard ? { discard } : {}),
    targetKey: 'automation:activity-1',
  });
  return (
    <div>
      {guard.prompt ? (
        <UnsavedChangesDialog
          name="Nightly sweep"
          saving={guard.prompt.saving}
          onSave={guard.prompt.onSave}
          onDiscard={guard.prompt.onDiscard}
          onKeepEditing={guard.prompt.onKeepEditing}
        />
      ) : null}
      <span data-testid="guard-error">{guard.error ?? ''}</span>
    </div>
  );
}

function render(props: HostProps): void {
  act(() => {
    root.render(<GuardHost {...props} />);
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

function dialog(): HTMLElement | null {
  return document.querySelector('[data-testid="workflows-unsaved-dialog"]');
}

function click(selector: string): void {
  const element = document.querySelector(selector);
  if (!(element instanceof HTMLElement)) {
    throw new Error(`missing ${selector}`);
  }
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/** Main's request, with a responder that records what the renderer said. */
function requestClose(): {
  readonly acknowledgeShown: jest.Mock;
  readonly resolve: jest.Mock;
  readonly dialogShownAtAck: () => boolean | null;
} {
  let shownAtAck: boolean | null = null;
  const acknowledgeShown = jest.fn(() => {
    shownAtAck = dialog() !== null;
  });
  const resolve = jest.fn();
  const listener = confirmCloseListener;
  if (!listener) throw new Error('no confirm-close listener');
  act(() => {
    listener(
      { requestId: 'request-1', reason: 'close' },
      {
        acknowledgeShown,
        resolve,
      },
    );
  });
  return {
    acknowledgeShown,
    resolve,
    dialogShownAtAck: (): boolean | null => shownAtAck,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  confirmCloseListener = null;
  setUnsavedChanges.mockResolvedValue(undefined);
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { appWindow: { setUnsavedChanges, onConfirmClose } },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  document.body.innerHTML = '';
});

describe('useWorkflowEditGuard', () => {
  it('reports the dirty state to main and clears it on unmount', () => {
    render({ dirty: false });
    expect(setUnsavedChanges).toHaveBeenLastCalledWith(false);

    render({ dirty: true });
    expect(setUnsavedChanges).toHaveBeenLastCalledWith(true);

    act(() => {
      root.unmount();
    });
    expect(setUnsavedChanges).toHaveBeenLastCalledWith(false);
    expect(unsubscribeConfirmClose).toHaveBeenCalled();
    root = createRoot(container);
  });

  it('registers the navigation guard for its lifetime', async () => {
    render({ dirty: true });

    // Dirty: navigation waits for the prompt.
    const decision = askNavigationGuard('home');
    expect(decision).toBeInstanceOf(Promise);
    await flush();
    expect(dialog()).not.toBeNull();
    click('[data-testid="workflows-unsaved-discard"]');
    await expect(decision).resolves.toBe(true);

    // Clean: navigation is allowed at once.
    render({ dirty: false });
    expect(askNavigationGuard('home')).toBe(true);

    // Unmounted: the guard is gone even while the draft was dirty.
    render({ dirty: true });
    act(() => {
      root.unmount();
    });
    expect(askNavigationGuard('home')).toBe(true);
    root = createRoot(container);
  });

  it('answers a close request at once while clean', () => {
    render({ dirty: false });
    const { acknowledgeShown, resolve } = requestClose();

    expect(acknowledgeShown).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith(true);
    expect(dialog()).toBeNull();
  });

  it('acknowledges a close request only once the dialog shows, then closes on Discard', async () => {
    const discard = jest.fn();
    render({ dirty: true, discard });
    const request = requestClose();

    expect(dialog()).not.toBeNull();
    expect(request.acknowledgeShown).toHaveBeenCalledTimes(1);
    expect(request.dialogShownAtAck()).toBe(true);
    expect(request.resolve).not.toHaveBeenCalled();

    setUnsavedChanges.mockClear();
    click('[data-testid="workflows-unsaved-discard"]');
    await flush();

    expect(discard).toHaveBeenCalledTimes(1);
    // The dirty report is cleared first, so main's second close is not
    // asked about.
    expect(setUnsavedChanges).toHaveBeenCalledWith(false);
    expect(request.resolve).toHaveBeenCalledWith(true);
    const [clearOrder] = setUnsavedChanges.mock.invocationCallOrder;
    const [resolveOrder] = request.resolve.mock.invocationCallOrder;
    expect(clearOrder).toBeLessThan(resolveOrder);
  });

  it('keeps the window open when the user keeps editing', async () => {
    render({ dirty: true });
    const request = requestClose();

    click('[data-testid="workflows-unsaved-dialog"] [aria-label="Close"]');
    await flush();

    expect(dialog()).toBeNull();
    expect(request.acknowledgeShown).toHaveBeenCalledTimes(1);
    expect(request.resolve).toHaveBeenCalledWith(false);
    expect(setUnsavedChanges).not.toHaveBeenCalledWith(false);
  });

  it('keeps the window open and reports why when the save fails', async () => {
    const save = jest
      .fn<Promise<UnsavedChangesSaveResult>, []>()
      .mockResolvedValue({ ok: false, message: 'Name is required.' });
    render({ dirty: true, save });
    const request = requestClose();

    click('[data-testid="workflows-unsaved-save"]');
    await flush();

    expect(save).toHaveBeenCalledTimes(1);
    expect(request.resolve).toHaveBeenCalledWith(false);
    expect(dialog()).toBeNull();
    expect(
      document.querySelector('[data-testid="guard-error"]')?.textContent,
    ).toBe('Name is required.');
  });

  it('keeps the window open when the save throws', async () => {
    const save = jest
      .fn<Promise<UnsavedChangesSaveResult>, []>()
      .mockRejectedValue(new Error('disk full'));
    render({ dirty: true, save });
    const request = requestClose();

    click('[data-testid="workflows-unsaved-save"]');
    await flush();

    expect(save).toHaveBeenCalledTimes(1);
    expect(request.resolve).toHaveBeenCalledWith(false);
  });

  it('acknowledges at once when the dialog is already open for a navigation', async () => {
    render({ dirty: true });
    const navigation = askNavigationGuard('home');
    await flush();
    expect(dialog()).not.toBeNull();

    // The same dialog now answers main's close; main must not time out
    // waiting for an acknowledgement while the user reads it.
    const request = requestClose();
    expect(request.acknowledgeShown).toHaveBeenCalledTimes(1);
    expect(request.dialogShownAtAck()).toBe(true);
    // The navigation's prompt was replaced by the close's.
    await expect(navigation).resolves.toBe(false);

    click('[data-testid="workflows-unsaved-discard"]');
    await flush();
    expect(request.resolve).toHaveBeenCalledWith(true);
  });

  it('works without the app-window bridge', () => {
    Object.defineProperty(window, 'api', { configurable: true, value: {} });
    expect(() => render({ dirty: true })).not.toThrow();
    expect(() =>
      act(() => {
        root.unmount();
      }),
    ).not.toThrow();
    root = createRoot(container);
  });
});
