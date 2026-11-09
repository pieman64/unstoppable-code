import { CoworkFolderMissingSchema } from '@canopy/protocol/canopy-core';
import {
  decodeIpcAppError,
  formatIpcLegacyError,
  IPC_APP_ERROR_MAX_KEY_LENGTH,
  safeErrorProperty,
} from '@canopy/desktop-shared/ipc/app-error-rejection';

interface LookupEntry {
  shape?: object;
  operationFailure?: object;
  coworkFolderMissing?: object;
  /** Same-message failures disagreed, so no directive can be attributed. */
  conflicted: boolean;
  expiresAt: number;
}

const entries = new Map<string, LookupEntry>();
const MAX_ENTRIES = 128;
const TTL_MS = 60_000;

function liveEntry(message: unknown): LookupEntry | undefined {
  if (
    typeof message !== 'string' ||
    message.length > IPC_APP_ERROR_MAX_KEY_LENGTH
  )
    return undefined;
  const entry = entries.get(message);
  if (entry && entry.expiresAt <= Date.now()) {
    entries.delete(message);
    return undefined;
  }
  return entry;
}

/** Best effort, non-consuming lookup. Same-message collisions resolve to the
 * most recent shape; callers must validate it and never use it as authority. */
export function resolveIpcAppError(message: unknown): unknown {
  return liveEntry(message)?.shape;
}

/** Non-consuming like the shape, but a miss when same-message failures carry
 * different semantics: a wrong retry directive is worse than none. */
export function resolveIpcOperationFailure(message: unknown): unknown {
  return liveEntry(message)?.operationFailure;
}

/** Presentation context from the validated carrier, scoped to the submitted
 * project. Electron's context bridge discards custom Error properties. */
export function resolveIpcCoworkFolderMissing(
  message: string,
  workspaceId: string,
): unknown {
  return liveEntry(`cowork:${workspaceId}\u0000${message}`)
    ?.coworkFolderMissing;
}

function isRecord(value: unknown): value is object {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function restoreIpcAppError(error: unknown): never {
  const decoded = decodeIpcAppError(safeErrorProperty(error, 'message'));
  if (!decoded) throw error;
  const missingFolder = CoworkFolderMissingSchema.safeParse(
    decoded.coworkFolderMissing,
  );
  if (missingFolder.success) {
    const key = `cowork:${missingFolder.data.workspaceId}\u0000${missingFolder.data.message}`;
    if (key.length <= IPC_APP_ERROR_MAX_KEY_LENGTH) {
      entries.delete(key);
      entries.set(key, {
        coworkFolderMissing: missingFolder.data,
        conflicted: false,
        expiresAt: Date.now() + TTL_MS,
      });
      if (entries.size > MAX_ENTRIES) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }
    }
    throw Object.assign(
      new Error(missingFolder.data.message),
      missingFolder.data,
    );
  }
  const message = formatIpcLegacyError(decoded.channel, decoded.legacy);
  try {
    const previous = liveEntry(message);
    entries.delete(message);
    const shape = decoded.appError;
    const usableShape =
      isRecord(shape) &&
      'code' in shape &&
      typeof shape.code === 'string' &&
      'referenceId' in shape &&
      typeof shape.referenceId === 'string';
    const operationFailure = isRecord(decoded.operationFailure)
      ? decoded.operationFailure
      : undefined;
    if (
      message.length <= IPC_APP_ERROR_MAX_KEY_LENGTH &&
      (usableShape || operationFailure)
    ) {
      const conflicted =
        previous !== undefined &&
        (previous.conflicted ||
          JSON.stringify(previous.operationFailure) !==
            JSON.stringify(operationFailure));
      entries.set(message, {
        ...(usableShape ? { shape } : {}),
        ...(operationFailure && !conflicted ? { operationFailure } : {}),
        conflicted,
        expiresAt: Date.now() + TTL_MS,
      });
      if (entries.size > MAX_ENTRIES) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }
    }
  } catch {
    // Lookup must never replace the restored rejection.
  }
  throw new Error(message);
}
