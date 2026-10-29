/**
 * How long the Add project dialog waits on a clone before handing it to the
 * sidebar's clone progress pill. Short clones finish in the dialog as before;
 * anything slower stops blocking the user.
 */
export const CLONE_HANDOFF_DELAY_MS = 3_000;

/** Resolves once a clone has run long enough to move to the background. */
export function waitForCloneHandoff(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, CLONE_HANDOFF_DELAY_MS);
  });
}
