'use client';

import { Toast } from '@base-ui/react/toast';
import { useEffect, useRef, type JSX, type ReactNode } from 'react';
import type { InAppNotificationPlacement } from '../lib/notification-placement';
import type { NoticeIntent } from './Notice';

/**
 * Most toasts the stack shows at once. Older ones stay mounted but hidden
 * (Base UI's `data-limited`) and come back as newer ones leave.
 */
export const TOAST_STACK_LIMIT = 3;

/** What the stack needs to know about a host toast. */
export interface ToastStackItem {
  readonly id: string;
  readonly intent: NoticeIntent;
  /**
   * How long the toast stays up, in ms. The clock holds while the stack is
   * hovered or focused and while the window is in the background. `0` keeps
   * the toast until it is dismissed.
   */
  readonly timeoutMs: number;
}

interface ToastStackData<T extends ToastStackItem> {
  readonly item: T;
}

type SwipeDirection = 'up' | 'down' | 'left' | 'right';

export interface ToastStackProps<T extends ToastStackItem> {
  /** The host's live toasts, oldest first. */
  readonly toasts: readonly T[];
  readonly placement: InAppNotificationPlacement;
  /**
   * The stack closed a toast on its own: its time ran out, or the user swiped
   * it away or pressed Escape. The host drops it from `toasts`. A host's own
   * Dismiss button removes the toast from `toasts` directly instead.
   */
  readonly onClose: (id: string) => void;
  /**
   * The card's content, usually a `Notice` with `surface="none"` and
   * `shape="toast"`, whose controls nest in the card's 20px corners.
   */
  readonly renderToast: (toast: T) => ReactNode;
  readonly 'data-testid'?: string;
}

const SWIPE_DIRECTIONS: Record<InAppNotificationPlacement, SwipeDirection[]> = {
  'top-right': ['up', 'right'],
  'top-left': ['up', 'left'],
  'bottom-right': ['down', 'right'],
  'bottom-left': ['down', 'left'],
};

/** The screen edge the stack sits against: cards enter from and leave to it. */
function sideOf(placement: InAppNotificationPlacement): ToastStackSide {
  return placement.endsWith('left') ? 'left' : 'right';
}

/** How far each toast behind the front one peeks out, in px. */
const TOAST_PEEK_PX = 8;
type ToastStackSide = 'left' | 'right';

function isElementNode(target: EventTarget | null): target is Element {
  return (
    target !== null &&
    'nodeType' in target &&
    target.nodeType === 1 &&
    'closest' in target &&
    typeof target.closest === 'function'
  );
}

function isHTMLElementNode(active: Element | null): active is HTMLElement {
  return (
    active !== null &&
    active.nodeType === 1 &&
    'blur' in active &&
    typeof active.blur === 'function'
  );
}

/**
 * Mirrors the host's list into Base UI's toast manager: new ids are added,
 * changed toasts are updated in place, and ids the host dropped are closed
 * (with their exit animation). A toast Base UI closes itself is reported
 * once through `onClose`.
 */
function ToastStackSync<T extends ToastStackItem>({
  toasts,
  onClose,
}: {
  readonly toasts: readonly T[];
  readonly onClose: (id: string) => void;
}): null {
  const manager = Toast.useToastManager<ToastStackData<T>>();
  const { add, close, update } = manager;
  const shown = useRef(new Map<string, T>());
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    const liveIds = new Set(toasts.map((toast) => toast.id));
    for (const id of Array.from(shown.current.keys())) {
      if (liveIds.has(id)) continue;
      // Forget it first so the close it triggers is not reported back.
      shown.current.delete(id);
      close(id);
    }
    for (const toast of toasts) {
      const previous = shown.current.get(toast.id);
      if (previous === toast) continue;
      shown.current.set(toast.id, toast);
      if (previous !== undefined) {
        update(toast.id, { data: { item: toast } });
        continue;
      }
      const { id } = toast;
      add({
        id,
        type: toast.intent,
        timeout: toast.timeoutMs,
        // Every toast is announced politely, failures included. Base UI's
        // urgent priority hides the card from assistive technology until the
        // stack has focus, which would put a failure's actions out of reach.
        priority: 'low',
        data: { item: toast },
        onClose: (): void => {
          if (shown.current.delete(id)) onCloseRef.current(id);
        },
      });
    }
  }, [toasts, add, close, update]);

  return null;
}

