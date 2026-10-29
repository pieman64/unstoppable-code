import type {
  BrowserActionError,
  BrowserActionErrorCode,
} from '../types/browser';

/**
 * Why a snapshot or inspect could not resolve its target (phase 04b E3):
 * the frame field, a ref, a locator or a point. Reads fail with these the
 * way actions refuse, on every route.
 */
export const BROWSER_READ_TARGET_CODES = [
  'target_not_found',
  'target_stale',
  'target_ambiguous',
  'frame_unavailable',
  'invalid_locator',
] as const;

export type BrowserReadTargetCode = (typeof BROWSER_READ_TARGET_CODES)[number];

const ERROR_NAME = 'BrowserReadTargetError';

/**
 * The typed read failure, with a plain message (no code prefix). An IPC
 * rejection reaches the renderer only as `String(error)`, `name: message`,
 * so the code also travels in the name, as `BrowserReadTargetError[code]`;
 * `decodeBrowserReadTargetError` reads it back.
 */
export class BrowserReadTargetError extends Error {
  public constructor(
    public readonly code: BrowserReadTargetCode,
    message: string,
  ) {
    super(message);
    this.name = `${ERROR_NAME}[${code}]`;
  }
}

/**
 * Exactly an encoded read failure, alone or as Electron wraps an IPC
 * rejection: nothing else is read as one, whatever it mentions.
 */
const ENCODED =
  /^(?:Error invoking remote method '[^'\n]*': )?BrowserReadTargetError\[([a-z_]+)\]: (\S[\s\S]*)$/;

function readCode(
  value: string | undefined,
): BrowserReadTargetCode | undefined {
  return BROWSER_READ_TARGET_CODES.find((code) => code === value);
}

/** The code and plain message of a read failure, or undefined. */
export function decodeBrowserReadTargetError(
  error: unknown,
): { code: BrowserReadTargetCode; message: string } | undefined {
  if (error instanceof BrowserReadTargetError)
    return { code: error.code, message: error.message };
  const text =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : undefined;
  if (text === undefined) return undefined;
  const match = ENCODED.exec(text);
  const code = readCode(match?.[1]);
  const message = match?.[2];
  return code === undefined || message === undefined
    ? undefined
    : { code, message };
}

/**
 * A read failure in the shape action refusals use: `invalid_target` (an
 * unsupported locator is `execution_failed`, as for actions), the plain
 * message, and the specific code in `details.error`, with
 * `next: 'browser.input_snapshot'` where actions set it.
 */
export function browserReadTargetFailure(failure: {
  code: BrowserReadTargetCode;
  message: string;
}): {
  code: 'invalid_target' | 'execution_failed';
  message: string;
  details: { error: BrowserActionError };
} {
  const invalidLocator = failure.code === 'invalid_locator';
  const code: BrowserActionErrorCode =
    failure.code === 'invalid_locator' ? 'execution_failed' : failure.code;
  return {
    code: invalidLocator ? 'execution_failed' : 'invalid_target',
    message: failure.message,
    details: {
      error: {
        code,
        message: failure.message,
        retryable: false,
        ...(invalidLocator ? {} : { next: 'browser.input_snapshot' }),
      },
    },
  };
}
