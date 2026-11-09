import {
  AppErrorSchema,
  createAppError,
  type AppError,
  type AppErrorCode,
} from '@canopy/protocol/app-errors';
import { extractIpcErrorMessage } from './errors';

/**
 * A failure shown inline where it happened. `error` is our own sentence for a
 * known action that failed for an unclassified reason (with the raw reason in
 * `details`, copied on request and never rendered), or the structured error
 * when it is a recognized external failure or a defect.
 */
export interface InlineFailure {
  error: string | AppError;
  details?: string;
}

/** Programming errors stay defects even when the action that hit them is known. */
const PROGRAMMING_ERROR_NAMES = new Set([
  'TypeError',
  'ReferenceError',
  'RangeError',
  'SyntaxError',
  'EvalError',
  'URIError',
  'AggregateError',
  'AppErrorValidation',
]);

/**
 * Narrow message fallbacks for failures that arrive without a structured code
 * (git and gh output over IPC). Prefer a code; keep these specific, so a
 * message that merely mentions `gh auth` stays the action's own failure.
 */
const MESSAGE_CLASSIFIERS: ReadonlyArray<readonly [RegExp, AppErrorCode]> = [
  [/\bENOSPC\b|No space left on device/i, 'external.disk_full'],
  [
    /\b(?:ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH)\b|Could not resolve host|Failed to connect to/i,
    'external.offline',
  ],
  [
    /Authentication failed for|Bad credentials|\bHTTP 401\b|401 Unauthorized|could not read Username for/i,
    'external.sign_in_required',
  ],
];

const STATUS_CODES: Readonly<Record<string, AppErrorCode>> = {
  ENOSPC: 'external.disk_full',
  ENOTFOUND: 'external.offline',
  EAI_AGAIN: 'external.offline',
  ECONNREFUSED: 'external.offline',
  ENETUNREACH: 'external.offline',
  '401': 'external.sign_in_required',
};

function recognizedExternalCode(error: AppError): AppErrorCode | undefined {
  const status = error.detail.status;
  if (status !== undefined) {
    const byStatus = STATUS_CODES[String(status)];
    if (byStatus) return byStatus;
  }
  const message = error.detail.message;
  for (const [pattern, code] of MESSAGE_CLASSIFIERS) {
    if (pattern.test(message)) return code;
  }
  return undefined;
}

/**
 * Reclassifies an unrecorded defect as a catalog error, keeping its reference,
 * time, source and original detail so nothing about the occurrence is lost.
 */
function reclassify(error: AppError, code: AppErrorCode): AppError {
  const parsed = AppErrorSchema.safeParse({
    ...createAppError(code),
    referenceId: error.referenceId,
    occurredAt: error.occurredAt,
    detail: error.detail,
    ...(error.source === undefined ? {} : { source: error.source }),
  });
  return parsed.success ? parsed.data : error;
}

/**
 * The inline presentation of a caught failure (already through `toAppError`,
 * so a cancellation never reaches here):
 *
 * 1. An error something already classified, or recorded, stays as it is.
 * 2. A recognized external failure becomes its catalog error.
 * 3. A programming error stays a defect, with Report this.
 * 4. Any other failure of a known action leads with `copy`, with the raw
 *    reason behind Copy details. Without `copy` it stays a defect.
 */
export function inlineFailure(
  appError: AppError,
  copy?: string,
): InlineFailure {
  if (appError.kind !== 'defect' || appError.recordedBy !== undefined)
    return { error: appError };
  // A catalog defect has no native Error name. Preserve that classification;
  // only an unclassified operational Error may use the authored string path.
  const name = appError.detail.name;
  if (name === undefined || PROGRAMMING_ERROR_NAMES.has(name))
    return { error: appError };
  const code = recognizedExternalCode(appError);
  if (code) return { error: reclassify(appError, code) };
  if (!copy || name !== 'Error') return { error: appError };
  const message = appError.detail.message.trim();
  return message ? { error: copy, details: message } : { error: copy };
}

/** A path or an OS error code (ENOENT, EACCES, ...) marks a message as raw. */
const RAW_FAILURE_TEXT = /[\\/]|\bE[A-Z]{3,}\b/;
/** Electron's wrapper around a message thrown by a main-process handler. */
const IPC_WRAPPER = /^Error invoking remote method '[^']+': (?:Error: )?/;

/**
 * {@link inlineFailure} for actions whose main-process handler writes its own
 * sentences (a declined sign-in, a blocking policy): such a sentence leads.
 * Raw text (a path, an OS code) stays behind Copy details under `copy`.
 */
export function inlineFailureWithMainSentence(
  appError: AppError,
  copy: string,
): InlineFailure {
  const failure = inlineFailure(appError, copy);
  if (typeof failure.error !== 'string' || failure.details === undefined)
    return failure;
  const message = failure.details.replace(IPC_WRAPPER, '').trim();
  return message === '' || RAW_FAILURE_TEXT.test(message)
    ? failure
    : { error: message };
}

/** Our sentence for a validation failure, as an input error. */
export function inputFailure(title: string): InlineFailure {
  return {
    error: createAppError('input.not_accepted', { copy: { title } }),
  };
}

/** The text a reader compares against (the authored sentence or the title). */
export function inlineFailureText(
  failure: InlineFailure | null,
): string | null {
  if (!failure) return null;
  return typeof failure.error === 'string'
    ? failure.error
    : failure.error.copy.title;
}

/**
 * The reason behind a failure's sentence, unwrapped from Electron's IPC
 * message: the raw `details`, or the detail of an error main recorded. Agents
 * read it to tell causes apart; people see the sentence, with the reason
 * behind Copy details.
 */
export function inlineFailureReason(
  failure: InlineFailure | null,
): string | undefined {
  if (!failure) return undefined;
  const raw =
    typeof failure.error === 'string'
      ? failure.details
      : (failure.details ?? failure.error.detail.message);
  const reason = raw?.trim();
  return reason ? extractIpcErrorMessage(reason) : undefined;
}
