import type {
  BrowserAutomationCommand,
  BrowserDownloadTransfer,
  BrowserJavaScriptDialog,
  BrowserWaitForResult,
} from '@canopy/execution-engine/types/browser';
import { sanitizeNavigationUrl } from './effects';

export type BrowserWaitForCommand = Extract<
  BrowserAutomationCommand,
  { kind: 'wait_for' }
>;

export interface BrowserWaitForProbe {
  matchCount: number;
  visibleCount: number;
  readyState: 'loading' | 'interactive' | 'complete';
}

/** Injectable task-files watcher; the service captures task and browser identity. */
export interface BrowserDownloadWaitOptions {
  downloadId?: string;
  since: number;
  signal: AbortSignal;
  onProgress?: (download: BrowserDownloadTransfer) => void;
}

export interface BrowserWaitForOptions {
  readonly command: BrowserWaitForCommand;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  readonly probe: (
    signal: AbortSignal,
    deadline: number,
  ) => Promise<BrowserWaitForProbe>;
  readonly getUrl: () => string;
  readonly getInflightRequestCount: () => number;
  readonly getLastNetworkActivityAt: () => number | undefined;
  readonly isRuntimeCurrent: () => boolean;
  readonly isNavigating?: () => boolean;
  readonly getPendingDialog: () => BrowserJavaScriptDialog | undefined;
  readonly pollIntervalMs?: number;
  readonly waitForDownload?: (
    options: BrowserDownloadWaitOptions,
  ) => Promise<BrowserDownloadTransfer | undefined>;
}

export type BrowserWaitForOutcome =
  | { status: 'completed'; waitFor: BrowserWaitForResult }
  | { status: 'timeout'; waitFor: BrowserWaitForResult }
  | { status: 'cancelled' }
  | { status: 'runtime_lost' }
  | { status: 'dialog'; dialog: BrowserJavaScriptDialog }
  | { status: 'invalid_target'; message: string }
  | { status: 'failed'; message: string };

export class BrowserWaitForInvalidTargetError extends Error {}

export class BrowserWaitForNavigationError extends Error {}

type ConditionObservation =
  | { probe: BrowserWaitForProbe }
  | { download: BrowserDownloadTransfer | undefined };

type ConditionAttempt =
  | { status: 'resolved'; value: ConditionObservation }
  | { status: 'rejected'; error: unknown }
  | { status: 'aborted' };

function observedUrl(url: string): string | undefined {
  const sanitized = sanitizeNavigationUrl(url);
  if (sanitized) return sanitized;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'file:'
      ? `file://${parsed.pathname}`
      : undefined;
  } catch {
    return undefined;
  }
}

function globMatches(pattern: string, value: string): boolean {
  let patternIndex = 0;
  let valueIndex = 0;
  let starIndex = -1;
  let valueAfterStar = 0;
  while (valueIndex < value.length) {
    if (
      patternIndex < pattern.length &&
      pattern[patternIndex] !== '*' &&
      pattern[patternIndex] === value[valueIndex]
    ) {
      patternIndex += 1;
      valueIndex += 1;
    } else if (pattern[patternIndex] === '*') {
      starIndex = patternIndex;
      patternIndex += 1;
      valueAfterStar = valueIndex;
    } else if (starIndex !== -1) {
      patternIndex = starIndex + 1;
      valueAfterStar += 1;
      valueIndex = valueAfterStar;
    } else {
      return false;
    }
  }
  while (pattern[patternIndex] === '*') patternIndex += 1;
  return patternIndex === pattern.length;
}

function runtimeIsCurrent(options: BrowserWaitForOptions): boolean {
  try {
    return options.isRuntimeCurrent();
  } catch {
    return false;
  }
}

function conditionAttempt(
  options: BrowserWaitForOptions,
  signal: AbortSignal,
  deadline: number,
  since: number,
  onProgress: (download: BrowserDownloadTransfer) => void,
): Promise<ConditionAttempt> {
  return new Promise<ConditionAttempt>((resolve) => {
    let settled = false;
    const finish = (attempt: ConditionAttempt): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      resolve(attempt);
    };
    const abort = (): void => finish({ status: 'aborted' });
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    const read = async (): Promise<ConditionObservation> => {
      if (options.command.download !== undefined) {
        if (!options.waitForDownload)
          throw new Error('Download waiting is unavailable.');
        const download = await options.waitForDownload({
          ...options.command.download,
          since,
          signal,
          onProgress,
        });
        return { download };
      }
      return { probe: await options.probe(signal, deadline) };
    };
    // The next-download watcher must be installed before yielding: an
    // admission later in this tick must not enter the store's existing set.
    void (
      options.command.download !== undefined
        ? read()
        : Promise.resolve().then(read)
    ).then(
      (value): void => finish({ status: 'resolved', value }),
      (error: unknown): void => finish({ status: 'rejected', error }),
    );
  });
}

