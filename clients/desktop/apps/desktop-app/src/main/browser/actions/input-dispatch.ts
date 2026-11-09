import type {
  BrowserJavaScriptDialog,
  BrowserKeyModifier,
  BrowserMouseButton,
} from '@canopy/execution-engine/types/browser';
import type { ActionLaneContext } from './action-lane';
import { ActionLaneDispatchTimeoutError } from './action-lane';
import {
  checkActionability,
  type ActionabilityOptions,
  type ActionabilityResult,
  type BrowserCdpSend,
} from './actionability';
import type { KeyEvent } from './key-definitions';

export interface InputAttribution {
  type:
    | 'mouseMoved'
    | 'mousePressed'
    | 'mouseReleased'
    | 'rawKeyDown'
    | 'keyDown'
    | 'keyUp';
  button?: BrowserMouseButton | 'none';
  key?: string;
  x?: number;
  y?: number;
  timestamp: number;
}

interface CommonDispatchOptions {
  send: BrowserCdpSend;
  /** Unfenced sender for best-effort releases after the action signal aborts. */
  cleanupSend?: BrowserCdpSend;
  sessionId?: string;
  lane: ActionLaneContext;
  beforeInput?: (event: InputAttribution) => void;
}

export interface ClickDispatchOptions extends CommonDispatchOptions {
  point: { x: number; y: number };
  button?: BrowserMouseButton;
  clickCount?: number;
  modifiers?: BrowserKeyModifier[];
  moveDelayMs?: number;
  pressDelayMs?: number;
  getPendingDialog?: () =>
    | BrowserJavaScriptDialog
    | undefined
    | Promise<BrowserJavaScriptDialog | undefined>;
}

export interface PressDispatchOptions extends CommonDispatchOptions {
  events: readonly KeyEvent[];
  getPendingDialog?: () => BrowserJavaScriptDialog | undefined;
}

export interface TargetedPressDispatchOptions extends PressDispatchOptions {
  objectId: string;
  /** Retained legacy keydown wrapper, including its atomic dialog response. */
  syntheticFallback?: () => Promise<void>;
}

export interface FocusDispatchOptions extends CommonDispatchOptions {
  objectId: string;
  backendNodeId: number;
  timeoutMs?: number;
  /** A frame target's document mapping and outer hit test, for the click. */
  frameMapping?: ActionabilityOptions['frameMapping'];
  outerHitTest?: ActionabilityOptions['outerHitTest'];
  getPendingDialog?: () =>
    | BrowserJavaScriptDialog
    | undefined
    | Promise<BrowserJavaScriptDialog | undefined>;
}

export interface FillDispatchOptions {
  lane: ActionLaneContext;
  fillPrepared: () => Promise<unknown>;
  getPendingDialog?: () => BrowserJavaScriptDialog | undefined;
}

export type ClickDispatchResult =
  | { completed: true; inputMode: 'trusted' }
  | { completed: false; inputMode: 'trusted'; dialog: BrowserJavaScriptDialog };

export type FocusDispatchResult =
  | {
      focused: boolean;
      inputMode: 'trusted';
      completed: true;
      warning?: string;
    }
  | {
      focused: false;
      inputMode: 'trusted';
      completed: false;
      dialog: BrowserJavaScriptDialog;
    };

const FOCUS_CLICK_ACTIONABILITY_TIMEOUT_MS = 250;

/**
 * Whether the element has focus in its document, through the shadow roots
 * it is in (closed ones too): each root's active element up to the
 * document's (review R2 finding 4). The document's alone is the host.
 */
const FOCUSED_FUNCTION =
  'function() { const owner = this.ownerDocument; for (let node = this; node; ) { const root = node.getRootNode(); if (!root || root.activeElement !== node) return false; if (root === owner) return true; node = root.host; } return false; }';

function delay(ms: number): Promise<void> {
  return ms <= 0
    ? Promise.resolve()
    : new Promise((resolve) => setTimeout(resolve, ms));
}

