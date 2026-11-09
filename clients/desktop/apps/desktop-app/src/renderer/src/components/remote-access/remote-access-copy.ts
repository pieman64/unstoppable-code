/**
 * Copy for the desktop's own Remote Control surfaces (sidebar machine
 * picker, pairing dialogs). The feature is named by `REMOTE_CONTROL_LABEL`
 * everywhere (CAN-5985). The copy and display helpers every host shares
 * live in `@canopy/ui-app/remote-control`.
 */
export const THIS_COMPUTER_LABEL = 'This computer';
export const COMPUTERS_LABEL = 'Computers';

/** The message of a rejected action, for inline error lines. */
export function describeError(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.trim().length > 0) {
    return cause.message;
  }
  return fallback;
}
