/**
 * The re-declare hook between the chat store and this window's interest
 * tracker. Kept free of store imports: the revisioned chat slice calls
 * {@link requestChatInterestRedeclare} after each scope declaration, and the
 * tracker module imports the chat store, so a direct import would be a cycle.
 */

let redeclareHandler: (() => void) | null = null;

/** Installs the running tracker's re-declare; returns its remover. */
export function setChatInterestRedeclareHandler(
  handler: () => void,
): () => void {
  redeclareHandler = handler;
  return (): void => {
    if (redeclareHandler === handler) redeclareHandler = null;
  };
}

/**
 * Declare this window's interest again on the next frame, even when it is
 * unchanged. A no-op before tracking starts.
 */
export function requestChatInterestRedeclare(): void {
  redeclareHandler?.();
}