async function timed<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new InputCommandTimeoutError('CDP input command timed out')),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

class InputCommandTimeoutError extends Error {}

function throwInputFailure(error: unknown): never {
  if (error instanceof InputCommandTimeoutError)
    throw new ActionLaneDispatchTimeoutError(error.message);
  throw error;
}

function mouseParams(
  options: ClickDispatchOptions,
  type: 'mouseMoved' | 'mousePressed' | 'mouseReleased',
  point: { x: number; y: number },
  clickCount: number,
): Record<string, unknown> {
  const button = options.button ?? 'left';
  const buttons =
    type === 'mousePressed'
      ? button === 'left'
        ? 1
        : button === 'right'
          ? 2
          : 4
      : 0;
  let modifiers = 0;
  for (const modifier of options.modifiers ?? []) {
    if (modifier === 'Alt') modifiers |= 1;
    else if (modifier === 'Control') modifiers |= 2;
    else if (modifier === 'Meta') modifiers |= 4;
    else if (modifier === 'Shift') modifiers |= 8;
  }
  return {
    type,
    x: point.x,
    y: point.y,
    button: type === 'mouseMoved' ? 'none' : button,
    buttons,
    clickCount: type === 'mouseMoved' ? 0 : clickCount,
    ...(options.modifiers !== undefined ? { modifiers } : {}),
  };
}

function sendMouse(
  options: ClickDispatchOptions,
  type: 'mouseMoved' | 'mousePressed' | 'mouseReleased',
  cleanup = false,
  clickCount = options.clickCount ?? 1,
): Promise<unknown> {
  options.beforeInput?.({
    type,
    button: type === 'mouseMoved' ? 'none' : (options.button ?? 'left'),
    x: options.point.x,
    y: options.point.y,
    timestamp: Date.now(),
  });
  const sender = cleanup ? (options.cleanupSend ?? options.send) : options.send;
  return options.lane.trackCommand(
    sender(
      'Input.dispatchMouseEvent',
      mouseParams(options, type, options.point, clickCount),
      options.sessionId,
    ),
  );
}

export async function dispatchClick(
  options: ClickDispatchOptions,
): Promise<ClickDispatchResult> {
  options.lane.beginDispatch();
  await sendMouse(options, 'mouseMoved');
  await delay(options.moveDelayMs ?? 50);
  let held = false;
  let heldClickCount = 1;
  options.lane.registerCleanup(async () => {
    if (!held) return;
    held = false;
    await sendMouse(options, 'mouseReleased', true, heldClickCount);
  });
  const requestedClickCount = options.clickCount ?? 1;
  const clickCount = Number.isFinite(requestedClickCount)
    ? Math.max(1, Math.trunc(requestedClickCount))
    : 1;
  for (let index = 1; index <= clickCount; index += 1) {
    heldClickCount = index;
    try {
      // A press refused before it was sent (the sender throws) is not held.
      const pressed = sendMouse(options, 'mousePressed', false, index);
      held = true;
      await timed(pressed, 3_000);
    } catch (error) {
      const dialog = await options.getPendingDialog?.();
      if (dialog) return { completed: false, inputMode: 'trusted', dialog };
      throwInputFailure(error);
    }
    await delay(options.pressDelayMs ?? 80);
    try {
      await timed(sendMouse(options, 'mouseReleased', false, index), 5_000);
      held = false;
    } catch (error) {
      const dialog = await options.getPendingDialog?.();
      if (dialog) return { completed: false, inputMode: 'trusted', dialog };
      throwInputFailure(error);
    }
  }
  return { completed: true, inputMode: 'trusted' };
}

