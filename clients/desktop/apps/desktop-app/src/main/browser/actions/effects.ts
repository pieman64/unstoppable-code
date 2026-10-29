import type {
  BrowserActionEffects,
  BrowserDownloadTransfer,
  BrowserJavaScriptDialog,
} from '@canopy/desktop-shared/types/browser';
import type { BrowserCdpSend } from './actionability';

/** Baseline fields contain no form values or serialized DOM. */
export interface BrowserEffectBaseline {
  url?: string;
  loaderId?: string;
  mutationCount?: number;
  focus?: string;
}

export interface BrowserEffectOptions {
  send: BrowserCdpSend;
  sessionId?: string;
  before: BrowserEffectBaseline;
  waitMs?: number;
  /** Bounds settle after dispatch completion, independently of the action phase. */
  timeoutMs?: number;
  mutationCount?: () => number;
  /** Only transfers attributed to this action in its captured runtime. */
  getDownloads?: () => BrowserDownloadTransfer[];
  getPendingDialog?: () => BrowserJavaScriptDialog | undefined;
  signal?: AbortSignal;
  navigationStarted?: () => boolean;
  navigationCommitted?: () => boolean;
  /** Dispatch completion, including time spent awaiting an already-open dialog. */
  startedAt?: number;
  lastMutationAt?: () => number | undefined;
  subscribeSettle?: (listener: () => void) => () => void;
  deliveryConfirmed?: () => boolean;
  deliveryDeadline?: number;
  pendingDialogCorrelationUntil?: () => number | undefined;
  /**
   * A target in a child frame: its document's focus counts too (the top
   * document's stays on the frame), read through the retained target in
   * its own session.
   */
  focusDocument?: FocusDocument;
}

/** The retained target whose document's focus is read with the top's. */
export interface FocusDocument {
  objectId: string;
  sessionId?: string;
}

const FOCUS_FUNCTION = `function() {
  const element = document.activeElement;
  if (!element) return '';
  const path = [];
  for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
    const siblings = node.parentElement ? Array.from(node.parentElement.children) : [node];
    path.push(node.tagName + ':' + siblings.indexOf(node));
  }
  return path.reverse().join('/');
}`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

export function sanitizeNavigationUrl(input: string): string | undefined {
  try {
    const url = new URL(input);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return `${url.origin}${url.pathname}`;
  } catch {
    return undefined;
  }
}

async function readNavigation(
  send: BrowserCdpSend,
  sessionId?: string,
): Promise<{ url?: string; loaderId?: string }> {
  try {
    const response = record(await send('Page.getFrameTree', {}, sessionId));
    const frame = record(record(response?.frameTree)?.frame);
    return {
      url: typeof frame?.url === 'string' ? frame.url : undefined,
      loaderId:
        typeof frame?.loaderId === 'string' ? frame.loaderId : undefined,
    };
  } catch {
    return {};
  }
}

/** The same path for the active element of `this`'s document. */
const DOCUMENT_FOCUS_FUNCTION = `function() {
  const element = this.ownerDocument && this.ownerDocument.activeElement;
  if (!element) return '';
  const path = [];
  for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
    const siblings = node.parentElement ? Array.from(node.parentElement.children) : [node];
    path.push(node.tagName + ':' + siblings.indexOf(node));
  }
  return path.reverse().join('/');
}`;

