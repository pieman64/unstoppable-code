/** Overwrites key or secret bytes in place once they are no longer needed. */
export function zeroBytes(...buffers: readonly Uint8Array[]): void {
  for (const buffer of buffers) buffer.fill(0);
}