function keyParams(event: KeyEvent): Record<string, unknown> {
  return {
    type: event.type,
    key: event.key,
    code: event.code,
    windowsVirtualKeyCode: event.windowsVirtualKeyCode,
    modifiers: event.modifiers,
    ...(event.type === 'keyDown' && event.text !== undefined
      ? { text: event.text }
      : {}),
    ...(event.type === 'keyDown' && event.unmodifiedText !== undefined
      ? { unmodifiedText: event.unmodifiedText }
      : {}),
    ...(event.commands !== undefined ? { commands: event.commands } : {}),
  };
}

function sendKey(
  options: PressDispatchOptions,
  event: KeyEvent,
  cleanup = false,
): Promise<unknown> {
  options.beforeInput?.({
    type: event.type,
    key: event.key,
    timestamp: Date.now(),
  });
  const sender = cleanup ? (options.cleanupSend ?? options.send) : options.send;
  return options.lane.trackCommand(
    sender('Input.dispatchKeyEvent', keyParams(event), options.sessionId),
  );
}

export async function dispatchPress(
  options: PressDispatchOptions,
): Promise<
  | { inputMode: 'trusted'; completed?: true }
  | { inputMode: 'trusted'; completed: false; dialog: BrowserJavaScriptDialog }
> {
  const held = new Map<string, KeyEvent>();
  options.lane.registerCleanup(async () => {
    for (const event of Array.from(held.values()).reverse()) {
      held.delete(event.code);
      try {
        await sendKey(
          options,
          { ...event, type: 'keyUp', text: undefined, commands: undefined },
          true,
        );
      } catch {
        // Continue releasing the remaining held modifiers.
      }
    }
  });
  try {
    for (const event of options.events) {
      if (event.type === 'keyUp') {
        await sendKey(options, event);
        held.delete(event.code);
        continue;
      }
      options.lane.beginDispatch();
      // A key refused before it was sent (the sender throws) is not held.
      const sent = sendKey(options, event);
      held.set(event.code, event);
      await sent;
    }
  } catch (error) {
    const dialog = options.getPendingDialog?.();
    if (dialog) return { inputMode: 'trusted', completed: false, dialog };
    throw error;
  }
  return { inputMode: 'trusted' };
}

function focusedResponse(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || !('result' in value))
    return false;
  const result = value.result;
  if (typeof result !== 'object' || result === null || !('value' in result))
    return false;
  return result.value === true;
}

async function targetIsFocused(
  options: FocusDispatchOptions,
): Promise<boolean> {
  try {
    return focusedResponse(
      await options.lane.trackCommand(
        options.send(
          'Runtime.callFunctionOn',
          {
            objectId: options.objectId,
            functionDeclaration: FOCUSED_FUNCTION,
            returnByValue: true,
          },
          options.sessionId,
        ),
      ),
    );
  } catch {
    return false;
  }
}

async function blockedFocusResult(
  options: FocusDispatchOptions,
): Promise<FocusDispatchResult | undefined> {
  const dialog = await options.getPendingDialog?.();
  return dialog
    ? { focused: false, inputMode: 'trusted', completed: false, dialog }
    : undefined;
}

