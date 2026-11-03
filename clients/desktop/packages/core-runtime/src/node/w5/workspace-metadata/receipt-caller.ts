/**
 * A W5 metadata command's receipt caller for one authenticated principal and
 * its request source (CAN-5522, q-19): never a lease or client instance, so a
 * retry after a lease fence, a restart or a host move replays. The daemon
 * binding and the desktop's registered commands (W7a) both use it.
 */
export function w5DaemonReceiptCaller(
  principalId: string,
  source: string,
): string {
  return `daemon:${principalId}:${source}`;
}
