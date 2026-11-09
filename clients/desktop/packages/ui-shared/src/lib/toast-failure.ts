import {
  AppErrorCopySchema,
  createAppError,
  type AppError,
} from '@canopy/protocol/app-errors';

const MAX_TITLE_LENGTH = AppErrorCopySchema.shape.title.maxLength ?? 256;

/**
 * A failure of the person's own work: a script, hook or terminal command that
 * exited nonzero or timed out, or a workflow that finished failed. Nothing here
 * is an app defect, so it has no recording, reference or Report this.
 */
export function ownWorkToastError(title: string): AppError {
  const trimmed = title.trim();
  return createAppError(
    'input.not_accepted',
    trimmed === ''
      ? {}
      : { copy: { title: trimmed.slice(0, MAX_TITLE_LENGTH) } },
  );
}

/**
 * A failure the app cannot yet classify, which may offer Report this until
 * CAN-5118 tells external failures apart. Catalog detail only: command output
 * and failure strings never enter a report.
 */
export function unclassifiedToastError(): AppError {
  return createAppError('app.unexpected');
}
