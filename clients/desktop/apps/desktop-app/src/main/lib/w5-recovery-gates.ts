import { isW5DaemonFlipCompiled } from './w5-flip-gate';

/** CAN-5760: ship after v1.17.0 registration, with quit-all/version-skip guidance. */
export function isW5RecoveryEntryEnabled(): boolean {
  return true;
}

/** Both running entry and retained cold intent require compiled W5 ownership. */
export function isW5RecoveryAvailable(): boolean {
  return isW5RecoveryEntryEnabled() && isW5DaemonFlipCompiled();
}

/** q-20: retain the gate until W14 qualifies historical keys, including pre-#5615. */
export function isW5ReservationReleaseQualified(): boolean {
  return false;
}
