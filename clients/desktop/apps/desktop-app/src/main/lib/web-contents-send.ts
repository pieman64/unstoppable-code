import { recordIpcSend } from '@canopy/desktop-shared/node/work-counters';
import { isRendererSchemeUrl } from '@canopy/desktop-shared/lib/renderer-scheme';

/**
 * The part of an Electron `WebContents` a main → renderer send needs. It is
 * structural so this module never imports Electron and test doubles work.
 */
export interface IpcSendTarget {
  send(channel: string, ...args: unknown[]): void;
  getURL?(): string;
}

/**
 * Work-counter window labels. They name the surface a renderer loads, not a
 * window instance, so counts stay comparable across runs.
 */
export type IpcWindowLabel =
  | 'main'
  | 'app-advisor'
  | 'aux'
  | 'browser'
  | 'unknown';

const labels = new WeakMap<object, IpcWindowLabel>();
const devRendererUrl = process.env['ELECTRON_RENDERER_URL'];

function labelForUrl(url: string): IpcWindowLabel {
  // Panel pull-outs are opener-rendered `about:blank` documents.
  if (url === 'about:blank') return 'aux';
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'unknown';
  }
  if (parsed.searchParams.get('surface') === 'app-advisor')
    return 'app-advisor';
  if (
    parsed.protocol === 'file:' ||
    isRendererSchemeUrl(url) ||
    (devRendererUrl !== undefined && url.startsWith(devRendererUrl))
  ) {
    return 'main';
  }
  return 'browser';
}

/**
 * Records the surface a window or view renders when it is created, so its
 * sends carry that label from the first message, before it navigates.
 */
export function registerIpcSurface(
  target: object,
  label: IpcWindowLabel,
): void {
  labels.set(target, label);
}

/**
 * The surface a target renders: its registered label, or else one read from
 * its URL and cached once it is unambiguous. Every window and view starts at
 * `about:blank`, so that URL, like none or an unparseable one, is read again
 * on the next send.
 */
export function ipcWindowLabel(target: IpcSendTarget): IpcWindowLabel {
  const cached = labels.get(target);
  if (cached) return cached;
  let url = '';
  try {
    url = target.getURL?.() ?? '';
  } catch {
    // A destroyed target has no URL; its send already succeeded.
    return 'unknown';
  }
  if (!url) return 'unknown';
  const label = labelForUrl(url);
  if (url !== 'about:blank' && label !== 'unknown') labels.set(target, label);
  return label;
}

/**
 * Counts one delivered main → renderer message. Never throws, so counting
 * cannot change a send's outcome.
 */
export function recordWebContentsSend(
  target: IpcSendTarget,
  channel: string,
  args: readonly unknown[],
): void {
  try {
    recordIpcSend(channel, ipcWindowLabel(target), args);
  } catch {
    // Counters are diagnostics; the message was already delivered.
  }
}

/**
 * Runs before a message or an invoke reply reaches a renderer. `target` is
 * the receiving `WebContents` (an invoke's `event.sender`), `channel` the
 * message's or the invoked channel.
 *
 * A projection that holds messages back (the coalesced `chat:state-changed`
 * push) flushes the target here, so the renderer never sees another message
 * or a reply ahead of one published before it.
 */
type RendererDeliveryBarrier = (target: object, channel: string) => void;

const deliveryBarriers: RendererDeliveryBarrier[] = [];

/** Registers a barrier; returns its removal. */
export function addRendererDeliveryBarrier(
  barrier: RendererDeliveryBarrier,
): () => void {
  deliveryBarriers.push(barrier);
  return (): void => {
    const index = deliveryBarriers.indexOf(barrier);
    if (index >= 0) deliveryBarriers.splice(index, 1);
  };
}

/**
 * Runs every barrier for one delivery. Never throws: a barrier cannot block
 * or fail the delivery it precedes.
 */
export function runRendererDeliveryBarriers(
  target: object,
  channel: string,
): void {
  if (deliveryBarriers.length === 0) return;
  for (const barrier of deliveryBarriers.slice()) {
    try {
      barrier(target, channel);
    } catch {
      // The barrier's own delivery failed; this message still goes out.
    }
  }
}

/**
 * Rewrites one channel's single-argument messages per receiving renderer (the
 * `chat:event` output appends). The renderer's preload undoes it, so its
 * subscribers receive the original message.
 */
export interface RendererMessageEncoder {
  /** The message to send `target` in place of `message`. */
  encode(target: object, message: unknown): unknown;
  /** `encode`'s message for `message` was not sent. */
  discard(target: object, message: unknown): void;
}

const messageEncoders = new Map<string, RendererMessageEncoder>();

/** A page-local decision, made before barriers, interception, or encoding. */
export type RendererDeliveryFilter = (
  target: object,
  args: readonly unknown[],
) => boolean;

const deliveryFilters = new Map<string, RendererDeliveryFilter>();

/** Return true from a filter to omit a page delivery. Observers still see it. */
export function setRendererDeliveryFilter(
  channel: string,
  filter: RendererDeliveryFilter,
): () => void {
  deliveryFilters.set(channel, filter);
  return (): void => {
    if (deliveryFilters.get(channel) === filter)
      deliveryFilters.delete(channel);
  };
}

