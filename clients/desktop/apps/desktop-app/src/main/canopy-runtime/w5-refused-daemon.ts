import type { CanopyRuntimeDescriptor } from '@canopy/core-client/node';
import { waitForElectronDaemonRelease } from './electron-daemon-access';

/*
 * TRANSITIONAL (CAN-5543, GB12): what the flip launch does with a live daemon
 * that cannot serve W5: an old one in its idle grace after an update (with no
 * W5 host, or an older W5 build's), an incompatible one, or a peer started
 * without the W5 host.
 *
 * Option A: wait only, bounded. Never kill it, never prompt, and call no
 * operation an older daemon may lack, so a launch from any prior version
 * behaves the same. Every daemon build has the 30 s idle grace (CAN-3767
 * shipped with CAN-3768), and the probe takes no lease, so it exits unless a
 * peer leases it; then the wait ends `peer_held` (`version_skew` for a skewed
 * W5 daemon). Change the policy here only.
 */
export function settleRefusedW5Daemon(
  descriptor: CanopyRuntimeDescriptor,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<void> {
  return waitForElectronDaemonRelease(descriptor, timeoutMs, signal);
}
