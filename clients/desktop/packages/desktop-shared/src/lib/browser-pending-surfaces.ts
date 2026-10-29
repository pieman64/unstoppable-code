import type { BrowserActionError } from '../types/browser';

/**
 * What `browser.handle_dialog` means for a pending file chooser. Chooser ids
 * carry a `chooser-` prefix and JavaScript dialog ids are bare UUIDs, so the
 * id alone tells them apart. An agent can dismiss a chooser, but the files
 * for one come only from `upload_files` (approved and staged) or the user.
 */
export type FileChooserDialogAnswer =
  | { kind: 'not_a_chooser' }
  | { kind: 'dismiss'; chooserId: string }
  | { kind: 'refuse'; error: BrowserActionError };

export const FILE_CHOOSER_ID_PREFIX = 'chooser-';

export function fileChooserDialogAnswer(
  dialogId: string,
  accept: boolean,
): FileChooserDialogAnswer {
  if (!dialogId.startsWith(FILE_CHOOSER_ID_PREFIX))
    return { kind: 'not_a_chooser' };
  if (!accept) return { kind: 'dismiss', chooserId: dialogId };
  return {
    kind: 'refuse',
    error: {
      code: 'unsupported_control',
      message:
        'Answer a file chooser with browser.upload_files({ chooserId }) or browser.request_files({ chooserId }), or dismiss it with accept: false.',
      retryable: false,
      next: 'browser.upload_files',
    },
  };
}

/** Why `handle_dialog` could not dismiss a chooser: it is no longer pending. */
export const FILE_CHOOSER_NOT_PENDING =
  'That file chooser is no longer pending. Run browser.get_dialog for the current one.';

/**
 * What `browser.handle_dialog` means for a pending print request (`print-`
 * ids): accepting saves the page as a PDF task file, as the banner's **Save
 * as PDF** does. The native print dialog is the user's alone.
 */
export type PrintRequestDialogAnswer =
  | { kind: 'not_a_print_request' }
  | { kind: 'answer'; printRequestId: string; answer: 'save_pdf' | 'dismiss' };

export const PRINT_REQUEST_ID_PREFIX = 'print-';

export function printRequestDialogAnswer(
  dialogId: string,
  accept: boolean,
): PrintRequestDialogAnswer {
  if (!dialogId.startsWith(PRINT_REQUEST_ID_PREFIX))
    return { kind: 'not_a_print_request' };
  return {
    kind: 'answer',
    printRequestId: dialogId,
    answer: accept ? 'save_pdf' : 'dismiss',
  };
}

/** Why `handle_dialog` could not answer a print request: it is no longer pending. */
export const PRINT_REQUEST_NOT_PENDING =
  'That print request is no longer pending. Run browser.get_dialog for the current one.';

/**
 * What `browser.handle_dialog` means for a pending sign-in (`auth-` ids):
 * credentials come only from the user, through the app's credentials
 * dialog, so an agent can cancel the sign-in but never accept it.
 */
export type AuthRequestDialogAnswer =
  | { kind: 'not_an_auth_request' }
  | { kind: 'cancel'; authRequestId: string }
  | { kind: 'refuse'; error: BrowserActionError };

export const AUTH_REQUEST_ID_PREFIX = 'auth-';

export function authRequestDialogAnswer(
  dialogId: string,
  accept: boolean,
): AuthRequestDialogAnswer {
  if (!dialogId.startsWith(AUTH_REQUEST_ID_PREFIX))
    return { kind: 'not_an_auth_request' };
  if (!accept) return { kind: 'cancel', authRequestId: dialogId };
  return {
    kind: 'refuse',
    error: {
      code: 'policy_denied',
      message:
        'Ask the user to sign in: only they can enter credentials, from the browser pane. Cancel the sign-in with accept: false.',
      retryable: false,
    },
  };
}

/** Why `handle_dialog` could not cancel a sign-in: it is no longer pending. */
export const AUTH_REQUEST_NOT_PENDING =
  'That sign-in is no longer pending. Run browser.get_dialog for the current one.';