export async function dispatchFocus(
  options: FocusDispatchOptions,
): Promise<FocusDispatchResult> {
  options.lane.beginDispatch();
  try {
    await options.lane.trackCommand(
      options.send(
        'DOM.focus',
        { objectId: options.objectId },
        options.sessionId,
      ),
    );
  } catch {
    const blocked = await blockedFocusResult(options);
    if (blocked) return blocked;
  }
  options.lane.signal.throwIfAborted();

  if (await targetIsFocused(options))
    return { focused: true, inputMode: 'trusted', completed: true };
  const blocked = await blockedFocusResult(options);
  if (blocked) return blocked;

  const requestedTimeout =
    options.timeoutMs ?? FOCUS_CLICK_ACTIONABILITY_TIMEOUT_MS;
  const timeoutMs = Number.isFinite(requestedTimeout)
    ? Math.min(
        FOCUS_CLICK_ACTIONABILITY_TIMEOUT_MS,
        Math.max(0, requestedTimeout),
      )
    : FOCUS_CLICK_ACTIONABILITY_TIMEOUT_MS;
  const actionable: ActionabilityResult = await checkActionability({
    send: options.send,
    sessionId: options.sessionId,
    objectId: options.objectId,
    backendNodeId: options.backendNodeId,
    action: 'click',
    timeoutMs,
    signal: options.lane.signal,
    canUseDirectFallback: false,
    ...(options.frameMapping ? { frameMapping: options.frameMapping } : {}),
    ...(options.outerHitTest ? { outerHitTest: options.outerHitTest } : {}),
  });
  options.lane.signal.throwIfAborted();
  if (actionable.status === 'ready' && actionable.point) {
    const clicked = await dispatchClick({
      send: options.send,
      cleanupSend: options.cleanupSend,
      sessionId: options.sessionId,
      lane: options.lane,
      point: actionable.point,
      beforeInput: options.beforeInput,
      getPendingDialog: options.getPendingDialog,
    });
    if (!clicked.completed)
      return {
        focused: false,
        inputMode: 'trusted',
        completed: false,
        dialog: clicked.dialog,
      };
    options.lane.signal.throwIfAborted();
    if (await targetIsFocused(options))
      return { focused: true, inputMode: 'trusted', completed: true };
  }

  const dialog = await blockedFocusResult(options);
  return (
    dialog ?? {
      focused: false,
      inputMode: 'trusted',
      completed: true,
      warning: 'Target could not take focus using a hit-tested trusted click.',
    }
  );
}

export async function dispatchTargetedPress(
  options: TargetedPressDispatchOptions,
): Promise<
  | { inputMode: 'trusted'; completed?: true }
  | { inputMode: 'trusted'; completed: false; dialog: BrowserJavaScriptDialog }
  | { inputMode: 'synthetic'; warning: string }
> {
  // Focus is itself a state change and must be the first dispatch boundary.
  options.lane.beginDispatch();
  let focused = false;
  try {
    await options.lane.trackCommand(
      options.send(
        'DOM.focus',
        { objectId: options.objectId },
        options.sessionId,
      ),
    );
    focused = focusedResponse(
      await options.lane.trackCommand(
        options.send(
          'Runtime.callFunctionOn',
          {
            objectId: options.objectId,
            functionDeclaration: FOCUSED_FUNCTION,
            returnByValue: true,
          },
          options.sessionId,
        ),
      ),
    );
  } catch {
    focused = false;
  }
  // A cancelled action must not fall back to a synthetic keydown.
  options.lane.signal.throwIfAborted();
  if (focused) return dispatchPress(options);
  if (options.syntheticFallback) {
    await options.lane.trackCommand(options.syntheticFallback());
    return {
      inputMode: 'synthetic',
      warning: 'Target could not take focus; sent a synthetic keydown.',
    };
  }
  const key = options.events.find(
    (event) => event.type === 'rawKeyDown' || event.type === 'keyDown',
  );
  if (key) {
    await options.lane.trackCommand(
      options.send(
        'Runtime.callFunctionOn',
        {
          objectId: options.objectId,
          functionDeclaration:
            'function(key, code) { this.dispatchEvent(new KeyboardEvent("keydown", { key, code, bubbles: true, cancelable: true })); }',
          arguments: [{ value: key.key }, { value: key.code }],
          userGesture: true,
        },
        options.sessionId,
      ),
    );
  }
  return {
    inputMode: 'synthetic',
    warning: 'Target could not take focus; sent a synthetic keydown.',
  };
}

export async function dispatchFill(
  options: FillDispatchOptions,
): Promise<
  { completed: true } | { completed: false; dialog: BrowserJavaScriptDialog }
> {
  options.lane.beginDispatch();
  try {
    await options.lane.trackCommand(options.fillPrepared());
    return { completed: true };
  } catch (error) {
    const dialog = options.getPendingDialog?.();
    if (dialog) return { completed: false, dialog };
    throw error;
  }
}
