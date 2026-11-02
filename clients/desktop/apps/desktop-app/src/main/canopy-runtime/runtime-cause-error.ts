import { CanopyOperationError } from '@canopy/core-runtime';

/**
 * Legacy IPC channels and Portal commands surfaced the host error itself. The
 * in-process binding keeps it as the runtime cause, so rethrow it.
 */
export async function preserveRuntimeCauseError<Result>(
  operation: Promise<Result>,
): Promise<Result> {
  try {
    return await operation;
  } catch (error) {
    if (
      error instanceof CanopyOperationError &&
      error.runtimeCause instanceof Error
    )
      throw error.runtimeCause;
    throw error;
  }
}