function ToastStackCards<T extends ToastStackItem>({
  placement,
  renderToast,
}: {
  readonly placement: InAppNotificationPlacement;
  readonly renderToast: (toast: T) => ReactNode;
}): JSX.Element {
  const { toasts } = Toast.useToastManager<ToastStackData<T>>();
  // The stack is out of flow (each card is absolute), so the viewport
  // reserves the front card plus the edges peeking behind it. Anything the
  // host stacks beside it in the same corner keeps its place.
  const resting = toasts.filter(
    (toast) => toast.transitionStatus !== 'ending' && toast.limited !== true,
  );
  const frontHeight = resting[0]?.height ?? 0;
  const reservedHeight =
    resting.length === 0
      ? 0
      : frontHeight + (resting.length - 1) * TOAST_PEEK_PX;

  return (
    <div
      className="canopy-toast-stack"
      style={{ height: `${String(reservedHeight)}px` }}
    >
      {toasts.map((toast) =>
        toast.data === undefined ? null : (
          <Toast.Root
            key={toast.id}
            toast={toast}
            swipeDirection={SWIPE_DIRECTIONS[placement]}
            data-testid="toast-stack-card"
            data-toast-intent={toast.data.item.intent}
            // Base UI moves focus to the next card when one closes; keyboard
            // focus shows the shared ring, never the browser default outline.
            className="canopy-toast focus-ring pointer-events-auto rounded-2xl bg-quaternary shadow-xl"
          >
            <Toast.Content className="canopy-toast-content">
              {renderToast(toast.data.item)}
            </Toast.Content>
          </Toast.Root>
        ),
      )}
    </div>
  );
}

/**
 * The shared notification stack, built on Base UI's headless toast.
 *
 * Hosts keep their own toast list (what to show, history, preferences) and
 * draw each card's content; the stack owns timing, stacking, motion, swipe to
 * dismiss, and the polite live region. Cards slide in from the stack's side
 * of the screen and leave to it. Cards rest as a deck with the newest in
 * front and spread out while the stack is hovered or focused. F6 moves focus
 * into the stack.
 *
 * Render it inside the host's notification corner
 * (`getInAppNotificationContainerClasses`); it fills that corner's width and
 * grows away from the screen edge.
 */
export function ToastStack<T extends ToastStackItem>({
  toasts,
  placement,
  onClose,
  renderToast,
  'data-testid': dataTestId,
}: ToastStackProps<T>): JSX.Element {
  return (
    <Toast.Provider limit={TOAST_STACK_LIMIT}>
      <ToastStackSync toasts={toasts} onClose={onClose} />
      <Toast.Viewport
        data-testid={dataTestId}
        data-edge={placement.startsWith('top') ? 'top' : 'bottom'}
        data-side={sideOf(placement)}
        className="canopy-toast-viewport"
      >
        <ToastStackCards placement={placement} renderToast={renderToast} />
      </Toast.Viewport>
    </Toast.Provider>
  );
}

/**
 * Names the toast for assistive technology: wrap the toast's headline in it.
 * Renders a `<span>`, so it can sit inside a `Notice` title.
 */
