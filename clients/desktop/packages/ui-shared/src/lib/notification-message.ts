/**
 * How much of a message a notification shows before it is cut short. A longer
 * message is cut at a word-agnostic boundary; the host then offers the whole
 * text in a details view.
 */
export const NOTIFICATION_PREVIEW_CHARS = 240;
export const NOTIFICATION_PREVIEW_LINES = 4;

export interface NotificationMessagePreview {
  readonly text: string;
  readonly truncated: boolean;
}

export interface NotificationMessagePreviewOptions {
  readonly maxLines?: number;
  readonly maxChars?: number;
}

/** A notification's view of a message: whole, or cut short with an ellipsis. */
export function previewNotificationMessage(
  message: string,
  {
    maxLines = NOTIFICATION_PREVIEW_LINES,
    maxChars = NOTIFICATION_PREVIEW_CHARS,
  }: NotificationMessagePreviewOptions = {},
): NotificationMessagePreview {
  const lines = message.split('\n');
  let text =
    lines.length > maxLines ? lines.slice(0, maxLines).join('\n') : message;
  if (text.length > maxChars) {
    text = text.slice(0, maxChars);
  }
  if (text === message) return { text, truncated: false };
  return { text: `${text.trimEnd()}…`, truncated: true };
}

/**
 * A toast shows at most three lines (`ToastStackDescription` clamps it), so
 * its preview stops near that length and the host can offer the rest.
 */
export const TOAST_PREVIEW_CHARS = 120;
export const TOAST_PREVIEW_LINES = 3;

/** A toast's view of a message, cut to fit its three lines. */
export function previewToastMessage(
  message: string,
): NotificationMessagePreview {
  return previewNotificationMessage(message, {
    maxLines: TOAST_PREVIEW_LINES,
    maxChars: TOAST_PREVIEW_CHARS,
  });
}

export interface CommandFailureSummary {
  readonly summary: string;
  /** True when the summary leaves out any line or text of the message. */
  readonly truncated: boolean;
}

const LINE_BREAK = /\r\n|\r|\n/;
const CAUSE_PREFIX = /^(?:error|fatal):\s*/i;

/**
 * A short summary of a failed command's output: its first line plus the last
 * `error:` / `fatal:` line, which usually names the cause. Progress output
 * (git overwrites `Updating files:` lines with bare `\r`) is dropped. The
 * summary is at most two lines and the default preview length.
 */
export function summarizeCommandFailure(
  message: string,
): CommandFailureSummary {
  const lines = message
    .split(LINE_BREAK)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return { summary: '', truncated: false };

  const picked = [lines[0]];
  let causeIndex = -1;
  for (let index = lines.length - 1; index > 0; index -= 1) {
    if (CAUSE_PREFIX.test(lines[index])) {
      causeIndex = index;
      break;
    }
  }
  if (causeIndex > 0) {
    picked.push(lines[causeIndex].replace(CAUSE_PREFIX, ''));
  }

  const preview = previewNotificationMessage(picked.join('\n'), {
    maxLines: 2,
  });
  return {
    summary: preview.text,
    truncated: preview.truncated || picked.length < lines.length,
  };
}