function delay(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (elapsed: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      resolve(elapsed);
    };
    const timer = setTimeout(() => finish(true), ms);
    const abort = (): void => finish(false);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

function waitStateSatisfied(
  command: BrowserWaitForCommand,
  probe: BrowserWaitForProbe,
): boolean {
  if (command.locator !== undefined || command.text !== undefined) {
    switch (command.state ?? 'visible') {
      case 'visible':
        return probe.visibleCount > 0;
      case 'hidden':
        return probe.visibleCount === 0;
      case 'attached':
        return probe.matchCount > 0;
      case 'detached':
        return probe.matchCount === 0;
    }
  }
  if (command.url !== undefined) return false;
  if (command.loadState === 'load') return probe.readyState === 'complete';
  if (command.loadState === 'domcontentloaded')
    return (
      probe.readyState === 'interactive' || probe.readyState === 'complete'
    );
  return false;
}

function result(
  startedAt: number,
  satisfied: boolean,
  options: BrowserWaitForOptions,
  probe: BrowserWaitForProbe | undefined,
  download?: BrowserDownloadTransfer,
): BrowserWaitForResult {
  if (options.command.download !== undefined)
    return {
      satisfied,
      elapsedMs: Math.max(0, Date.now() - startedAt),
      observed: download ? { download } : {},
    };
  const currentUrl = options.getUrl();
  const inflightRequests = options.getInflightRequestCount();
  const observed: BrowserWaitForResult['observed'] = {
    ...(observedUrl(currentUrl) !== undefined
      ? { url: observedUrl(currentUrl) }
      : {}),
    ...(probe ? { readyState: probe.readyState } : {}),
    ...(probe &&
    (options.command.locator !== undefined ||
      options.command.text !== undefined)
      ? { matchCount: probe.matchCount, visibleCount: probe.visibleCount }
      : {}),
    ...(options.command.loadState === 'network_idle'
      ? { inflightRequests: Math.max(0, inflightRequests) }
      : {}),
  };
  return {
    satisfied,
    elapsedMs: Math.max(0, Date.now() - startedAt),
    observed,
  };
}

/** Polls a browser condition without entering the state-changing input lane. */
export async function waitForBrowserCondition(
  options: BrowserWaitForOptions,
): Promise<BrowserWaitForOutcome> {
  const startedAt = Date.now();
  const deadline = startedAt + Math.max(0, options.timeoutMs);
  const controller = new AbortController();
  let stopReason: 'cancelled' | 'timeout' | 'runtime_lost' | 'dialog' | null =
    null;
  let stoppedDialog: BrowserJavaScriptDialog | undefined;
  const stop = (
    reason: 'cancelled' | 'timeout' | 'runtime_lost' | 'dialog',
  ): void => {
    if (stopReason !== null) return;
    stopReason = reason;
    controller.abort(
      reason === 'cancelled'
        ? options.signal.reason
        : new DOMException(
            'Browser wait stopped.',
            reason === 'timeout' ? 'TimeoutError' : 'AbortError',
          ),
    );
  };
  const onAbort = (): void => stop('cancelled');
  options.signal.addEventListener('abort', onAbort, { once: true });
  if (options.signal.aborted) stop('cancelled');
  const timeout = setTimeout(
    () => stop('timeout'),
    Math.max(0, options.timeoutMs),
  );
  // Reads run at most once per 100 ms; callers cannot request a busy loop.
  const interval = 100;
  let lifecycleTimer: ReturnType<typeof setTimeout> | undefined;
  const checkLifecycle = (): void => {
    if (controller.signal.aborted) return;
    if (!runtimeIsCurrent(options)) {
      stop('runtime_lost');
      return;
    }
    const dialog = options.getPendingDialog();
    if (dialog) {
      stoppedDialog = { ...dialog };
      stop('dialog');
      return;
    }
    lifecycleTimer = setTimeout(checkLifecycle, interval);
  };
  lifecycleTimer = setTimeout(checkLifecycle, interval);
  let latestProbe: BrowserWaitForProbe | undefined;
  let latestDownload: BrowserDownloadTransfer | undefined;
  let idleSince: number | undefined;
  try {
    for (;;) {
      if (stopReason === 'cancelled') return { status: 'cancelled' };
      if (stopReason === 'runtime_lost') return { status: 'runtime_lost' };
      if (stopReason === 'dialog' && stoppedDialog)
        return { status: 'dialog', dialog: stoppedDialog };
      if (stopReason === 'timeout')
        return {
          status: 'timeout',
          waitFor: result(
            startedAt,
            false,
            options,
            latestProbe,
            latestDownload,
          ),
        };
      if (!runtimeIsCurrent(options)) return { status: 'runtime_lost' };
      const pendingDialog = options.getPendingDialog();
      if (pendingDialog) return { status: 'dialog', dialog: pendingDialog };

      const attempt = await conditionAttempt(
        options,
        controller.signal,
        deadline,
        startedAt,
        (download): void => {
          latestDownload = download;
        },
      );
      if (attempt.status === 'aborted') {
        if (!runtimeIsCurrent(options)) return { status: 'runtime_lost' };
        if (stopReason === 'cancelled') return { status: 'cancelled' };
        if (stopReason === 'runtime_lost') return { status: 'runtime_lost' };
        if (stopReason === 'dialog' && stoppedDialog)
          return { status: 'dialog', dialog: stoppedDialog };
        return {
          status: 'timeout',
          waitFor: result(
            startedAt,
            false,
            options,
            latestProbe,
            latestDownload,
          ),
        };
      }
      if (attempt.status === 'rejected') {
        if (attempt.error instanceof BrowserWaitForInvalidTargetError)
          return { status: 'invalid_target', message: attempt.error.message };
        if (attempt.error instanceof BrowserWaitForNavigationError) {
          if (!runtimeIsCurrent(options)) return { status: 'runtime_lost' };
          const dialog = options.getPendingDialog();
          if (dialog) return { status: 'dialog', dialog };
          if (Date.now() >= deadline)
            return {
              status: 'timeout',
              waitFor: result(
                startedAt,
                false,
                options,
                latestProbe,
                latestDownload,
              ),
            };
          if (
            !(await delay(
              Math.min(interval, deadline - Date.now()),
              controller.signal,
            ))
          )
            continue;
          continue;
        }
        if (stopReason === 'timeout' || Date.now() >= deadline)
          return {
            status: 'timeout',
            waitFor: result(
              startedAt,
              false,
              options,
              latestProbe,
              latestDownload,
            ),
          };
        if (!runtimeIsCurrent(options)) return { status: 'runtime_lost' };
        const dialog = options.getPendingDialog();
        if (dialog) return { status: 'dialog', dialog };
        return {
          status: 'failed',
          message:
            attempt.error instanceof Error
              ? attempt.error.message
              : 'Browser wait probe failed.',
        };
      }
      if ('download' in attempt.value) {
        if (!runtimeIsCurrent(options)) return { status: 'runtime_lost' };
        if (options.signal.aborted) return { status: 'cancelled' };
        const dialog = options.getPendingDialog();
        if (dialog) return { status: 'dialog', dialog };
        const download = attempt.value.download;
        if (download) latestDownload = download;
        return {
          status: download ? 'completed' : 'timeout',
          waitFor: result(
            startedAt,
            download !== undefined,
            options,
            undefined,
            latestDownload,
          ),
        };
      }
      latestProbe = attempt.value.probe;
      if (!runtimeIsCurrent(options)) return { status: 'runtime_lost' };
      const dialog = options.getPendingDialog();
      if (dialog) return { status: 'dialog', dialog };

      const currentUrl = options.getUrl();
      const navigating = options.isNavigating?.() === true;
      let satisfied =
        (options.command.loadState === undefined ||
          !navigating ||
          (options.command.loadState === 'domcontentloaded' &&
            latestProbe.readyState === 'interactive')) &&
        waitStateSatisfied(options.command, latestProbe);
      if (options.command.url !== undefined) {
        const matches = options.command.url.includes('*')
          ? globMatches(options.command.url, currentUrl)
          : currentUrl.includes(options.command.url);
        satisfied = matches;
      }
      let inflightRequests = 0;
      if (options.command.loadState === 'network_idle') {
        inflightRequests = Math.max(0, options.getInflightRequestCount());
        const activity = options.getLastNetworkActivityAt();
        if (
          inflightRequests > 0 ||
          navigating ||
          latestProbe.readyState !== 'complete'
        )
          idleSince = undefined;
        else if (
          activity !== undefined &&
          (idleSince === undefined || activity > idleSince)
        )
          idleSince = activity;
        else if (idleSince === undefined) idleSince = Date.now();
        const loadComplete =
          !navigating && latestProbe.readyState === 'complete';
        satisfied =
          loadComplete &&
          inflightRequests === 0 &&
          idleSince !== undefined &&
          Date.now() - idleSince >= 500;
      }
      if (satisfied)
        return {
          status: 'completed',
          waitFor: result(startedAt, true, options, latestProbe),
        };
      if (Date.now() >= deadline)
        return {
          status: 'timeout',
          waitFor: result(
            startedAt,
            false,
            options,
            latestProbe,
            latestDownload,
          ),
        };
      if (
        !(await delay(
          Math.min(interval, deadline - Date.now()),
          controller.signal,
        ))
      ) {
        if (stopReason === 'cancelled') return { status: 'cancelled' };
        if (stopReason === 'runtime_lost') return { status: 'runtime_lost' };
        if (stopReason === 'dialog' && stoppedDialog)
          return { status: 'dialog', dialog: stoppedDialog };
        if (!runtimeIsCurrent(options)) return { status: 'runtime_lost' };
        return {
          status: 'timeout',
          waitFor: result(
            startedAt,
            false,
            options,
            latestProbe,
            latestDownload,
          ),
        };
      }
    }
  } finally {
    clearTimeout(timeout);
    clearTimeout(lifecycleTimer);
    options.signal.removeEventListener('abort', onAbort);
    // Stop any host probe still pending on runtime/dialog shutdown.
    controller.abort();
  }
}