export function ToastStackTitle({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  return <Toast.Title render={<span />}>{children}</Toast.Title>;
}

/**
 * Describes the toast for assistive technology: wrap the toast's message in
 * it. Renders a `<span>`, so it can sit inside a `Notice` message. The message
 * shows at most three lines. `onOverflowChange` reports whether the clamp
 * hides any of it, so the host can offer the rest in a details view even when
 * its own text preview kept the whole message.
 */
export function ToastStackDescription({
  children,
  onOverflowChange,
}: {
  readonly children: ReactNode;
  readonly onOverflowChange?: (overflowing: boolean) => void;
}): JSX.Element {
  const clampRef = useRef<HTMLSpanElement>(null);
  const onOverflowChangeRef = useRef(onOverflowChange);
  useEffect(() => {
    onOverflowChangeRef.current = onOverflowChange;
  });
  useEffect(() => {
    const element = clampRef.current;
    if (element === null || onOverflowChangeRef.current === undefined) return;
    const report = (): void => {
      // A pixel of slack absorbs subpixel line-height rounding.
      onOverflowChangeRef.current?.(
        element.scrollHeight > element.clientHeight + 1,
      );
    };
    report();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(report);
    observer.observe(element);
    return (): void => observer.disconnect();
  }, [children]);
  return (
    <Toast.Description render={<span />}>
      <span ref={clampRef} className="line-clamp-3">
        {children}
      </span>
    </Toast.Description>
  );
}

export interface ToastStackActivatableCardProps {
  /**
   * Runs when the card itself is clicked or its screen-reader button is
   * pressed. Without it the card is plain and not clickable.
   */
  readonly onActivate?: () => void;
  /** Accessible name of the card's screen-reader activation button. */
  readonly activateLabel: string;
  /**
   * Hand focus off the card before activating, so the Escape that closes a
   * dialog the card opens leaves the toast alone.
   */
  readonly blurFocusBeforeActivate?: boolean;
  /** The toast's type, exposed as `data-toast-type`. */
  readonly toastType: string;
  readonly children: ReactNode;
}

/**
 * A stacked toast's card. With `onActivate`, a click anywhere outside the
 * card's own buttons activates it, and a visually hidden button gives keyboard
 * and screen-reader users the same path.
 */
export function ToastStackActivatableCard({
  onActivate,
  activateLabel,
  blurFocusBeforeActivate = false,
  toastType,
  children,
}: ToastStackActivatableCardProps): JSX.Element {
  const clickable = onActivate !== undefined;
  const pointerListener = useRef<AbortController | null>(null);
  const pointerActivated = useRef(false);
  useEffect((): (() => void) => {
    return (): void => pointerListener.current?.abort();
  }, []);
  const activateCard = (card: HTMLElement): void => {
    const active = card.ownerDocument.activeElement;
    // Escape should close only the detail dialog, even if focus was in the card.
    if (
      blurFocusBeforeActivate &&
      isHTMLElementNode(active) &&
      card.contains(active)
    ) {
      active.blur();
    }
    onActivate?.();
  };

  return (
    <div
      onPointerDown={
        clickable
          ? (event): void => {
              if (
                event.button !== 0 ||
                (isElementNode(event.target) &&
                  event.target.closest('button,a,input,textarea'))
              ) {
                return;
              }
              pointerListener.current?.abort();
              pointerActivated.current = false;
              const card = event.currentTarget;
              const pointerId = event.pointerId;
              const startX = event.clientX;
              const startY = event.clientY;
              const controller = new AbortController();
              pointerListener.current = controller;
              card.ownerDocument.addEventListener(
                'pointerup',
                (up): void => {
                  if (up.pointerId !== pointerId) return;
                  controller.abort();
                  if (Math.hypot(up.clientX - startX, up.clientY - startY) > 8)
                    return;
                  // Base UI captures the pointer on Toast.Root, so the
                  // subsequent click is retargeted away from this card.
                  pointerActivated.current = true;
                  activateCard(card);
                  window.setTimeout(() => {
                    pointerActivated.current = false;
                  }, 0);
                },
                { signal: controller.signal },
              );
              card.ownerDocument.addEventListener(
                'pointercancel',
                () => controller.abort(),
                {
                  once: true,
                  signal: controller.signal,
                },
              );
            }
          : undefined
      }
      onClick={
        clickable
          ? (e): void => {
              if (pointerActivated.current) return;
              // The card's own buttons (Dismiss, Copy, an action) never also
              // activate the card.
              if (isElementNode(e.target) && e.target.closest('button')) {
                return;
              }
              // Escape inside a toast closes it. Hand focus off before a
              // dialog opens, so the Escape that closes the dialog leaves
              // the toast alone.
              activateCard(e.currentTarget);
            }
          : undefined
      }
      data-testid="toast-card"
      data-toast-type={toastType}
      // Inset: the card clips its content, so an outside ring would be cut.
      className={`rounded-2xl ${clickable ? 'cursor-pointer has-[:focus-visible]:outline-2 has-[:focus-visible]:-outline-offset-2 has-[:focus-visible]:outline-line-focus' : ''}`}
    >
      {clickable && (
        <button
          type="button"
          aria-label={activateLabel}
          className="sr-only pointer-events-none"
          onClick={(e): void => {
            e.stopPropagation();
            if (blurFocusBeforeActivate) e.currentTarget.blur();
            onActivate();
          }}
        />
      )}
      {children}
    </div>
  );
}
