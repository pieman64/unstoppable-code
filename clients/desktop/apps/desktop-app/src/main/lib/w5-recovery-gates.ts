/**
 * CAN-4498 owns exposure: enable only after a registration release has shipped,
 * in a later release that asks users to quit every app and CLI process.
 * No runtime override: skipping releases cannot prove old clients absent.
 */
export function isW5RecoveryEntryEnabled(): boolean {
  return false;
}

/** W14 must prove pre-#5615 operation names cannot hide two-decision keys. */
export function isW5ReservationReleaseQualified(): boolean {
  return false;
}
