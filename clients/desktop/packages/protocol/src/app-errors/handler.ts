import { z } from 'zod';
import { toAppError, type ToAppErrorOptions } from './create';
import {
  AppErrorIdentifierSchema,
  AppErrorSurfaceSchema,
  AppErrorTimestampSchema,
  type AppErrorSurface,
} from './primitives';
import type { ErrorRandomBytes } from './reference-id';
import { AppErrorSchema, type AppError } from './types';

export interface AppErrorRecord {
  error: AppError;
  disposition: 'recorded' | 'counted';
  occurrenceCount: number;
  isRepeatSummary: boolean;
  retryFixed: boolean;
  surface?: AppErrorSurface;
  appVersion: string;
}

export interface AppErrorReport {
  error: AppError;
  disposition: 'none' | AppErrorRecord['disposition'];
}

export type AppErrorSink = (record: AppErrorRecord) => void;
export interface AppErrorScheduler {
  /** Returns a cancellation function. Callbacks must run asynchronously. */
  schedule(callback: () => void, delayMs: number): () => void;
}

export interface AppErrorHandlerOptions {
  sinks: readonly AppErrorSink[];
  host: string;
  appVersion: string;
  clock?: () => number;
  randomBytes?: ErrorRandomBytes;
  scheduler?: AppErrorScheduler;
  windowMs?: number;
  maxBuckets?: number;
}

export type AppErrorReportOptions = Pick<ToAppErrorOptions, 'signal'> & {
  surface?: AppErrorSurface;
  retryFixed?: boolean;
};

export interface AppErrorHandler {
  report(
    value: unknown,
    options?: AppErrorReportOptions,
  ): AppErrorReport | undefined;
  flush(): void;
  dispose(): void;
}

interface Bucket {
  key: string;
  expiresAt: number;
  record: AppErrorRecord;
  cancel?: () => void;
}

const ConfigSchema = z
  .object({
    host: AppErrorIdentifierSchema,
    appVersion: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/)
      .refine((value) => value === value.trim()),
    windowMs: z.number().int().positive().max(2147483647),
    maxBuckets: z.number().int().positive().max(10000),
  })
  .strict();

const ReportOptionsSchema = z
  .object({
    surface: AppErrorSurfaceSchema.optional(),
    retryFixed: z.boolean().optional(),
  })
  .strict();

function errorKey(error: AppError): string {
  if (error.kind !== 'defect') return JSON.stringify([error.kind, error.code]);
  const stack = error.detail.stack ?? '';
  const header = `${error.detail.name ?? 'Error'}: ${error.detail.message}`;
  const frames = stack.startsWith(header) ? stack.slice(header.length) : stack;
  const frame =
    frames.split('\n').find((line) => /^\s*at\s|@/.test(line)) ?? '';
  return JSON.stringify([
    error.kind,
    error.code,
    error.detail.name ?? '',
    error.detail.message,
    frame,
  ]);
}

const defaultScheduler: AppErrorScheduler = {
  schedule(callback, delayMs): () => void {
    const timer = setTimeout(callback, delayMs);
    return (): void => clearTimeout(timer);
  },
};

/** Bounded fixed windows limit repeats per active key, not distinct failures. */
export function createAppErrorHandler(
  options: AppErrorHandlerOptions,
): AppErrorHandler {
  const config = ConfigSchema.parse({
    host: options.host,
    appVersion: options.appVersion,
    windowMs: options.windowMs ?? 60000,
    maxBuckets: options.maxBuckets ?? 128,
  });
  const candidateSinks: unknown = options.sinks;
  if (
    !Array.isArray(candidateSinks) ||
    !candidateSinks.every((sink: unknown) => typeof sink === 'function')
  )
    throw new TypeError('Invalid error sinks');
  if (options.clock !== undefined && typeof options.clock !== 'function')
    throw new TypeError('Invalid error clock');
  if (
    options.randomBytes !== undefined &&
    typeof options.randomBytes !== 'function'
  )
    throw new TypeError('Invalid error randomness');
  if (
    options.scheduler !== undefined &&
    typeof options.scheduler.schedule !== 'function'
  )
    throw new TypeError('Invalid error scheduler');
  const sinks: readonly AppErrorSink[] = [...options.sinks];
  const clock = options.clock ?? Date.now;
  const scheduler = options.scheduler ?? defaultScheduler;
  const buckets = new Map<string, Bucket>();
  let disposed = false;
  let dispatching = false;

  function emit(record: AppErrorRecord): void {
    const previous = dispatching;
    dispatching = true;
    try {
      for (const sink of sinks) {
        try {
          // Isolate mutation as well as exceptions between sinks.
          sink({ ...record, error: AppErrorSchema.parse(record.error) });
        } catch {
          // Routing is best effort; recording markers never acknowledge delivery.
        }
      }
    } finally {
      dispatching = previous;
    }
  }

  function close(bucket: Bucket): void {
    if (buckets.get(bucket.key) !== bucket) return;
    buckets.delete(bucket.key);
    bucket.cancel?.();
    bucket.cancel = undefined;
    if (bucket.record.occurrenceCount > 1)
      emit({ ...bucket.record, isRepeatSummary: true });
  }

  function flush(): void {
    for (const bucket of [...buckets.values()]) close(bucket);
  }

  function report(
    value: unknown,
    reportOptions: AppErrorReportOptions = {},
  ): AppErrorReport | undefined {
    const now = AppErrorTimestampSchema.parse(clock());
    const error = toAppError(value, {
      clock: () => now,
      randomBytes: options.randomBytes,
      signal: reportOptions.signal,
    });
    if (!error) return undefined;
    const metadata = { ...reportOptions };
    delete metadata.signal;
    const presentation = ReportOptionsSchema.parse(metadata);
    if (
      disposed ||
      dispatching ||
      error.kind === 'input' ||
      error.recordedBy !== undefined
    )
      return { error, disposition: 'none' };
    for (const bucket of [...buckets.values()]) {
      if (now >= bucket.expiresAt) close(bucket);
    }
    // A sink may dispose the handler while an expired summary is dispatched.
    if (disposed) return { error, disposition: 'none' };
    const key = errorKey(error);
    const existing = buckets.get(key);
    const disposition = error.kind === 'defect' ? 'recorded' : 'counted';
    if (existing) {
      existing.record.occurrenceCount++;
      existing.record.retryFixed ||= presentation.retryFixed ?? false;
      return {
        error: {
          ...error,
          referenceId: existing.record.error.referenceId,
          recordedBy: config.host,
        },
        disposition,
      };
    }
    if (buckets.size >= config.maxBuckets) {
      const oldest = buckets.values().next().value;
      if (oldest) close(oldest);
    }
    if (disposed) return { error, disposition: 'none' };
    const marked = { ...error, recordedBy: config.host };
    const bucket: Bucket = {
      key,
      expiresAt: now + config.windowMs,
      record: {
        error:
          error.kind === 'external'
            ? { ...marked, detail: { message: error.code } }
            : marked,
        disposition,
        occurrenceCount: 1,
        isRepeatSummary: false,
        retryFixed: presentation.retryFixed ?? false,
        ...(presentation.surface === undefined
          ? {}
          : { surface: presentation.surface }),
        appVersion: config.appVersion,
      },
    };
    buckets.set(key, bucket);
    emit(bucket.record);
    if (buckets.get(key) === bucket) {
      bucket.cancel = scheduler.schedule(() => close(bucket), config.windowMs);
    }
    return { error: marked, disposition };
  }

  return {
    report,
    flush,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      flush();
    },
  };
}