/** Registers a channel's encoder; returns its removal. */
export function setRendererMessageEncoder(
  channel: string,
  encoder: RendererMessageEncoder,
): () => void {
  messageEncoders.set(channel, encoder);
  return (): void => {
    if (messageEncoders.get(channel) === encoder)
      messageEncoders.delete(channel);
  };
}

/**
 * Takes over the sends to one target (the hidden window a remote session
 * replays calls through). It receives each message as main published it,
 * before any encoder, and returns whether it handled it; a message it
 * handled never reaches the page.
 */
export type WebContentsSendInterceptor = (
  channel: string,
  args: readonly unknown[],
) => boolean;

const sendInterceptors = new WeakMap<object, WebContentsSendInterceptor>();

/** Installs `target`'s interceptor; returns its removal. */
export function interceptWebContentsSends(
  target: object,
  interceptor: WebContentsSendInterceptor,
): () => void {
  sendInterceptors.set(target, interceptor);
  return (): void => {
    if (sendInterceptors.get(target) === interceptor)
      sendInterceptors.delete(target);
  };
}

/**
 * Sees each message main published to a target, before any page-local filter
 * or encoder. A filtered message is observed even though it is not delivered.
 */
export type WebContentsSendObserver = (
  target: object,
  channel: string,
  args: readonly unknown[],
) => void;

const sendObservers: WebContentsSendObserver[] = [];

/** Registers an observer; returns its removal. */
export function observeWebContentsSends(
  observer: WebContentsSendObserver,
): () => void {
  sendObservers.push(observer);
  return (): void => {
    const index = sendObservers.indexOf(observer);
    if (index >= 0) sendObservers.splice(index, 1);
  };
}

/** Never throws: an observer cannot fail the send it watched. */
function notifySendObservers(
  target: object,
  channel: string,
  args: readonly unknown[],
): void {
  if (sendObservers.length === 0) return;
  for (const observer of sendObservers.slice()) {
    try {
      observer(target, channel, args);
    } catch {
      // The message was already delivered.
    }
  }
}

/**
 * Delivers one message through `send` (the page-facing send of its encoded
 * arguments), after the barriers, then counts and reports it.
 */
function deliverToWebContents(
  target: IpcSendTarget,
  channel: string,
  args: unknown[],
  send: (sentArgs: unknown[]) => void,
): void {
  const encoder = messageEncoders.get(channel);
  if (encoder === undefined || args.length !== 1) {
    send(args);
    recordWebContentsSend(target, channel, args);
    notifySendObservers(target, channel, args);
    return;
  }
  const message: unknown = args[0];
  const encoded = encoder.encode(target, message);
  try {
    send([encoded]);
  } catch (error) {
    encoder.discard(target, message);
    throw error;
  }
  recordWebContentsSend(target, channel, [encoded]);
  notifySendObservers(target, channel, args);
}

/**
 * `target.send(channel, ...args)` plus a work-counter increment, after the
 * delivery barriers. The send runs unchanged: its exceptions propagate as
 * before, and a failed send is not counted. A channel with an encoder sends
 * the encoded message, and counts what it sent. A target with an
 * interceptor hands it the message instead.
 */
const sendRedirects = new WeakMap<object, () => IpcSendTarget | null>();

/**
 * Sends addressed to `from` go to the target `to` returns instead, while it
 * returns one. The early access App Advisor keeps its renderer in a view its
 * full window hosts; that window's own page stays blank, so every sender
 * that addresses the window (or `window.webContents`) still reaches App
 * Advisor. Returns the removal.
 */
export function redirectIpcSends(
  from: object,
  to: () => IpcSendTarget | null,
): () => void {
  sendRedirects.set(from, to);
  return (): void => {
    if (sendRedirects.get(from) === to) sendRedirects.delete(from);
  };
}

export function sendToWebContents(
  addressed: IpcSendTarget,
  channel: string,
  ...args: unknown[]
): void {
  const target = sendRedirects.get(addressed)?.() ?? addressed;
  if (deliveryFilters.get(channel)?.(target, args)) {
    notifySendObservers(target, channel, args);
    return;
  }
  runRendererDeliveryBarriers(target, channel);
  const interceptor = sendInterceptors.get(target);
  if (interceptor !== undefined && interceptor(channel, args)) {
    recordWebContentsSend(target, channel, args);
    return;
  }
  deliverToWebContents(target, channel, args, (sentArgs): void => {
    target.send(channel, ...sentArgs);
  });
}

/**
 * Sends `channel`'s message inside `envelopeChannel` as
 * `(channel, encodedArgs)`, for a page whose preload unwraps it and
 * dispatches it as `channel` (a window controlling another computer). The
 * message is encoded for `target` exactly as `sendToWebContents` would.
 */
export function sendWrappedToWebContents(
  target: IpcSendTarget,
  envelopeChannel: string,
  channel: string,
  args: unknown[],
): void {
  if (deliveryFilters.get(channel)?.(target, args)) {
    notifySendObservers(target, channel, args);
    return;
  }
  runRendererDeliveryBarriers(target, channel);
  deliverToWebContents(target, channel, args, (sentArgs): void => {
    target.send(envelopeChannel, channel, sentArgs);
  });
}