async function readDocumentFocus(
  send: BrowserCdpSend,
  target: FocusDocument,
): Promise<string | undefined> {
  try {
    const response = record(
      await send(
        'Runtime.callFunctionOn',
        {
          objectId: target.objectId,
          functionDeclaration: DOCUMENT_FOCUS_FUNCTION,
          returnByValue: true,
        },
        target.sessionId,
      ),
    );
    const value = record(response?.result)?.value;
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The top document's focus, joined with a frame target's document's. */
async function readFocus(
  send: BrowserCdpSend,
  sessionId?: string,
  focusDocument?: FocusDocument,
): Promise<string | undefined> {
  const [top, frame] = await Promise.all([
    readTopFocus(send, sessionId),
    focusDocument ? readDocumentFocus(send, focusDocument) : undefined,
  ]);
  if (!focusDocument) return top;
  return top === undefined || frame === undefined
    ? undefined
    : `${top}\u0000${frame}`;
}

async function readTopFocus(
  send: BrowserCdpSend,
  sessionId?: string,
): Promise<string | undefined> {
  try {
    const response = record(
      await send(
        'Runtime.evaluate',
        {
          expression: `(${FOCUS_FUNCTION})()`,
          returnByValue: true,
        },
        sessionId,
      ),
    );
    const value = record(response?.result)?.value;
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

export async function captureEffectBaseline(options: {
  send: BrowserCdpSend;
  sessionId?: string;
  mutationCount?: () => number;
  focusDocument?: FocusDocument;
}): Promise<BrowserEffectBaseline> {
  const [navigation, focus] = await Promise.all([
    readNavigation(options.send, options.sessionId),
    readFocus(options.send, options.sessionId, options.focusDocument),
  ]);
  return {
    ...navigation,
    focus,
    mutationCount: options.mutationCount?.(),
  };
}

/** One active deadline timer; notifications move the quiet deadline or unblock it. */
function settle(options: BrowserEffectOptions): Promise<void> {
  if (options.signal?.aborted) return Promise.resolve();
  const startedAt = options.startedAt ?? Date.now();
  const minimum = options.waitMs ?? 50;
  const timeoutCap =
    options.timeoutMs === undefined
      ? Number.POSITIVE_INFINITY
      : startedAt + Math.max(100, options.timeoutMs);
  const cap = Math.min(startedAt + (options.waitMs ?? 300), timeoutCap);
  let mutations = options.mutationCount?.();
  let quietSince = Math.max(startedAt, options.lastMutationAt?.() ?? startedAt);
  return new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timerDeadline: number | undefined;
    let unsubscribe = (): void => {};
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener('abort', finish);
      unsubscribe();
      resolve();
    };
    const check = (): void => {
      if (finished) return;
      if (options.signal?.aborted) {
        finish();
        return;
      }
      const now = Date.now();
      const current = options.mutationCount?.();
      if (current !== mutations) {
        mutations = current;
        quietSince = options.lastMutationAt?.() ?? now;
      }
      const quietDeadline = Math.min(
        cap,
        Math.max(
          startedAt + minimum,
          quietSince + (options.waitMs === undefined ? 50 : minimum),
        ),
      );
      const deadlines: number[] = [];
      if (now < quietDeadline) deadlines.push(quietDeadline);
      const navigating =
        options.navigationStarted?.() === true &&
        options.navigationCommitted?.() !== true &&
        now < Math.min(startedAt + 2_000, timeoutCap);
      if (navigating) deadlines.push(Math.min(startedAt + 2_000, timeoutCap));
      // Task files expose reads and waits, not a settle subscription. Check
      // active transfers on the same single timer, even with DOM notifications.
      const downloadDeadline =
        startedAt + Math.max(0, options.timeoutMs ?? 5_000);
      if (
        now < downloadDeadline &&
        options
          .getDownloads?.()
          .some((download): boolean => download.status === 'in_progress')
      )
        deadlines.push(Math.min(downloadDeadline, now + 50));
      const deliveryDeadline =
        options.deliveryDeadline === undefined
          ? undefined
          : Math.min(options.deliveryDeadline, timeoutCap);
      if (
        options.deliveryConfirmed?.() === false &&
        deliveryDeadline !== undefined &&
        now < deliveryDeadline
      )
        deadlines.push(deliveryDeadline);
      const correlationUntil = options.pendingDialogCorrelationUntil?.();
      const correlationDeadline =
        correlationUntil === undefined
          ? undefined
          : Math.min(correlationUntil, timeoutCap);
      if (correlationDeadline !== undefined && now < correlationDeadline)
        deadlines.push(correlationDeadline);
      if (deadlines.length === 0) {
        finish();
        return;
      }
      let deadline = Math.min(...deadlines);
      // Compatibility for callers without notifications; production is event-driven.
      if (navigating && !options.subscribeSettle)
        deadline = Math.min(deadline, now + 50);
      if (timerDeadline === deadline) return;
      if (timer !== undefined) clearTimeout(timer);
      timerDeadline = deadline;
      timer = setTimeout(
        () => {
          timer = undefined;
          timerDeadline = undefined;
          check();
        },
        Math.max(0, deadline - now),
      );
    };
    options.signal?.addEventListener('abort', finish, { once: true });
    unsubscribe = options.subscribeSettle?.(check) ?? unsubscribe;
    if (finished) unsubscribe();
    else check();
  });
}

export async function collectBrowserEffects(
  options: BrowserEffectOptions,
): Promise<BrowserActionEffects> {
  await settle(options);
  if (options.signal?.aborted) return {};
  // A modal page cannot answer observational CDP reads until its dialog closes.
  const pendingDialog = options.getPendingDialog?.();
  if (pendingDialog) {
    const downloads = options.getDownloads?.();
    return {
      dialog: { ...pendingDialog },
      ...(downloads?.length ? { downloads } : {}),
    };
  }
  const [after, focus] = await Promise.all([
    readNavigation(options.send, options.sessionId),
    readFocus(options.send, options.sessionId, options.focusDocument),
  ]);
  if (options.signal?.aborted) return {};
  const urlChanged =
    after.url !== undefined &&
    options.before.url !== undefined &&
    after.url !== options.before.url;
  const loaderChanged =
    after.loaderId !== undefined &&
    options.before.loaderId !== undefined &&
    after.loaderId !== options.before.loaderId;
  const navigation: NonNullable<BrowserActionEffects['navigation']> = {
    kind: loaderChanged
      ? 'new_document'
      : urlChanged
        ? 'same_document'
        : 'none',
    ...(urlChanged && after.url && sanitizeNavigationUrl(after.url)
      ? { url: sanitizeNavigationUrl(after.url) }
      : {}),
    committed: loaderChanged || urlChanged,
  };
  const dialog = options.getPendingDialog?.();
  const downloads = options.getDownloads?.();
  return {
    ...(downloads?.length ? { downloads } : {}),
    navigation,
    ...(dialog ? { dialog } : {}),
    ...(options.before.mutationCount !== undefined &&
    options.mutationCount !== undefined
      ? { domChanged: options.mutationCount() !== options.before.mutationCount }
      : {}),
    ...(focus !== undefined && options.before.focus !== undefined
      ? { focusMoved: focus !== options.before.focus }
      : {}),
  };
}
